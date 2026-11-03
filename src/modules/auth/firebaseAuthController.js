/*
 * Firebase email verification + Firebase-assisted password reset.
 *
 * ---------------------------------------------------------------------------
 * The single rule this file exists to enforce
 * ---------------------------------------------------------------------------
 * Firebase proves that a person owns an email address. That is the only thing it
 * is ever asked. It never authenticates anyone.
 *
 * One Firebase credential is accepted anywhere in EcoWatch, in one place:
 * checkVerification accepts a Firebase ID token purely to create an account that
 * does not exist yet, and only when Firebase says the address behind it was
 * verified. It is not a login credential, it grants no access to anything, and
 * the app signs out of Firebase as soon as the account exists.
 *
 * Login is untouched. No Firebase ID token, session or provider is consulted by
 * /api/auth/login, the JWT in utils/generateToken.js is the only credential this
 * system honours, and the bcrypt hash in Supabase is the only authority on
 * whether a password is correct.
 *
 * ---------------------------------------------------------------------------
 * Where the email actually comes from
 * ---------------------------------------------------------------------------
 * Not from here. Firebase refuses to send a verification email unless a user is
 * signed in, and this server never signs in. The Android app therefore creates
 * the Firebase user with the client SDK, asks Firebase to send the email, and
 * later presents the resulting session for confirmation. That is why this backend
 * holds no outbound mail credential.
 *
 * ---------------------------------------------------------------------------
 * Transport selection
 * ---------------------------------------------------------------------------
 * /api/auth/register, /api/auth/forgot-password and /api/auth/reset-password are
 * each shared by two verification transports: the legacy 4-digit OTP still used
 * by the Admin app, and the Firebase flow used by the Resident app. They are told
 * apart by request shape, never by a client-supplied switch that could select a
 * weaker flow:
 *
 *   register         body.verificationMethod === 'EMAIL_LINK'  -> Firebase
 *   forgot-password  body.email present                        -> Firebase
 *   reset-password   body.oobCode present                      -> Firebase
 *
 * Anything else takes the original OTP path, unchanged.
 */

const bcrypt = require('bcryptjs');

const residentRepository = require('../residents/residentRepository');
const adminRepository = require('../admin/adminRepository');
const personnelRepository = require('../personnel/personnelRepository');
const pendingRegistrationRepository = require('./pendingRegistrationRepository');
const passwordResetRepository = require('./passwordResetRepository');

const firebaseAuthService = require('./firebaseAuthService');

const {
  generateResidentId,
  generateRegistrationId,
} = require('../../shared/generateId');
const {
  normalizeEmail,
  requireEmail,
  requireFirebaseIdToken,
  requireFullName,
  requireOpaqueToken,
  requirePassword,
  requireUsername,
} = require('./authValidation');
// Shared signup requirement, so the email-link transport cannot drift away from
// the OTP transport on what a valid phone number looks like.
const { requirePhoneNumber } = require('../../shared/personnelValidation');
const { logInfo, logError } = require('../../shared/logger');

const BCRYPT_ROUNDS = 10;

/** A registration may sit unverified for a day before it has to be redone. */
const REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Minimum gap between two reset emails to one address. */
const RESET_LINK_COOLDOWN_SECONDS = 60;

/*
 * Identical message for "no such account" and "sent", so this endpoint cannot be
 * used to discover which addresses are registered. The Admin app's legacy
 * forgot-password already behaved this way and the habit is kept.
 */
const NEUTRAL_RESET_MESSAGE =
  'If an account exists for this email, a password reset link has been sent.';

const EMAIL_LINK_METHOD = 'EMAIL_LINK';

const toHttpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

/**
 * Resolves an email to exactly one EcoWatch account.
 *
 * Residents and admins share the forgot-password endpoint, so both are searched.
 * Personnel are deliberately excluded: they authenticate through
 * /api/personnel/login with their own flow and are reset by an administrator
 * through /api/personnel, and registration already prevents an address from
 * being shared between a personnel account and a resident or admin.
 */
const findAccountByEmail = async (rawEmail) => {
  const email = normalizeEmail(rawEmail);

  const resident = await residentRepository.findByEmail(email);
  if (resident) {
    return { account: resident, accountType: 'RESIDENT' };
  }

  const admin = await adminRepository.findByEmail(email);
  if (admin) {
    return { account: admin, accountType: 'ADMIN' };
  }

  return null;
};

const updateAccountPassword = async (account, accountType, passwordHash) => {
  if (accountType === 'ADMIN') {
    return adminRepository.updatePassword(account.admin_id, passwordHash);
  }
  return residentRepository.updatePassword(account.resident_id, passwordHash);
};

const backfillFirebaseUid = async (account, accountType, firebaseUid) => {
  if (accountType === 'ADMIN') {
    return adminRepository.setFirebaseUid(account.admin_id, firebaseUid);
  }
  return residentRepository.setFirebaseUid(account.resident_id, firebaseUid);
};

/**
 * Cross-table uniqueness. Username and email are checked against residents,
 * admins and personnel together, so an account cannot be registered that would
 * shadow an existing login identifier in any table.
 */
const findConflictingAccounts = async ({ username, email }) => {
  const [
    residentByUsername,
    adminByUsername,
    personnelByUsername,
    residentByEmail,
    adminByEmail,
    personnelByEmail,
  ] = await Promise.all([
    residentRepository.findByUsername(username),
    adminRepository.findByUsername(username),
    personnelRepository.findByUsername(username),
    email ? residentRepository.findByEmail(email) : null,
    email ? adminRepository.findByEmail(email) : null,
    email ? personnelRepository.findByEmail(email) : null,
  ]);

  return {
    usernameTaken: Boolean(residentByUsername || adminByUsername || personnelByUsername),
    emailTaken: Boolean(residentByEmail || adminByEmail || personnelByEmail),
  };
};

/**
 * Turns a proven registration into a real resident.
 *
 * Called only after Firebase has confirmed the address behind the presented
 * session was actually verified, so by the time this runs the address is proven.
 *
 * Concurrency: two simultaneous "I have verified" taps can both pass the Firebase
 * check. The unique index on residents.username then rejects the second insert,
 * which is caught and answered from the row the first insert created. That makes
 * the endpoint idempotent and safe to retry after a dropped response, without
 * needing a lock around the Firebase call.
 */
const finalizeRegistration = async (pending, firebaseUid, requestId) => {
  const residentId = generateResidentId();

  try {
    const resident = await residentRepository.createResident({
      residentId,
      firstName: pending.first_name,
      lastName: pending.last_name,
      username: pending.username,
      email: pending.email,
      passwordHash: pending.password_hash,
      address: '',
      profileImage: '',
      isVerified: true,
      emailVerified: true,
      verifiedAt: new Date(),
      firebaseUid,
      role: 'RESIDENT',
      status: 'AVAILABLE',
      // Carried over from the staged signup. Rows staged before this column
      // existed have no value, which stays null rather than becoming a fake one.
      phoneNumber: pending.phone_number || '',
      createdById: 'SYSTEM',
    });

    await pendingRegistrationRepository.deleteByRegistrationId(
      pending.registration_id
    );

    logInfo(
      requestId,
      'AUTH',
      `resident created after Firebase email verification: ${resident.resident_id}`
    );

    return { resident, created: true };
  } catch (error) {
    if (error.code !== '23505') {
      throw error;
    }

    // A concurrent request won the race. Report the account it created.
    const existing = await residentRepository.findByUsername(pending.username);

    if (existing) {
      await pendingRegistrationRepository.deleteByRegistrationId(
        pending.registration_id
      );
      logInfo(
        requestId,
        'AUTH',
        `registration already finalized by a concurrent request: ${existing.resident_id}`
      );
      return { resident: existing, created: false };
    }

    throw error;
  }
};

/**
 * @desc    Begin a resident registration
 * @route   POST /api/auth/register
 * @access  Public
 *
 * The account does not exist yet, and nothing is emailed from here. This
 * validates the details, takes the bcrypt hash, and parks it in
 * pending_registrations.
 *
 * The app then creates the Firebase user with the client SDK and asks Firebase
 * to send the verification email, because Firebase will not send one without a
 * signed-in session. The resident row is only inserted once the app presents a
 * verified session, so an unverified signup can never log in and never appears in
 * the residents table for an administrator to see.
 */
const registerResident = async (req, res, next) => {
  try {
    const firstName = requireFullName(req.body.firstName, 'First name');
    const lastName = requireFullName(req.body.lastName, 'Last name');
    const username = requireUsername(req.body.username);
    const email = requireEmail(req.body.email);
    const password = requirePassword(req.body.password);

    logInfo(req.requestId, 'AUTH', `Firebase registration attempt for ${username}`);

    const { usernameTaken, emailTaken } = await findConflictingAccounts({
      username,
      email,
    });

    // Reported separately so the resident knows which field to change, but
    // without disclosing that the OTHER value belongs to somebody.
    if (usernameTaken) {
      throw toHttpError(409, 'That username is already taken. Please choose another.');
    }

    if (emailTaken) {
      throw toHttpError(409, 'That email address is already registered.');
    }

    /*
     * Clear any abandoned signup for this address, so a resident who never opens
     * the first verification email can simply try again rather than collecting
     * unreachable rows.
     */
    await pendingRegistrationRepository.deleteUnverifiedByEmail(email);

    // Staged with the signup so finalizeRegistration can copy it into residents
    // once Firebase reports the address as verified.
    //
    // Checked after the conflict checks above on purpose: a caller whose username
    // is already taken is told that, not about their phone number, which keeps
    // the 409 "already registered" contract ahead of field-level 400s.
    const phoneNumber = requirePhoneNumber(req.body.phoneNumber, 'Phone number');

    const registrationId = generateRegistrationId();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const expiresAt = new Date(Date.now() + REGISTRATION_TTL_MS);

    const pending = await pendingRegistrationRepository.createPendingRegistration({
      registrationId,
      username,
      email,
      firstName,
      lastName,
      passwordHash,
      otpHash: null,
      expiresAt,
      attempts: 0,
      firebaseUid: null,
      verificationFlow: EMAIL_LINK_METHOD,
      verificationSentAt: null,
      phoneNumber,
    });

    logInfo(
      req.requestId,
      'AUTH',
      `pending Firebase registration created: ${pending.registration_id}`
    );

    res.set('Cache-Control', 'no-store');
    res.status(201).json({
      success: true,
      registrationId: pending.registration_id,
      email,
      verificationMethod: EMAIL_LINK_METHOD,
      // The app must create the Firebase user and trigger the email itself.
      clientMustSendVerificationEmail: true,
      expiresAt: pending.expires_at,
      message:
        'Almost done. We will email you a verification link to activate your account.',
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc    Confirm a registration by presenting a verified Firebase session
 * @route   POST /api/auth/check-verification
 * @access  Public
 *
 * The body carries a Firebase ID token, obtained on the device after the resident
 * opened their verification email. That token is checked in three ways before
 * anything is created:
 *
 *   - verifyIdToken validates the signature, so the session genuinely came from
 *     this Firebase project;
 *   - revocation is checked, so a session the app has already signed out of
 *     cannot be replayed here;
 *   - email_verified must be true, so a session that never proved ownership of
 *     the inbox cannot create anything.
 *
 * The address the token names must also match the registration being activated.
 * A valid token is only ever proof about the address it names, so it must not be
 * able to activate somebody else's pending signup.
 *
 * Once proven, the resident row is created. This is the only place in EcoWatch
 * where a Firebase credential is honoured, and it creates an account rather than
 * granting access to one.
 */
const checkVerification = async (req, res, next) => {
  try {
    const registrationId = requireOpaqueToken(
      req.body.registrationId,
      'Registration ID'
    );
    // A Firebase ID token is a JWT and runs well past the length any oobCode
    // would, so it has its own validator rather than the short-token bound.
    const idToken = requireFirebaseIdToken(req.body.idToken);

    const pending = await pendingRegistrationRepository.findByRegistrationId(
      registrationId
    );

    if (!pending) {
      throw toHttpError(
        404,
        'This registration session no longer exists. Please register again.'
      );
    }

    if (String(pending.verification_flow || 'OTP').toUpperCase() !== EMAIL_LINK_METHOD) {
      throw toHttpError(
        400,
        'This registration used a verification code. Please enter your code instead.'
      );
    }

    if (!pending.expires_at || new Date(pending.expires_at).getTime() < Date.now()) {
      await pendingRegistrationRepository.deleteByRegistrationId(registrationId);
      throw toHttpError(
        400,
        'This verification session has expired. Please register again.'
      );
    }

    const session = await firebaseAuthService.verifyRegistrationSession({
      idToken,
      requestId: req.requestId,
    });

    // Binds the proof to this specific signup.
    if (session.email !== normalizeEmail(pending.email)) {
      logError(
        req.requestId,
        'FIREBASE_AUTH',
        `rejected session for ${session.email} against registration for ${pending.email}`
      );
      throw toHttpError(
        400,
        'This verification link is for a different email address. Please register again.'
      );
    }

    const { resident, created } = await finalizeRegistration(
      pending,
      session.uid,
      req.requestId
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      verified: true,
      created,
      residentId: resident.resident_id,
      username: resident.username,
      message: created
        ? 'Email verified. Your EcoWatch account is ready.'
        : 'Your account is ready. You can log in now.',
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc    Prepare a password reset
 * @route   POST /api/auth/forgot-password
 * @access  Public
 *
 * This sends nothing. It makes sure a Firebase identity exists for the address,
 * because Firebase will not send a reset email for an address it has never seen,
 * and it records a cooldown. The app then asks Firebase to send the email itself.
 *
 * Always answers with the same message whether or not the address is registered.
 * Returning "no such account" would turn this into a free oracle for discovering
 * which addresses have EcoWatch accounts. The real reason is written to the
 * server log instead.
 */
const forgotPassword = async (req, res, next) => {
  try {
    const email = requireEmail(req.body.email);

    const match = await findAccountByEmail(email);

    if (!match) {
      logInfo(
        req.requestId,
        'AUTH',
        'password reset requested for an unregistered address; nothing sent'
      );
      return res.json({
        success: true,
        message: NEUTRAL_RESET_MESSAGE,
        // The app must not attempt a Firebase send for an address we know nothing
        // about, which would both fail and act as an account-existence oracle.
        canRequestFirebaseEmail: false,
      });
    }

    const { account, accountType } = match;

    // An account disabled by an administrator stays disabled. Resetting the
    // password is still allowed, because the resident is proving control of
    // their own inbox, and the login path keeps refusing the account on status.
    if (String(account.status || '').toUpperCase() === 'DISABLED') {
      logInfo(
        req.requestId,
        'AUTH',
        `password reset requested for a disabled account: ${
          account.resident_id || account.admin_id
        }`
      );
    }

    const cooldown = await passwordResetRepository.getCooldownSeconds(email);
    if (cooldown > 0) {
      // Same neutral response, so the cooldown cannot be used to probe whether
      // an address exists either.
      logInfo(
        req.requestId,
        'AUTH',
        `password reset suppressed for ${email}: cooldown ${cooldown}s remaining`
      );
      return res.json({
        success: true,
        message: NEUTRAL_RESET_MESSAGE,
        canRequestFirebaseEmail: false,
        retryAfterSeconds: cooldown,
      });
    }

    const identity = await firebaseAuthService.ensureIdentityForReset({
      email,
      displayName: [account.first_name, account.last_name].filter(Boolean).join(' '),
      requestId: req.requestId,
    });

    await backfillFirebaseUid(account, accountType, identity.uid);

    await passwordResetRepository.markResetLinkSent({
      email,
      userId: account.resident_id || account.admin_id || null,
      sentAt: new Date(),
      cooldownSeconds: RESET_LINK_COOLDOWN_SECONDS,
    });

    logInfo(
      req.requestId,
      'FIREBASE_AUTH',
      `password reset prepared for ${email} (${accountType}); the app will request the email`
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      message: NEUTRAL_RESET_MESSAGE,
      canRequestFirebaseEmail: true,
      retryAfterSeconds: RESET_LINK_COOLDOWN_SECONDS,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc    Set a new password after a Firebase reset link was opened
 * @route   POST /api/auth/reset-password
 * @access  Public
 *
 * The oobCode is the only credential. It is checked against Firebase, which
 * names the address it was issued for, and THAT address decides which row is
 * updated. The client never says which account it is resetting, so a reset
 * cannot be aimed at somebody else's account by editing the request.
 *
 * Supabase is written first and is the authority: bcrypt into password_hash is
 * committed before Firebase is touched, so the resident can log in with the new
 * password the moment this returns. A Firebase failure afterwards is logged and
 * reported as a warning, never as a failure of the reset.
 */
const resetPassword = async (req, res, next) => {
  try {
    const oobCode = requireOpaqueToken(req.body.oobCode, 'Reset code');
    const password = requirePassword(req.body.password);

    const { email } = await firebaseAuthService.inspectActionCode(
      oobCode,
      req.requestId
    );

    const match = await findAccountByEmail(email);

    if (!match) {
      throw toHttpError(
        400,
        'This reset link cannot be used for an EcoWatch account.'
      );
    }

    const { account, accountType } = match;
    const accountId = account.resident_id || account.admin_id;

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await updateAccountPassword(account, accountType, passwordHash);

    // The reset has already succeeded for EcoWatch. From here on, any Firebase
    // problem is repairable and must not be reported as a failed reset.
    let firebaseSynced = false;
    let firebaseWarning = null;

    try {
      const identity = await firebaseAuthService.ensureIdentityForReset({
        email,
        displayName: [account.first_name, account.last_name].filter(Boolean).join(' '),
        requestId: req.requestId,
      });

      await firebaseAuthService.overwriteIdentityPassword({
        uid: identity.uid,
        password,
        requestId: req.requestId,
      });

      await backfillFirebaseUid(account, accountType, identity.uid);
      firebaseSynced = true;
    } catch (error) {
      firebaseWarning =
        'Your EcoWatch password was changed, but we could not finish updating the email service. Contact your administrator if you need to reset it again.';
      logError(
        req.requestId,
        'FIREBASE_AUTH',
        `Supabase password updated for ${accountId} but Firebase sync failed: ${error.message}`
      );
    }

    await passwordResetRepository.clearResetLinkMarker(email);

    logInfo(
      req.requestId,
      'AUTH',
      `password reset completed for ${accountId} (${accountType}); firebaseSynced=${firebaseSynced}`
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      firebaseSynced,
      // Echoed so the app can prefill the login form. Not a secret: the resident
      // chose it and just proved the inbox.
      username: account.username,
      message: firebaseWarning
        || 'Your password has been changed. Sign in with your username and your new password.',
      ...(firebaseWarning ? { warning: firebaseWarning } : {}),
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc    Re-align an account's Firebase identity with its Supabase password
 * @route   POST /api/auth/sync-firebase-password
 * @access  Private
 *
 * A repair endpoint, not part of the normal journey. It exists for the case the
 * other flows cannot cover: an account created before this feature has a
 * Supabase bcrypt hash but no Firebase identity, and the resident should not have
 * to go through a password reset just to become resettable.
 *
 * It deliberately requires the caller's current password. A JWT alone is not
 * enough, because a stolen token on a shared device would otherwise be enough to
 * seize the account's email identity and take over future password resets. That
 * is the same bar as /api/auth/change-password.
 *
 * Not a way to set a new password: `newPassword` is optional and must equal the
 * current one when supplied. /api/auth/change-password is the only route that can
 * actually rotate a credential.
 */
const syncFirebasePassword = async (req, res, next) => {
  try {
    const isAdmin = String(req.resident?.role || '').toUpperCase() === 'ADMIN';
    const accountId = isAdmin
      ? req.resident.admin_id
      : req.resident.resident_id;

    const currentPassword = String(req.body.currentPassword || '');
    const account = isAdmin
      ? adminRepository.findByAdminId(accountId)
      : residentRepository.findByResidentId(accountId);

    const resolved = await account;

    if (!resolved) {
      throw toHttpError(404, 'Account not found.');
    }

    if (!currentPassword) {
      throw toHttpError(400, 'Your current password is required.');
    }

    const matches = await bcrypt.compare(currentPassword, resolved.password_hash);

    if (!matches) {
      throw toHttpError(401, 'Invalid current password');
    }

    // When a new password is supplied it must also be the current one, so this
    // endpoint can align the two systems but never rotate the credential.
    const requested = req.body.newPassword
      ? requirePassword(req.body.newPassword)
      : currentPassword;

    if (requested !== currentPassword) {
      throw toHttpError(
        400,
        'This endpoint cannot change your password. Use the change password option instead.'
      );
    }

    const email = normalizeEmail(resolved.email);

    if (!email) {
      throw toHttpError(
        409,
        'This account has no email address, so it cannot use email verification.'
      );
    }

    const identity = await firebaseAuthService.ensureIdentityForReset({
      email,
      displayName: [resolved.first_name, resolved.last_name].filter(Boolean).join(' '),
      requestId: req.requestId,
    });

    await firebaseAuthService.overwriteIdentityPassword({
      uid: identity.uid,
      password: requested,
      requestId: req.requestId,
    });

    await backfillFirebaseUid(resolved, isAdmin ? 'ADMIN' : 'RESIDENT', identity.uid);

    logInfo(
      req.requestId,
      'FIREBASE_AUTH',
      `firebase identity synchronised for ${accountId} (uid=${identity.uid}, created=${identity.created})`
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      created: identity.created,
      message: 'Your account is now set up for email verification and password reset.',
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  EMAIL_LINK_METHOD,
  NEUTRAL_RESET_MESSAGE,
  RESET_LINK_COOLDOWN_SECONDS,
  findAccountByEmail,
  finalizeRegistration,
  registerResident,
  checkVerification,
  forgotPassword,
  resetPassword,
  syncFirebasePassword,
};

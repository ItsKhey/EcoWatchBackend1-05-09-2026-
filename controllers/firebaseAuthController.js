/*
 * Firebase email verification + Firebase-assisted password reset.
 *
 * ---------------------------------------------------------------------------
 * The single rule this file exists to enforce
 * ---------------------------------------------------------------------------
 * Firebase proves that a person owns an email address. That is the only thing it
 * is ever asked. It never authenticates anyone.
 *
 * Concretely, none of these handlers:
 *   - read a Firebase ID token,
 *   - call signInWith* on the client,
 *   - accept a Firebase session,
 *   - issue a session of any kind, or
 *   - decide whether a login is valid.
 *
 * The only credential EcoWatch honours is the JWT in utils/generateToken.js,
 * and the only authority on whether a password is correct is the bcrypt hash in
 * Supabase. After a reset the resident logs in on the login screen with
 * username + password exactly as before.
 *
 * ---------------------------------------------------------------------------
 * Why a separate controller
 * ---------------------------------------------------------------------------
 * controllers/authController.js is the live login path and is left untouched by
 * this feature apart from three one-line delegations that pick a transport. The
 * Firebase-specific logic lives here so the login controller stays a
 * straight-line read of the login flow.
 *
 * ---------------------------------------------------------------------------
 * Transport selection
 * ---------------------------------------------------------------------------
 * /api/auth/register, /api/auth/forgot-password and /api/auth/reset-password
 * are each shared by two verification transports: the legacy 4-digit OTP still
 * used by the Admin app, and the Firebase email link used by the Resident app.
 * They are told apart by request shape, never by a client-supplied flag, so a
 * client cannot ask for a weaker flow by choosing a different value:
 *
 *   register         body.verificationMethod === 'EMAIL_LINK'  -> Firebase
 *   forgot-password  body.email present                        -> Firebase
 *   reset-password   body.oobCode present                      -> Firebase
 *
 * Anything else takes the original OTP code path, unchanged.
 */

const bcrypt = require('bcryptjs');

const residentRepository = require('../repositories/residentRepository');
const adminRepository = require('../repositories/adminRepository');
const personnelRepository = require('../repositories/personnelRepository');
const pendingRegistrationRepository = require('../repositories/pendingRegistrationRepository');
const passwordResetRepository = require('../repositories/passwordResetRepository');

const firebaseAuthService = require('../services/firebaseAuthService');

const {
  generateResidentId,
  generateRegistrationId,
} = require('../utils/generateId');
const {
  normalizeEmail,
  requireEmail,
  requireFullName,
  requireOpaqueToken,
  requirePassword,
  requireUsername,
} = require('../utils/authValidation');
const { logInfo, logError } = require('../utils/logger');

const BCRYPT_ROUNDS = 10;

/** An email-link registration stays open for a day; the OTP flow used 5 minutes. */
const REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Minimum gap between two verification or reset emails to one address. */
const RESEND_COOLDOWN_SECONDS = 60;

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
 * Residents and admins share the forgot-password endpoints, so both are searched.
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

  const usernameTaken = Boolean(
    residentByUsername || adminByUsername || personnelByUsername
  );
  const emailTaken = Boolean(
    residentByEmail || adminByEmail || personnelByEmail
  );

  return { usernameTaken, emailTaken };
};

/**
 * Turns a verified pending registration into a real resident.
 *
 * Called only after Firebase has reported emailVerified === true for the exact
 * identity stored on the pending row, so by the time this runs the address is
 * already proven.
 *
 * Concurrency: two simultaneous "I verified" taps can both pass the Firebase
 * check. The unique index on residents.username then rejects the second insert,
 * which is caught and answered from the row the first insert created. That makes
 * the endpoint idempotent and safe to retry after a dropped response, without
 * needing a lock around the Firebase call.
 */
const finalizeRegistration = async (pending, requestId) => {
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
      firebaseUid: pending.firebase_uid,
      role: 'RESIDENT',
      status: 'AVAILABLE',
      phoneNumber: '',
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
 * @desc    Register a resident account and send a Firebase verification link
 * @route   POST /api/auth/register
 * @access  Public
 *
 * The account does not exist yet. The password is hashed and held in
 * pending_registrations, and the resident row is only inserted once Firebase
 * confirms the address was opened. An unverified signup can therefore never log
 * in, and never appears in the residents table for an administrator to see.
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
     * Clear any abandoned signup for this address. Without this a resident who
     * never opens the first verification email would be permanently blocked
     * from retrying, because the address already has a pending row.
     */
    await pendingRegistrationRepository.deleteUnverifiedByEmail(email);

    const registrationId = generateRegistrationId();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const sentAt = new Date();
    const expiresAt = new Date(Date.now() + REGISTRATION_TTL_MS);

    /*
     * The Firebase identity is created before the pending row so a Firebase
     * rejection (an address that already exists in the project, for example)
     * never leaves a half-registered signup behind.
     */
    let identity;
    try {
      identity = await firebaseAuthService.createVerificationIdentity({
        email,
        password,
        displayName: `${firstName} ${lastName}`.trim(),
        requestId: req.requestId,
      });
    } catch (error) {
      /*
       * A leftover unverified identity from an earlier abandoned attempt would
       * otherwise make this address permanently unregisterable. Retiring it and
       * retrying once is safe because no Supabase account can reference it: the
       * uid is only ever stored on a pending row.
       */
      if (String(error.firebaseCode || '') !== 'auth/email-already-exists') {
        throw error;
      }

      logInfo(
        req.requestId,
        'FIREBASE_AUTH',
        `retiring stale unverified identity for ${email} and retrying`
      );

      const stale = await firebaseAuthService.findIdentityByEmail(
        email,
        req.requestId
      );

      if (!stale) {
        throw error;
      }

      await firebaseAuthService.deleteUnverifiedIdentity({
        uid: stale.uid,
        email,
        requestId: req.requestId,
      });

      identity = await firebaseAuthService.createVerificationIdentity({
        email,
        password,
        displayName: `${firstName} ${lastName}`.trim(),
        requestId: req.requestId,
      });
    }

    try {
      await firebaseAuthService.sendVerificationLink({
        email,
        username,
        requestId: req.requestId,
      });
    } catch (error) {
      // Nothing durable was written, so the Firebase identity goes too.
      await firebaseAuthService.deleteUnverifiedIdentity({
        uid: identity.uid,
        email,
        requestId: req.requestId,
      }).catch(() => {});

      throw error;
    }

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
      firebaseUid: identity.uid,
      verificationFlow: EMAIL_LINK_METHOD,
      verificationSentAt: sentAt,
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
      verificationRequired: true,
      resendAvailableInSeconds: RESEND_COOLDOWN_SECONDS,
      expiresAt: pending.expires_at,
      message:
        'Almost done. Open the verification link we sent to your email to activate your account.',
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * Seconds still to wait before another link may be issued, or 0 when one may be
 * issued now. Uses the account's own verification_sent_at so the cooldown holds
 * across restarts and across every instance behind the Render load balancer.
 */
const getResendCooldown = (sentAt, now = Date.now()) => {
  if (!sentAt) return 0;

  const sentMs = new Date(sentAt).getTime();
  if (!Number.isFinite(sentMs)) return 0;

  const elapsedSeconds = Math.floor((now - sentMs) / 1000);
  return Math.max(0, RESEND_COOLDOWN_SECONDS - elapsedSeconds);
};

/**
 * @desc    Send (or resend) the Firebase verification link for a registration
 * @route   POST /api/auth/send-verification
 * @route   POST /api/auth/resend-verification
 * @access  Public
 *
 * Both paths are the same operation. The resend variant is the one the app
 * calls; the other exists so a client that wants the very first send has a
 * name for it.
 */
const sendVerification = async (req, res, next) => {
  try {
    const registrationId = requireOpaqueToken(
      req.body.registrationId,
      'Registration ID'
    );

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

    const cooldown = getResendCooldown(pending.verification_sent_at);
    if (cooldown > 0) {
      throw toHttpError(
        429,
        `Please wait ${cooldown} second${cooldown === 1 ? '' : 's'} before requesting another email.`
      );
    }

    // A still-open Firebase link means the address is already proven.
    const { verified } = await firebaseAuthService.isEmailVerified(
      pending.firebase_uid,
      req.requestId
    );

    if (verified) {
      const { resident } = await finalizeRegistration(pending, req.requestId);
      return res.json({
        success: true,
        alreadyVerified: true,
        verified: true,
        residentId: resident.resident_id,
        username: resident.username,
        message: 'Your email is already verified. You can log in now.',
      });
    }

    const sentAt = new Date();
    await firebaseAuthService.sendVerificationLink({
      email: pending.email,
      username: pending.username,
      requestId: req.requestId,
    });

    await pendingRegistrationRepository.touchVerificationSent(
      registrationId,
      sentAt
    );

    logInfo(
      req.requestId,
      'FIREBASE_AUTH',
      `verification link resent for registration=${registrationId}`
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      sent: true,
      resendAvailableInSeconds: RESEND_COOLDOWN_SECONDS,
      message: `We sent a new verification link to ${pending.email}.`,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc    Report whether a registration's email has been verified
 * @route   GET /api/auth/check-verification
 * @access  Public
 *
 * Also finalises the account. Checking is how the app learns the link was
 * opened, and there is no reason to make the resident press a second button
 * once that is true, so the resident row is created on the transition.
 *
 * Safe to call repeatedly and safe to call after a rotation or a process death:
 * once finalised the pending row is gone and the already-created account is
 * reported from residents instead.
 *
 * `email` is required so that the post-finalise case can be answered. It is not
 * a credential: registrationId is a 12-character nanoid and remains the
 * unguessable part of the pair.
 */
const checkVerification = async (req, res, next) => {
  try {
    const registrationId = requireOpaqueToken(
      req.query.registrationId,
      'Registration ID'
    );
    const email = requireEmail(req.query.email, 'Email');

    const pending = await pendingRegistrationRepository.findByRegistrationId(
      registrationId
    );

    if (!pending) {
      // Either already finalised, or never existed. Only a real account can tell.
      const match = await findAccountByEmail(email);

      if (match) {
        return res.json({
          success: true,
          verified: true,
          alreadyFinalized: true,
          residentId:
            match.accountType === 'ADMIN'
              ? match.account.admin_id
              : match.account.resident_id,
          username: match.account.username,
          message: 'Your account is ready. You can log in now.',
        });
      }

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

    const { verified } = await firebaseAuthService.isEmailVerified(
      pending.firebase_uid,
      req.requestId
    );

    if (!verified) {
      res.set('Cache-Control', 'no-store');
      return res.json({
        success: true,
        verified: false,
        email: pending.email,
        canResend: true,
        resendAvailableInSeconds: getResendCooldown(pending.verification_sent_at),
        message: 'We have not seen your email opened yet.',
      });
    }

    const { resident, created } = await finalizeRegistration(pending, req.requestId);

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
 * @desc    Begin a password reset by emailing a Firebase reset link
 * @route   POST /api/auth/forgot-password
 * @access  Public
 *
 * Firebase generates the link; this backend decides who it is for and by the
 * time the link is opened the password it replaces is already proven to belong
 * to the person holding the inbox.
 *
 * Always answers with the same message whether or not the address is
 * registered. Returning "no such account" would turn this into a free oracle for
 * discovering which addresses have EcoWatch accounts, which is a real disclosure
 * of resident data. The real reason is written to the server log instead.
 */
const forgotPassword = async (req, res, next) => {
  try {
    const email = requireEmail(req.body.email);

    const match = await findAccountByEmail(email);

    if (!match) {
      logInfo(
        req.requestId,
        'AUTH',
        `password reset requested for an unregistered address; no link sent`
      );
      return res.json({ success: true, message: NEUTRAL_RESET_MESSAGE });
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
      return res.json({ success: true, message: NEUTRAL_RESET_MESSAGE });
    }

    const identity = await firebaseAuthService.ensureIdentityForReset({
      email,
      displayName: [account.first_name, account.last_name].filter(Boolean).join(' '),
      requestId: req.requestId,
    });

    await backfillFirebaseUid(account, accountType, identity.uid);

    await firebaseAuthService.sendPasswordResetLink({
      email,
      username: account.username,
      requestId: req.requestId,
    });

    await passwordResetRepository.markResetLinkSent({
      email,
      userId: account.resident_id || account.admin_id || null,
      sentAt: new Date(),
      cooldownSeconds: RESEND_COOLDOWN_SECONDS,
    });

    logInfo(
      req.requestId,
      'FIREBASE_AUTH',
      `password reset link issued for ${email} (${accountType})`
    );

    res.set('Cache-Control', 'no-store');
    res.json({ success: true, message: NEUTRAL_RESET_MESSAGE });
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
      const identity = await firebaseAuthService.ensureIdentity({
        email,
        password,
        displayName: [account.first_name, account.last_name].filter(Boolean).join(' '),
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
      // The account's username is echoed so the app can prefill the login form.
      // It is not a secret: the resident chose it and just proved the inbox.
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
 * This is a repair endpoint, not part of the normal journey. It exists for the
 * one case the other flows cannot cover: an account created before this feature
 * has a Supabase bcrypt hash but no Firebase identity, and the resident should
 * not have to go through a password reset just to become resettable.
 *
 * It deliberately requires the caller's current password. A JWT alone is not
 * enough, because a stolen token on a shared device would otherwise be enough
 * to seize the account's email identity and take over future password resets.
 * That is the same bar as /api/auth/change-password.
 *
 * Note this is NOT a way to set a new password. `newPassword` is optional and
 * defaults to the current one; when supplied, the current password must still
 * match. Use /api/auth/change-password to actually rotate a password.
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

    const matches = await bcrypt.compare(
      currentPassword,
      resolved.password_hash
    );

    if (!matches) {
      throw toHttpError(401, 'Invalid current password');
    }

    /*
     * When a new password is supplied it must also be the current one, so this
     * endpoint can align the two systems but never rotate the credential. The
     * rotation endpoints are the only ones allowed to change a password.
     */
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

    const identity = await firebaseAuthService.ensureIdentity({
      email,
      password: requested,
      displayName: [resolved.first_name, resolved.last_name].filter(Boolean).join(' '),
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
  RESEND_COOLDOWN_SECONDS,
  findAccountByEmail,
  finalizeRegistration,
  getResendCooldown,
  registerResident,
  sendVerification,
  checkVerification,
  forgotPassword,
  resetPassword,
  syncFirebasePassword,
};

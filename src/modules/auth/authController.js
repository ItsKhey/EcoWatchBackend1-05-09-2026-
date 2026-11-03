const bcrypt = require('bcryptjs');

const {
  findByIdentifier: findResidentByIdentifier,
  findByResidentId,
  findByUsername: findResidentByUsername,
  findByEmail: findResidentByEmail,
  createResident,
  updateResident,
  updatePassword: updateResidentPassword,
  setFirebaseUid: residentRepositorySetFirebaseUid,
  touchLastActive: touchResidentLastActive,
  pauseResidentAccount,
  restorePausedResidentAccount,
  deleteResidentAccount,
} = require('../residents/residentRepository');

const {
  findByIdentifier: findAdminByIdentifier,
  findByAdminId,
  findByUsername: findAdminByUsername,
  findByEmail: findAdminByEmail,
  updateAdmin,
  touchLastActive,
  updatePassword: updateAdminPassword,
  setFirebaseUid: adminRepositorySetFirebaseUid,
} = require('../admin/adminRepository');

const {
  createPendingRegistration,
  findByRegistrationId,
  incrementAttempts: incrementRegistrationAttempts,
  deleteByRegistrationId,
} = require('./pendingRegistrationRepository');

const {
  createResetOTP,
  findByEmail: findResetByEmail,
  incrementAttempts: incrementResetAttempts,
  deleteByEmail: deleteResetByEmail,
} = require('./passwordResetRepository');

const {
  findByUsername: findPersonnelByUsername,
  findByEmail: findPersonnelByEmail,
} = require('../personnel/personnelRepository');

/*
 * Firebase email verification + password reset. Imported here only to hand off
 * the two shared endpoints to the email-link transport; the OTP transport below
 * stays the default and is unchanged.
 */
const firebaseAuthController = require('./firebaseAuthController');

const firebaseAuthService = require('./firebaseAuthService');

const generateToken = require('../../shared/generateToken');
const { getResidentLoginDecision } = require('../../shared/residentAuth');
const {
  generateResidentId,
  generateRegistrationId,
  generateOTP,
} = require('../../shared/generateId');

const {
  sendVerificationEmail,
  sendPasswordResetEmail,
} = require('./emailServices');

const {
  logInfo,
  logError,
  logProfileRequest,
} = require('../../shared/logger');

const { uploadImage } = require('../../shared/cloudinaryService');

const {
  requireEmail,
  requireFullName,
  requirePassword,
  requireUsername,
} = require('./authValidation');

// Contact details share the admin app's constraints so one bad value cannot be
// stored by one client and rejected by the other.
const {
  normalizePhoneNumber,
  normalizeMessengerLink,
  requirePhoneNumber,
} = require('../../shared/personnelValidation');

/**
 * Whether a new resident account has to prove it owns the email address.
 *
 * False (the default for a local server) creates the account immediately: no
 * OTP, no email, no Firebase. True restores the emailed-code flow, which stages
 * a pending registration and mails a 4-digit code.
 *
 * A client can still choose per request with verificationMethod, so a build
 * pinned to one transport keeps working whichever way this is set.
 */
const REGISTRATION_REQUIRES_VERIFICATION =
  ['1', 'true', 'yes', 'on'].includes(
    String(process.env.REGISTRATION_REQUIRES_VERIFICATION || '').trim().toLowerCase()
  );

const OTP_EXPIRY_MS = 5 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

const hashOtp = async (otp) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(otp, salt);
};

const findUserByIdentifier = async (identifier) => {
  const normalizedIdentifier = identifier?.trim();

  if (!normalizedIdentifier) {
    return null;
  }

  const resident = await findResidentByIdentifier(normalizedIdentifier);

  if (resident) {
    return {
      ...resident,
      accountType: 'RESIDENT',
      residentId: resident.resident_id,
    };
  }

  const admin = await findAdminByIdentifier(normalizedIdentifier);

  if (admin) {
    return {
      ...admin,
      accountType: 'ADMIN',
      residentId: admin.admin_id,
    };
  }

  return null;
};

/**
 * Keeps a Firebase identity in step after a password change made through the
 * logged-in endpoints.
 *
 * Supabase is always committed first and is the authority: login reads the
 * bcrypt hash from Supabase and nothing else. This runs afterwards purely so the
 * email address keeps a usable Firebase identity, which is what allows a future
 * password reset to be emailed at all.
 *
 * It therefore never throws and never fails the request. A resident whose
 * password just changed has succeeded, whether or not Firebase was reachable, and
 * the drift is repairable later through /api/auth/sync-firebase-password.
 */
const syncFirebasePasswordAfterChange = async ({
  user,
  isAdmin,
  newPassword,
  requestId,
}) => {
  try {
    const email = String(user.email || '').trim().toLowerCase();

    if (!email) {
      return;
    }

    const identity = await firebaseAuthService.ensureIdentity({
      email,
      password: newPassword,
      displayName: [user.first_name, user.last_name].filter(Boolean).join(' '),
      requestId,
    });

    if (isAdmin) {
      await adminRepositorySetFirebaseUid(user.admin_id, identity.uid);
    } else {
      await residentRepositorySetFirebaseUid(user.resident_id, identity.uid);
    }

    logInfo(
      requestId,
      'FIREBASE_AUTH',
      `password change synchronised with Firebase for uid=${identity.uid} (created=${identity.created})`
    );
  } catch (error) {
    logError(
      requestId,
      'FIREBASE_AUTH',
      `Supabase password changed but Firebase sync failed: ${error.message}`
    );
  }
};

/**
 * Requires a phone number on a new resident signup.
 *
 * <p>Delegates to the shared validator so the resident and Firebase transports
 * cannot drift apart on what counts as an acceptable signup number.
 */
const requireRegistrationPhoneNumber = (value) =>
  requirePhoneNumber(value, 'Phone number');

const mapResidentResponse = (user) => ({
  residentId: user.resident_id,
  firstName: user.first_name,
  lastName: user.last_name,
  username: user.username,
  email: user.email,
  address: user.address || '',
  profileImage: user.profile_image || '',
  role: user.role || 'RESIDENT',
  status: user.status || 'AVAILABLE',
  // The admin app renders these on a reporter's Contact Information card, so
  // they have to survive every response that carries a resident.
  phoneNumber: user.phone_number || '',
  messengerLink: user.messenger_link || '',
  createdAt: user.created_at || null,
  updatedAt: user.updated_at || null,
  lastActive: user.last_active || user.updated_at || user.created_at || null,
});

const mapAdminResponse = (user) => ({
  adminId: user.admin_id,
  firstName: user.first_name,
  lastName: user.last_name,
  username: user.username,
  email: user.email,
  address: user.address || '',
  profileImage: user.profile_image || '',
  role: user.role || 'ADMIN',
  status: user.status || 'AVAILABLE',
  phoneNumber: user.phone_number || '',
  createdAt: user.created_at || null,
  updatedAt: user.updated_at || null,
  lastActive: user.last_active || user.updated_at || user.created_at || null,
});

const mapLoginResponse = (user, isAdmin = false) => (
  isAdmin
    ? mapAdminResponse(user)
    : {
        residentId: user.resident_id,
        firstName: user.first_name,
        lastName: user.last_name,
        username: user.username,
        email: user.email,
        address: user.address || '',
        profileImage: user.profile_image || '',
        role: user.role,
        status: user.status || 'AVAILABLE',
        phoneNumber: user.phone_number || '',
        messengerLink: user.messenger_link || '',
      }
);

/**
 * Account lifecycle routes are resident-only. An administrator token must never
 * be able to pause or permanently delete an account through these endpoints, so
 * the role is re-checked here even though the route already mounted
 * protectResident.
 */
const requireResidentAccount = (req) => {
  const residentId = req.resident?.resident_id;
  const role = String(req.resident?.role || '').trim().toUpperCase();

  if (!residentId || role !== 'RESIDENT') {
    const error = new Error('Not authorized as a resident.');
    error.statusCode = 403;
    throw error;
  }

  return residentId;
};

const registerResident = async (req, res, next) => {
  const {
    firstName,
    lastName,
    username,
    email,
    password,
  } = req.body;

  /*
   * Transport selection.
   *
   * A client opts into the Firebase email-link flow by naming it explicitly, and
   * into the emailed-code flow by sending verificationMethod=OTP. A request that
   * names neither creates the account immediately, which is what
   * REGISTRATION_REQUIRES_VERIFICATION=false asks for. A client that predates
   * this flag keeps the previous behaviour, so turning verification back on is a
   * .env change and never a client change.
   */
  const requestedMethod = String(req.body.verificationMethod || '')
    .trim()
    .toUpperCase();

  if (requestedMethod === firebaseAuthController.EMAIL_LINK_METHOD) {
    return firebaseAuthController.registerResident(req, res, next);
  }

  if (REGISTRATION_REQUIRES_VERIFICATION && requestedMethod !== 'OTP') {
    // Verification is on but the client did not ask for a transport. The code
    // flow is the historical default for this request, so it is preserved.
    return registerResidentWithOtp(req, res, next);
  }

  if (!REGISTRATION_REQUIRES_VERIFICATION && requestedMethod === 'OTP') {
    return registerResidentWithOtp(req, res, next);
  }

  return registerResidentDirectly(req, res, next);
};

/**
 * Creates the account with no verification step at all.
 *
 * No OTP is generated, no email is sent, and no pending registration row is
 * written: the resident exists on the response, so the client sends them to the
 * login screen.
 *
 * Every field still goes through utils/authValidation.js. The emailed-code path
 * stages the password before it is ever checked, so this is deliberately the
 * stricter of the two about what a password may look like.
 */
const registerResidentDirectly = async (req, res, next) => {
  try {
    const firstNameValue = requireFullName(req.body.firstName, 'First name');
    const lastNameValue = requireFullName(req.body.lastName, 'Last name');
    const usernameValue = requireUsername(req.body.username);
    const emailValue = requireEmail(req.body.email);
    const passwordValue = requirePassword(req.body.password);
    // Required at signup: the admin app shows this number on the reporter's
    // Contact Information card, so an account without one is not usable there.
    const phoneNumberValue = requireRegistrationPhoneNumber(req.body.phoneNumber);

    logInfo(
      req.requestId,
      'AUTH',
      `Direct registration attempt for username: ${usernameValue}`
    );

    const [
      existingResident,
      existingAdmin,
      existingPersonnel,
      residentWithEmail,
      adminWithEmail,
      personnelWithEmail,
    ] = await Promise.all([
      findResidentByUsername(usernameValue),
      findAdminByUsername(usernameValue),
      findPersonnelByUsername(usernameValue),
      findResidentByEmail(emailValue),
      findAdminByEmail(emailValue),
      findPersonnelByEmail(emailValue),
    ]);

    if (
      existingResident ||
      existingAdmin ||
      existingPersonnel ||
      residentWithEmail ||
      adminWithEmail ||
      personnelWithEmail
    ) {
      res.status(409);
      throw new Error('Username or email is already registered');
    }

    const passwordHash = await bcrypt.hash(passwordValue, 10);

    const resident = await createResident({
      residentId: generateResidentId(),
      firstName: firstNameValue,
      lastName: lastNameValue,
      username: usernameValue,
      email: emailValue,
      passwordHash,
      address: '',
      profileImage: '',
      isVerified: true,
      role: 'RESIDENT',
      status: 'AVAILABLE',
      phoneNumber: phoneNumberValue,
      createdById: 'SYSTEM',
    });

    logInfo(
      req.requestId,
      'AUTH',
      `Resident created without verification: ${resident.resident_id}`
    );

    res.status(201).json({
      success: true,
      residentId: resident.resident_id,
      requiresVerification: false,
      message: 'Account created successfully',
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * The historical emailed-code flow: stage a pending registration, mail a
 * 4-digit code through services/emailServices.js, and let verifyOTP create the
 * account. Retained so verification can be switched back on.
 */
const registerResidentWithOtp = async (req, res, next) => {
  const {
    firstName,
    lastName,
    username,
    email,
    password,
  } = req.body;

  try {
    logInfo(
      req.requestId,
      'AUTH',
      `Registration attempt for username: ${username}`
    );

    const [
      existingResident,
      existingAdmin,
      existingPersonnel,
      residentWithEmail,
      adminWithEmail,
      personnelWithEmail,
    ] = await Promise.all([
      findResidentByUsername(username),
      findAdminByUsername(username),
      findPersonnelByUsername(username),
      email ? findResidentByEmail(email) : null,
      email ? findAdminByEmail(email) : null,
      email ? findPersonnelByEmail(email) : null,
    ]);

    if (
      existingResident ||
      existingAdmin ||
      existingPersonnel ||
      residentWithEmail ||
      adminWithEmail ||
      personnelWithEmail
    ) {
      res.status(409);
      throw new Error('Username or email is already registered');
    }

    const otp = generateOTP(4);
    const registrationId = generateRegistrationId();
    const hashedOtp = await hashOtp(otp);
    const passwordHash = await bcrypt.hash(password, 10);

    // Staged alongside the rest of the signup so verifyOTP can copy it into
    // residents when the account is finally created. Checked after the conflict
    // checks so a taken username or email is still reported as a 409.
    const phoneNumberValue = requireRegistrationPhoneNumber(req.body.phoneNumber);

    const pending = await createPendingRegistration({
      registrationId,
      firstName,
      lastName,
      username,
      email,
      passwordHash,
      otpHash: hashedOtp,
      expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
      attempts: 0,
      phoneNumber: phoneNumberValue,
    });

    logInfo(
      req.requestId,
      'AUTH',
      `Pending registration created: ${registrationId}`
    );

    try {
      await sendVerificationEmail(email, otp, req.requestId);
      logInfo(
        req.requestId,
        'EMAIL',
        `Verification OTP sent to ${email}`
      );
    } catch (err) {
      logError(
        req.requestId,
        'EMAIL',
        err.message || 'Verification email send failed'
      );
      await deleteByRegistrationId(registrationId);
      res.status(500);
      throw new Error('Email could not be sent');
    }

    res.status(201).json({
      success: true,
      registrationId: pending.registration_id,
      requiresVerification: true,
      message: 'OTP sent to email',
    });
  } catch (error) {
    return next(error);
  }
};

const verifyOTP = async (req, res, next) => {
  const { registrationId, otp } = req.body;

  try {
    logInfo(
      req.requestId,
      'AUTH',
      `Verification attempt for REG ID: ${registrationId}`
    );

    const pending = await findByRegistrationId(registrationId);

    if (!pending) {
      res.status(404);
      throw new Error('Registration session expired or not found');
    }

    if (
      !pending.expires_at ||
      new Date(pending.expires_at).getTime() < Date.now()
    ) {
      await deleteByRegistrationId(registrationId);
      res.status(400);
      throw new Error('OTP has expired');
    }

    const isMatch = await bcrypt.compare(otp, pending.otp_hash);

    if (!isMatch) {
      const updatedPending =
        await incrementRegistrationAttempts(registrationId);

      if (
        updatedPending &&
        updatedPending.attempts >= MAX_OTP_ATTEMPTS
      ) {
        await deleteByRegistrationId(registrationId);
        res.status(400);
        throw new Error(
          'Too many failed attempts. Please register again.'
        );
      }

      res.status(400);
      throw new Error('Invalid OTP');
    }

    const resident = await createResident({
      residentId: generateResidentId(),
      firstName: pending.first_name,
      lastName: pending.last_name,
      username: pending.username,
      email: pending.email,
      passwordHash: pending.password_hash,
      address: '',
      profileImage: '',
      isVerified: true,
      role: 'RESIDENT',
      status: 'AVAILABLE',
      // Carried over from the staged signup. Rows staged before this column
      // existed have no value, which stays null rather than becoming a fake one.
      phoneNumber: pending.phone_number || '',
      createdById: 'SYSTEM',
    });

    logInfo(
      req.requestId,
      'AUTH',
      `Resident created: ${resident.resident_id}`
    );

    await deleteByRegistrationId(registrationId);

    res.status(201).json({
      success: true,
      residentId: resident.resident_id,
      message: 'Account verified and created successfully',
    });
  } catch (error) {
    return next(error);
  }
};

const forgotPassword = async (req, res, next) => {
  const { username, email } = req.body;

  /*
   * Transport selection. The Firebase flow is addressed by email; the legacy OTP
   * flow is addressed by username and, when both are present, username wins.
   * That ordering is what the original controller already implemented, so this
   * branch cannot change the behaviour of any existing caller.
   */
  if (email && !username) {
    return firebaseAuthController.forgotPassword(req, res, next);
  }

  try {
    if (!username && !email) {
      res.status(400);
      throw new Error('Username or Email is required');
    }

    let user = null;

    if (username) {
      user =
        await findResidentByUsername(username) ||
        await findAdminByUsername(username);
    } else {
      user =
        await findResidentByEmail(email) ||
        await findAdminByEmail(email);
    }

    let targetEmail;

    if (user) {
      targetEmail = user.email;
    } else if (email) {
      targetEmail = email;
    } else {
      res.json({
        success: true,
        message:
          'If an account exists for this username, a reset code has been sent.',
      });
      return;
    }

    const otp = generateOTP(4);
    const otpHash = await hashOtp(otp);

    await deleteResetByEmail(targetEmail);

    const resetEntry = await createResetOTP({
      userId: user
        ? (user.resident_id || user.admin_id || null)
        : null,
      email: targetEmail,
      otpHash,
      expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
      attempts: 0,
    });

    try {
      await sendPasswordResetEmail(targetEmail, otp, req.requestId);
      logInfo(
        req.requestId,
        'EMAIL',
        `Password reset OTP sent to ${targetEmail}`
      );
    } catch (err) {
      logError(
        req.requestId,
        'EMAIL',
        err.message || 'Password reset email send failed'
      );
      await deleteResetByEmail(targetEmail);
      res.status(500);
      throw new Error('Unable to send password reset code');
    }

    res.json({
      success: true,
      message:
        'If an account exists for this email, a reset code has been sent.',
    });
  } catch (error) {
    next(error);
  }
};

const verifyResetOTP = async (req, res, next) => {
  const { email, username, otp } = req.body;

  try {
    if ((!email && !username) || !otp) {
      res.status(400);
      throw new Error('Username/Email and OTP are required');
    }

    let targetEmail = email;

    if (!targetEmail && username) {
      const user = await findUserByIdentifier(username);
      targetEmail = user ? user.email : 'unknown';
    }

    const resetEntry = await findResetByEmail(targetEmail);

    /*
     * A row with no otp_hash is the Firebase flow's rate-limit marker, not an
     * OTP challenge. It is rejected here rather than passed to bcrypt.compare,
     * which would throw on a null hash and surface as a 500 instead of a 400.
     */
    if (!resetEntry || !resetEntry.otp_hash) {
      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    if (
      !resetEntry.expires_at ||
      new Date(resetEntry.expires_at).getTime() < Date.now()
    ) {
      await deleteResetByEmail(targetEmail);
      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    const isMatch = await bcrypt.compare(otp, resetEntry.otp_hash);

    if (!isMatch) {
      const updatedEntry =
        await incrementResetAttempts(targetEmail);

      if (
        updatedEntry &&
        updatedEntry.attempts >= MAX_OTP_ATTEMPTS
      ) {
        await deleteResetByEmail(targetEmail);
        res.status(400);
        throw new Error(
          'Too many failed attempts. Please request a new reset code.'
        );
      }

      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    res.json({
      success: true,
      message: 'OTP verified successfully',
    });
  } catch (error) {
    next(error);
  }
};

const resetPassword = async (req, res, next) => {
  const {
    email,
    username,
    otp,
    password,
  } = req.body;

  /*
   * Transport selection. The Firebase flow presents an oobCode from the emailed
   * link; the legacy flow presents an OTP. The two can never be confused because
   * neither field is accepted by the other branch.
   */
  if (req.body.oobCode) {
    return firebaseAuthController.resetPassword(req, res, next);
  }

  try {
    if ((!email && !username) || !otp || !password) {
      res.status(400);
      throw new Error(
        'Username/Email, OTP, and password are required'
      );
    }

    let targetEmail = email;

    if (!targetEmail && username) {
      const user =
        await findResidentByUsername(username) ||
        await findAdminByUsername(username);
      targetEmail = user ? user.email : 'unknown';
    }

    const resetEntry = await findResetByEmail(targetEmail);

    /*
     * A row with no otp_hash is the Firebase flow's rate-limit marker, not an
     * OTP challenge. It is rejected here rather than passed to bcrypt.compare,
     * which would throw on a null hash and surface as a 500 instead of a 400.
     */
    if (!resetEntry || !resetEntry.otp_hash) {
      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    if (
      !resetEntry.expires_at ||
      new Date(resetEntry.expires_at).getTime() < Date.now()
    ) {
      await deleteResetByEmail(targetEmail);
      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    const isMatch = await bcrypt.compare(otp, resetEntry.otp_hash);

    if (!isMatch) {
      const updatedEntry =
        await incrementResetAttempts(targetEmail);

      if (
        updatedEntry &&
        updatedEntry.attempts >= MAX_OTP_ATTEMPTS
      ) {
        await deleteResetByEmail(targetEmail);
        res.status(400);
        throw new Error(
          'Too many failed attempts. Please request a new reset code.'
        );
      }

      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    let user = null;
    let accountType = null;

    if (email) {
      const resident = await findResidentByEmail(email);

      if (resident) {
        user = resident;
        accountType = 'RESIDENT';
      } else {
        const admin = await findAdminByEmail(email);

        if (admin) {
          user = admin;
          accountType = 'ADMIN';
        }
      }
    } else if (username) {
      const resident = await findResidentByUsername(username);

      if (resident) {
        user = resident;
        accountType = 'RESIDENT';
      } else {
        const admin = await findAdminByUsername(username);

        if (admin) {
          user = admin;
          accountType = 'ADMIN';
        }
      }
    }

    if (!user) {
      await deleteResetByEmail(targetEmail);
      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    const passwordHash = await bcrypt.hash(password, 10);

    if (accountType === 'ADMIN') {
      await updateAdminPassword(user.admin_id, passwordHash);
    } else {
      await updateResidentPassword(user.resident_id, passwordHash);
    }

    await deleteResetByEmail(targetEmail);

    res.json({
      success: true,
      message: 'Password reset successfully',
    });
  } catch (error) {
    next(error);
  }
};

const changePassword = async (req, res, next) => {
  const { oldPassword, newPassword } = req.body;

  try {
    const isAdmin = String(req.resident.role || '').toUpperCase() === 'ADMIN';

    const user = isAdmin
      ? await findByAdminId(req.resident.admin_id)
      : await findByResidentId(req.resident.resident_id);

    if (
      user &&
      await bcrypt.compare(oldPassword, user.password_hash)
    ) {
      const passwordHash = await bcrypt.hash(newPassword, 10);

      if (isAdmin) {
        await updateAdminPassword(user.admin_id, passwordHash);
      } else {
        await updateResidentPassword(user.resident_id, passwordHash);
      }

      // Supabase is committed; keep the Firebase identity in step, best effort.
      await syncFirebasePasswordAfterChange({
        user,
        isAdmin,
        newPassword,
        requestId: req.requestId,
      });

      res.json({
        success: true,
        message: 'Password updated successfully',
      });
    } else {
      res.status(401);
      throw new Error('Invalid current password');
    }
  } catch (error) {
    next(error);
  }
};

const loginResident = async (req, res, next) => {
  const { username, password } = req.body;

  try {
    const identifier = username?.trim();

    logInfo(
      req.requestId,
      'AUTH',
      `Login attempt for username: ${identifier}`
    );

    const admin = await findAdminByIdentifier(identifier);

    if (
      admin &&
      await bcrypt.compare(password, admin.password_hash)
    ) {
      let lastActive = admin.last_active || null;
      try {
        lastActive = await touchLastActive(admin.admin_id) || lastActive;
      } catch (activityError) {
        console.warn(`[AUTH] Unable to update admin activity: ${activityError.message}`);
      }

      const adminResponse = mapAdminResponse({
        ...admin,
        last_active: lastActive || admin.updated_at || admin.created_at || null,
      });
      res.json({
        success: true,
        token: generateToken(admin.admin_id, {
          role: 'ADMIN',
          admin_id: admin.admin_id,
        }),
        admin: adminResponse,
        // Compatibility only. New admin clients use the canonical admin
        // object and never read this legacy resident-shaped alias.
        resident: {
          ...adminResponse,
          residentId: admin.admin_id,
        },
      });

      logInfo(
        req.requestId,
        'AUTH',
        `Admin login successful: ${admin.admin_id}`
      );

      return;
    }

    if (admin) {
      logInfo(
        req.requestId,
        'AUTH',
        `Admin login failed: invalid password for ${identifier}`
      );
    }

    const resident = await findResidentByIdentifier(identifier);

    /*
     * The pause/restore rule lives in getResidentLoginDecision so it stays in
     * one testable place and this controller remains a straight-line read of
     * the login flow.
     */
    const passwordMatches = Boolean(
      resident && await bcrypt.compare(password, resident.password_hash)
    );
    const decision = getResidentLoginDecision(resident, passwordMatches);

    if (decision.allowed) {
      let activeResident = resident;

      if (decision.mustRestore) {
        activeResident = await restorePausedResidentAccount(resident.resident_id);

        if (!activeResident) {
          res.status(403);
          throw new Error(
            'This account is disabled. Please contact your EcoWatch administrator.'
          );
        }

        logInfo(
          req.requestId,
          'AUTH',
          `Self-paused account restored on login: ${activeResident.resident_id}`
        );
      }

      let lastActive = activeResident.last_active || null;
      try {
        lastActive = await touchResidentLastActive(activeResident.resident_id) || lastActive;
      } catch (activityError) {
        // Activity telemetry must not prevent a valid resident login.
        console.warn(`[AUTH] Unable to update resident activity: ${activityError.message}`);
      }

      res.json({
        success: true,
        token: generateToken(activeResident.resident_id),
        resident: {
          ...mapLoginResponse(activeResident, false),
          lastActive: lastActive || activeResident.updated_at || activeResident.created_at || null,
        },
      });

      logInfo(
        req.requestId,
        'AUTH',
        `Login successful: ${activeResident.resident_id} (${activeResident.role})`
      );

      return;
    }

    if (decision.reason === 'account_disabled') {
      logInfo(
        req.requestId,
        'AUTH',
        `Login blocked: account is disabled for ${identifier}`
      );

      res.status(403);
      throw new Error(
        'This account is disabled. Please contact your EcoWatch administrator.'
      );
    }

    logInfo(
      req.requestId,
      'AUTH',
      `Login failed: invalid credentials for ${identifier}`
    );

    res.status(401);
    throw new Error('Invalid username or password');
  } catch (error) {
    next(error);
  }
};

const getResidentProfile = async (req, res, next) => {
  try {
    const isAdmin = String(req.resident.role || '').toUpperCase() === 'ADMIN';

    const user = isAdmin
      ? await findByAdminId(req.resident.admin_id)
      : await findByResidentId(req.resident.resident_id);

    if (user) {
      if (isAdmin) {
        res.json({
          success: true,
          admin: mapAdminResponse(user),
          // Compatibility alias for resident clients during rollout.
          resident: {
            ...mapResidentResponse({
              ...user,
              resident_id: user.admin_id,
            }),
            role: user.role,
            createdAt: user.created_at || null,
            updatedAt: user.updated_at || null,
            lastActive: user.last_active || user.updated_at || user.created_at || null,
          },
        });
      } else {
        res.json({
          success: true,
          resident: mapResidentResponse(user),
        });
      }
    } else {
      res.status(404);
      throw new Error('User not found');
    }
  } catch (error) {
    next(error);
  }
};

const updateProfile = async (req, res, next) => {
  const {
    firstName,
    lastName,
    username,
    email,
    address,
  } = req.body;
  logProfileRequest(
    req,
    `controllerReached=true requestBodyFields=${
      Object.keys(req.body).join(',') || 'none'
    }`
  );

  try {
    const isAdmin = String(req.resident.role || '').toUpperCase() === 'ADMIN';

    const currentUser = isAdmin
      ? await findByAdminId(req.resident.admin_id)
      : await findByResidentId(req.resident.resident_id);

    if (!currentUser) {
      res.status(404);
      throw new Error('User not found');
    }

    if (
      (username && username !== currentUser.username) ||
      (email && email !== currentUser.email)
    ) {
      const [
        residentWithUsername,
        adminWithUsername,
        personnelWithUsername,
        residentWithEmail,
        adminWithEmail,
        personnelWithEmail,
      ] = await Promise.all([
        username && username !== currentUser.username
          ? findResidentByUsername(username)
          : null,
        username && username !== currentUser.username
          ? findAdminByUsername(username)
          : null,
        username && username !== currentUser.username
          ? findPersonnelByUsername(username)
          : null,
        email && email !== currentUser.email
          ? findResidentByEmail(email)
          : null,
        email && email !== currentUser.email
          ? findAdminByEmail(email)
          : null,
        email && email !== currentUser.email
          ? findPersonnelByEmail(email)
          : null,
      ]);

      if (
        residentWithUsername ||
        adminWithUsername ||
        personnelWithUsername ||
        residentWithEmail ||
        adminWithEmail ||
        personnelWithEmail
      ) {
        res.status(409);
        throw new Error('Username or email is already registered');
      }
    }

    const updates = {};

    if (firstName) updates.firstName = firstName;
    if (lastName) updates.lastName = lastName;
    if (username) updates.username = username;
    if (email) updates.email = email;
    if (address !== undefined) updates.address = address;

    // The resident owns their own contact details, so they are editable from the
    // account screen. Both go through the same validators the admin app uses, and
    // an empty value is stored as NULL so the admin app can hide the row.
    //
    // messenger_link is a residents-only column, so it is skipped for an admin
    // updating their own account rather than being silently dropped later.
    if (Object.prototype.hasOwnProperty.call(req.body, 'phoneNumber')) {
      updates.phoneNumber = normalizePhoneNumber(req.body.phoneNumber);
    }
    if (
      !isAdmin &&
      Object.prototype.hasOwnProperty.call(req.body, 'messengerLink')
    ) {
      updates.messengerLink = normalizeMessengerLink(req.body.messengerLink);
    }

    logProfileRequest(req, 'postgresUpdateStarted=true');

    const updatedUser = isAdmin
      ? await updateAdmin(currentUser.admin_id, updates)
      : await updateResident(currentUser.resident_id, updates);

    logProfileRequest(req, 'postgresUpdateResult=success');

    if (isAdmin) {
      res.json({
        success: true,
        admin: mapAdminResponse(updatedUser),
        // Compatibility alias for older resident clients.
        resident: mapResidentResponse({
          ...updatedUser,
          resident_id: updatedUser.admin_id,
        }),
      });
    } else {
      res.json({
        success: true,
        resident: mapResidentResponse(updatedUser),
      });
    }
  } catch (error) {
    logProfileRequest(
      req,
      `postgresUpdateResult=failure error=${
        error.name || 'UpdateError'
      }`
    );

    return next(error);
  }
};

const updateProfileImage = async (req, res, next) => {
  logProfileRequest(
    req,
    `controllerReached=true multipartFilePresent=${Boolean(req.file)}`
  );

  try {
    if (!req.file) {
      res.status(400);
      throw new Error('Please upload an image');
    }

    logProfileRequest(req, 'cloudinaryUploadStarted=true');

    const result = await uploadImage(
      req.file.buffer,
      'ecowatch/profiles'
    );

    logProfileRequest(req, 'cloudinaryUploadResult=success');

    const isAdmin = String(req.resident.role || '').toUpperCase() === 'ADMIN';

    const currentUser = isAdmin
      ? await findByAdminId(req.resident.admin_id)
      : await findByResidentId(req.resident.resident_id);

    if (!currentUser) {
      res.status(404);
      throw new Error('User not found');
    }

    const updatedUser = isAdmin
      ? await updateAdmin(currentUser.admin_id, {
          profileImage: result.secure_url,
        })
      : await updateResident(currentUser.resident_id, {
          profileImage: result.secure_url,
        });

    logProfileRequest(req, 'postgresUpdateResult=success');

    res.json({
      success: true,
      profileImage: updatedUser.profile_image,
    });
  } catch (error) {
    logProfileRequest(
      req,
      `cloudinaryUploadResult=failure error=${
        error.message || error.name || 'UploadError'
      }`
    );

    return next(error);
  }
};

const resetLoggedInPassword = async (req, res, next) => {
  const { password } = req.body;

  try {
    const isAdmin = String(req.resident.role || '').toUpperCase() === 'ADMIN';

    const user = isAdmin
      ? await findByAdminId(req.resident.admin_id)
      : await findByResidentId(req.resident.resident_id);

    if (!user) {
      res.status(404);
      throw new Error('User not found');
    }

    const passwordHash = await bcrypt.hash(password, 10);

    if (isAdmin) {
      await updateAdminPassword(user.admin_id, passwordHash);
    } else {
      await updateResidentPassword(user.resident_id, passwordHash);
    }

    // Supabase is committed; keep the Firebase identity in step, best effort.
    await syncFirebasePasswordAfterChange({
      user,
      isAdmin,
      newPassword: password,
      requestId: req.requestId,
    });

    res.json({
      success: true,
      message: 'Password reset successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Pause the authenticated resident's own account
 * @route   POST /api/auth/disable-account
 * @access  Private/Resident
 *
 * This is a pause, not a deletion. The account, its reports, its history and
 * its settings are all preserved, so the next successful login restores the
 * same account. The client is expected to log out immediately afterwards.
 */
const disableOwnAccount = async (req, res, next) => {
  try {
    const residentId = requireResidentAccount(req);

    const resident = await pauseResidentAccount(residentId);

    if (!resident) {
      res.status(404);
      throw new Error('Account not found.');
    }

    logInfo(req.requestId, 'AUTH', `Resident account paused: ${residentId}`);

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      message:
        'Your account is disabled. Your profile, reports and history are preserved and return when you sign in again.',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Permanently delete the authenticated resident's account
 * @route   DELETE /api/auth/account
 * @access  Private/Resident
 *
 * Irreversible. The account and every row it owns are removed server-side, so
 * there is nothing left for the client to clean up locally.
 */
const deleteOwnAccount = async (req, res, next) => {
  try {
    const residentId = requireResidentAccount(req);

    const deletedResidentId = await deleteResidentAccount(residentId);

    if (!deletedResidentId) {
      res.status(404);
      throw new Error('Account not found.');
    }

    logInfo(req.requestId, 'AUTH', `Resident account permanently deleted: ${residentId}`);

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      message: 'Your account and all of its data were deleted permanently.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  registerResident,
  verifyOTP,
  forgotPassword,
  verifyResetOTP,
  resetPassword,
  loginResident,
  getResidentProfile,
  updateProfile,
  updateProfileImage,
  changePassword,
  resetLoggedInPassword,
  disableOwnAccount,
  deleteOwnAccount,
  // Exported so the contact fields the admin app renders can be asserted
  // directly instead of inferred through a database-backed request.
  mapResidentResponse,
};

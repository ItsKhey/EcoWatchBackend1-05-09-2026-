const bcrypt = require('bcryptjs');

const {
  findByIdentifier: findResidentByIdentifier,
  findByResidentId,
  findByUsername: findResidentByUsername,
  findByEmail: findResidentByEmail,
  createResident,
  updateResident,
  updatePassword: updateResidentPassword,
} = require('../repositories/residentRepository');

const {
  findByIdentifier: findAdminByIdentifier,
  findByAdminId,
  findByUsername: findAdminByUsername,
  findByEmail: findAdminByEmail,
  updateAdmin,
  touchLastActive,
  updatePassword: updateAdminPassword,
} = require('../repositories/adminRepository');

const {
  createPendingRegistration,
  findByRegistrationId,
  incrementAttempts: incrementRegistrationAttempts,
  deleteByRegistrationId,
} = require('../repositories/pendingRegistrationRepository');

const {
  createResetOTP,
  findByEmail: findResetByEmail,
  incrementAttempts: incrementResetAttempts,
  deleteByEmail: deleteResetByEmail,
} = require('../repositories/passwordResetRepository');

const {
  findByUsername: findPersonnelByUsername,
  findByEmail: findPersonnelByEmail,
} = require('../repositories/personnelRepository');

const generateToken = require('../utils/generateToken');
const {
  generateResidentId,
  generateRegistrationId,
  generateOTP,
} = require('../utils/generateId');

const {
  sendVerificationEmail,
  sendPasswordResetEmail,
} = require('../services/emailServices');

const {
  logInfo,
  logError,
  logProfileRequest,
} = require('../utils/logger');

const { uploadImage } = require('../services/cloudinaryService');

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

const mapResidentResponse = (user) => ({
  residentId: user.resident_id,
  firstName: user.first_name,
  lastName: user.last_name,
  username: user.username,
  email: user.email,
  address: user.address || '',
  profileImage: user.profile_image || '',
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
      }
);

const registerResident = async (req, res, next) => {
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
      phoneNumber: '',
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

    if (!resetEntry) {
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

    if (!resetEntry) {
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

    if (
      resident &&
      await bcrypt.compare(password, resident.password_hash)
    ) {
      res.json({
        success: true,
        token: generateToken(resident.resident_id),
        resident: mapLoginResponse(resident, false),
      });

      logInfo(
        req.requestId,
        'AUTH',
        `Login successful: ${resident.resident_id} (${resident.role})`
      );

      return;
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

    res.json({
      success: true,
      message: 'Password reset successfully',
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
};

const bcrypt = require('bcryptjs');
const Resident = require('../models/Resident');
const PendingRegistration = require('../models/PendingRegistration');
const PasswordResetOTP = require('../models/PasswordResetOTP');
const generateToken = require('../utils/generateToken');
const { generateResidentId, generateRegistrationId, generateOTP } = require('../utils/generateId');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/emailServices');
const { logInfo, logError, logProfileRequest } = require('../utils/logger');
const { uploadImage } = require('../services/cloudinaryService');

const OTP_EXPIRY_MS = 5 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

const hashOtp = async (otp) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(otp, salt);
};

// @desc    Register a new resident (Step 1: Create pending & send OTP)
// @route   POST /api/auth/register
// @access  Public
const registerResident = async (req, res, next) => {
  const { firstName, lastName, username, email, password } = req.body;

  try {
    logInfo(req.requestId, 'AUTH', `Registration attempt for username: ${username}`);

    const userExists = await Resident.findOne({ username });
    if (userExists) {
      res.status(400);
      throw new Error('Username is already taken');
    }

    const otp = generateOTP(4);
    const registrationId = generateRegistrationId();
    const hashedOtp = await hashOtp(otp);

    const pending = await PendingRegistration.create({
      registrationId,
      firstName,
      lastName,
      username,
      email,
      password,
      otp: hashedOtp,
      otpExpires: new Date(Date.now() + OTP_EXPIRY_MS),
      attempts: 0,
    });

    logInfo(req.requestId, 'AUTH', `Pending registration created: ${registrationId}`);

    try {
      await sendVerificationEmail(email, otp, req.requestId);
      logInfo(req.requestId, 'EMAIL', `Verification OTP sent to ${email}`);
    } catch (err) {
      logError(req.requestId, 'EMAIL', err.message || 'Verification email send failed');
      await PendingRegistration.deleteOne({ registrationId });
      res.status(500);
      throw new Error('Email could not be sent');
    }

    res.status(201).json({
      success: true,
      registrationId: pending.registrationId,
      message: 'OTP sent to email',
    });
  } catch (error) {
    return next(error);
  }
};

// @desc    Verify OTP and create Resident (Step 2)
// @route   POST /api/auth/verify-otp
// @access  Public
const verifyOTP = async (req, res, next) => {
  const { registrationId, otp } = req.body;

  try {
    logInfo(req.requestId, 'AUTH', `Verification attempt for REG ID: ${registrationId}`);

    const pending = await PendingRegistration.findOne({ registrationId });

    if (!pending) {
      res.status(404);
      throw new Error('Registration session expired or not found');
    }

    if (pending.otpExpires < Date.now()) {
      await pending.deleteOne();
      res.status(400);
      throw new Error('OTP has expired');
    }

    const isMatch = await bcrypt.compare(otp, pending.otp);

    if (!isMatch) {
      pending.attempts += 1;
      await pending.save();

      if (pending.attempts >= MAX_OTP_ATTEMPTS) {
        await pending.deleteOne();
        res.status(400);
        throw new Error('Too many failed attempts. Please register again.');
      }

      res.status(400);
      throw new Error('Invalid OTP');
    }

    const resident = await Resident.create({
      residentId: generateResidentId(),
      firstName: pending.firstName,
      lastName: pending.lastName,
      username: pending.username,
      email: pending.email,
      password: pending.password,
    });

    logInfo(req.requestId, 'AUTH', `Resident created: ${resident.residentId}`);

    await pending.deleteOne();

    res.status(201).json({
      success: true,
      residentId: resident.residentId,
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

    let resident;
    if (username) {
      resident = await Resident.findOne({ username });
    } else {
      resident = await Resident.findOne({ email });
    }

    // Even if resident not found, we don't leak it for security,
    // but we need an email to send to.
    let targetEmail;
    if (resident) {
      targetEmail = resident.email;
    } else if (email) {
      targetEmail = email;
    } else {
      // Username provided but not found, and no email provided
      res.json({
        success: true,
        message: 'If an account exists for this username, a reset code has been sent.',
      });
      return;
    }
    const otp = generateOTP(4);
    const otpHash = await hashOtp(otp);

    await PasswordResetOTP.deleteMany({ email: targetEmail });

    const resetEntry = await PasswordResetOTP.create({
      userId: resident ? resident._id : null,
      email: targetEmail,
      otpHash,
      otpExpires: new Date(Date.now() + OTP_EXPIRY_MS),
      attempts: 0,
    });

    try {
      await sendPasswordResetEmail(targetEmail, otp, req.requestId);
      logInfo(req.requestId, 'EMAIL', `Password reset OTP sent to ${targetEmail}`);
    } catch (err) {
      logError(req.requestId, 'EMAIL', err.message || 'Password reset email send failed');
      await PasswordResetOTP.deleteOne({ _id: resetEntry._id });
      res.status(500);
      throw new Error('Unable to send password reset code');
    }

    res.json({
      success: true,
      message: 'If an account exists for this email, a reset code has been sent.',
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
      const resByUsername = await Resident.findOne({ username });
      if (resByUsername) targetEmail = resByUsername.email;
      else targetEmail = 'unknown';
    }

    const resetEntry = await PasswordResetOTP.findOne({ email: targetEmail });

    if (!resetEntry) {
      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    if (resetEntry.otpExpires < Date.now()) {
      await PasswordResetOTP.deleteOne({ _id: resetEntry._id });
      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    const isMatch = await bcrypt.compare(otp, resetEntry.otpHash);

    if (!isMatch) {
      resetEntry.attempts += 1;
      await resetEntry.save();

      if (resetEntry.attempts >= MAX_OTP_ATTEMPTS) {
        await PasswordResetOTP.deleteOne({ _id: resetEntry._id });
        res.status(400);
        throw new Error('Too many failed attempts. Please request a new reset code.');
      }

      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    await PasswordResetOTP.deleteOne({ _id: resetEntry._id });

    res.json({
      success: true,
      message: 'OTP verified successfully',
    });
  } catch (error) {
    next(error);
  }
};

const resetPassword = async (req, res, next) => {
  const { email, username, otp, password } = req.body;

  try {
    if ((!email && !username) || !otp || !password) {
      res.status(400);
      throw new Error('Username/Email, OTP, and password are required');
    }

    let targetEmail = email;
    if (!targetEmail && username) {
      const resByUsername = await Resident.findOne({ username });
      if (resByUsername) targetEmail = resByUsername.email;
      else targetEmail = 'unknown'; // Will fail otp check anyway
    }

    const resetEntry = await PasswordResetOTP.findOne({ email: targetEmail });

    if (!resetEntry) {
      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    if (resetEntry.otpExpires < Date.now()) {
      await PasswordResetOTP.deleteOne({ _id: resetEntry._id });
      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    const isMatch = await bcrypt.compare(otp, resetEntry.otpHash);

    if (!isMatch) {
      resetEntry.attempts += 1;
      await resetEntry.save();

      if (resetEntry.attempts >= MAX_OTP_ATTEMPTS) {
        await PasswordResetOTP.deleteOne({ _id: resetEntry._id });
        res.status(400);
        throw new Error('Too many failed attempts. Please request a new reset code.');
      }

      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    let resident;
    if (email) {
      resident = await Resident.findOne({ email });
    } else if (username) {
      resident = await Resident.findOne({ username });
    }

    if (!resident) {
      await PasswordResetOTP.deleteOne({ _id: resetEntry._id });
      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    resident.password = password;
    await resident.save();
    await PasswordResetOTP.deleteOne({ _id: resetEntry._id });

    res.json({
      success: true,
      message: 'Password reset successfully',
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Change password (authenticated)
// @route   POST /api/auth/change-password
// @access  Private
const changePassword = async (req, res, next) => {
  const { oldPassword, newPassword } = req.body;

  try {
    const resident = await Resident.findById(req.resident._id);

    if (resident && (await resident.matchPassword(oldPassword))) {
      resident.password = newPassword;
      await resident.save();
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

// @desc    Auth resident & get token
// @route   POST /api/auth/login
// @access  Public
const loginResident = async (req, res, next) => {
  const { username, password } = req.body;

  try {
    logInfo(req.requestId, 'AUTH', `Login attempt for username: ${username}`);

    const resident = await Resident.findOne({ username });

    if (resident && (await resident.matchPassword(password))) {
      res.json({
        success: true,
        token: generateToken(resident._id),
        resident: {
          residentId: resident.residentId,
          firstName: resident.firstName,
          lastName: resident.lastName,
          username: resident.username,
          email: resident.email,
          address: resident.address,
          profileImage: resident.profileImage,
        },
      });
      logInfo(req.requestId, 'AUTH', `Login successful: ${resident.residentId}`);
    } else {
      res.status(401);
      throw new Error('Invalid username or password');
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Get current resident profile
// @route   GET /api/auth/me
// @access  Private
const getResidentProfile = async (req, res, next) => {
  try {
    const resident = await Resident.findById(req.resident._id).select('-password');

    if (resident) {
      res.json({
        success: true,
        resident: {
          residentId: resident.residentId,
          firstName: resident.firstName,
          lastName: resident.lastName,
          username: resident.username,
          email: resident.email,
          address: resident.address,
          profileImage: resident.profileImage,
        }
      });
    } else {
      res.status(404);
      throw new Error('Resident not found');
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Update resident profile
// @route   PATCH /api/auth/profile
// @access  Private
const updateProfile = async (req, res, next) => {
  const { firstName, lastName, email, address } = req.body;
  logProfileRequest(req, `controllerReached=true requestBodyFields=${Object.keys(req.body).join(',') || 'none'}`);

  try {
    const resident = await Resident.findById(req.resident._id);

    if (resident) {
      resident.firstName = firstName || resident.firstName;
      resident.lastName = lastName || resident.lastName;
      resident.email = email || resident.email;
      if (address !== undefined) {
        resident.address = address;
      }

      logProfileRequest(req, 'mongodbUpdateStarted=true');
      const updatedResident = await resident.save();
      logProfileRequest(req, 'mongodbUpdateResult=success');

      res.json({
        success: true,
        resident: {
          residentId: updatedResident.residentId,
          firstName: updatedResident.firstName,
          lastName: updatedResident.lastName,
          username: updatedResident.username,
          email: updatedResident.email,
          address: updatedResident.address,
          profileImage: updatedResident.profileImage,
        },
      });
    } else {
      res.status(404);
      throw new Error('Resident not found');
    }
  } catch (error) {
    logProfileRequest(req, `mongodbUpdateResult=failure error=${error.name || 'UpdateError'}`);
    return next(error);
  }
};

// @desc    Update resident profile image
// @route   PATCH /api/auth/profile/image
// @access  Private
const updateProfileImage = async (req, res, next) => {
  logProfileRequest(req, `controllerReached=true multipartFilePresent=${Boolean(req.file)}`);

  try {
    if (!req.file) {
      res.status(400);
      throw new Error('Please upload an image');
    }

    logProfileRequest(req, 'cloudinaryUploadStarted=true');
    const result = await uploadImage(req.file.buffer, 'ecowatch/profiles');
    logProfileRequest(req, 'cloudinaryUploadResult=success');

    const resident = await Resident.findById(req.resident._id);
    if (resident) {
      resident.profileImage = result.secure_url;
      logProfileRequest(req, 'mongodbUpdateStarted=true');
      await resident.save();
      logProfileRequest(req, 'mongodbUpdateResult=success');

      res.json({
        success: true,
        profileImage: result.secure_url,
      });
    } else {
      res.status(404);
      throw new Error('Resident not found');
    }
  } catch (error) {
    logProfileRequest(req, `cloudinaryUploadResult=failure error=${error.message || error.name || 'UploadError'}`);
    return next(error);
  }
};

// @desc    Reset password for logged-in resident (No OTP required per UI request)
// @route   PATCH /api/auth/reset-logged-in
// @access  Private
const resetLoggedInPassword = async (req, res, next) => {
  const { password } = req.body;

  try {
    const resident = await Resident.findById(req.resident._id);

    if (!resident) {
      res.status(404);
      throw new Error('Resident not found');
    }

    resident.password = password;
    await resident.save();

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

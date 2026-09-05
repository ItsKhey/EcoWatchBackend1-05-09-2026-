const bcrypt = require('bcryptjs');
const Resident = require('../models/Resident');
const PendingRegistration = require('../models/PendingRegistration');
const generateToken = require('../utils/generateToken');
const { generateResidentId, generateRegistrationId, generateOTP } = require('../utils/generateId');
const sendEmail = require('../utils/sendEmail');
const { logInfo, logError } = require('../utils/logger');

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

    const otp = generateOTP();
    const registrationId = generateRegistrationId();

    // Hash OTP before storing (optional but safer)
    const salt = await bcrypt.genSalt(10);
    const hashedOtp = await bcrypt.hash(otp, salt);

    const pending = await PendingRegistration.create({
      registrationId,
      firstName,
      lastName,
      username,
      email,
      password, // Password will be hashed by Resident model pre-save hook
      otp: hashedOtp,
      otpExpires: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
    });

    logInfo(req.requestId, 'AUTH', `Pending registration created: ${registrationId}`);

    // Send OTP Email
    try {
      await sendEmail({
        email: email,
        subject: 'EcoWatch - Registration OTP',
        message: `Your OTP for EcoWatch registration is: ${otp}. It expires in 10 minutes.`,
        html: `<h3>Welcome to EcoWatch</h3><p>Your OTP for registration is:</p><h1>${otp}</h1><p>It expires in 10 minutes.</p>`,
      });
      logInfo(req.requestId, 'EMAIL', `OTP sent to ${email}`);
    } catch (err) {
      logError(req.requestId, 'EMAIL', err.message);
      res.status(500);
      throw new Error('Email could not be sent');
    }

    res.status(201).json({
      success: true,
      registrationId: pending.registrationId,
      message: 'OTP sent to email',
    });
  } catch (error) {
    next(error);
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
      res.status(400);
      throw new Error('OTP has expired');
    }

    const isMatch = await bcrypt.compare(otp, pending.otp);

    if (!isMatch) {
      pending.attempts += 1;
      await pending.save();

      if (pending.attempts >= 5) {
        await pending.deleteOne();
        res.status(400);
        throw new Error('Too many failed attempts. Please register again.');
      }

      res.status(400);
      throw new Error('Invalid OTP');
    }

    // Create real Resident
    const resident = await Resident.create({
      residentId: generateResidentId(),
      firstName: pending.firstName,
      lastName: pending.lastName,
      username: pending.username,
      email: pending.email,
      password: pending.password, // Pre-save hook will hash this
    });

    logInfo(req.requestId, 'AUTH', `Resident created: ${resident.residentId}`);

    // Delete pending registration
    await pending.deleteOne();

    res.status(201).json({
      success: true,
      residentId: resident.residentId,
      message: 'Account verified and created successfully',
    });
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
      res.json(resident);
    } else {
      res.status(404);
      throw new Error('Resident not found');
    }
  } catch (error) {
    next(error);
  }
};

module.exports = {
  registerResident,
  verifyOTP,
  loginResident,
  getResidentProfile,
};

const mongoose = require('mongoose');
const { authConnection } = require('../config/db');

const pendingRegistrationSchema = mongoose.Schema(
  {
    registrationId: {
      type: String,
      required: true,
      unique: true,
    },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    username: { type: String, required: true },
    email: { type: String, required: true },
    password: { type: String, required: true },
    otp: {
      type: String,
      required: true,
    },
    otpExpires: {
      type: Date,
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Automatically delete expired registrations
pendingRegistrationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3600 }); // Expire in 1 hour

const PendingRegistration = authConnection.model('PendingRegistration', pendingRegistrationSchema);

module.exports = PendingRegistration;

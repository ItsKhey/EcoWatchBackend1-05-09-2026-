const mongoose = require('mongoose');

const passwordResetOtpSchema = mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Resident',
      default: null,
    },
    email: {
      type: String,
      required: true,
      index: true,
    },
    otpHash: {
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
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

passwordResetOtpSchema.index({ otpExpires: 1 }, { expireAfterSeconds: 0 });

const PasswordResetOTP = mongoose.model('PasswordResetOTP', passwordResetOtpSchema);

module.exports = PasswordResetOTP;

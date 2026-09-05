const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const residentSchema = mongoose.Schema(
  {
    residentId: {
      type: String,
      required: true,
      unique: true,
    },
    firstName: {
      type: String,
      required: true,
    },
    lastName: {
      type: String,
      required: true,
    },
    username: {
      type: String,
      required: true,
      unique: true,
    },
    email: {
      type: String,
      required: true,
      // Note: Not unique per requirements (multiple accounts same email)
    },
    password: {
      type: String,
      required: true,
    },
    profileImage: {
      type: String,
      default: '',
    },
    isVerified: {
      type: Boolean,
      default: true, // Should be true if they passed OTP
    },
  },
  {
    timestamps: true,
  }
);

// Match resident entered password to hashed password in database
residentSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Encrypt password using bcrypt before saving
residentSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    next();
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

const Resident = mongoose.model('Resident', residentSchema);

module.exports = Resident;

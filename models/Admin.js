const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { adminConnection } = require('../config/db');

const adminSchema = mongoose.Schema(
  {
    residentId: { // Keeping field name same to avoid ref breaks if possible, or rename to adminId
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
    },
    password: {
      type: String,
      required: true,
    },
    address: {
      type: String,
      default: '',
    },
    profileImage: {
      type: String,
      default: '',
    },
    isVerified: {
      type: Boolean,
      default: true,
    },
    role: {
      type: String,
      enum: ['ADMIN'],
      default: 'ADMIN',
    },
    phoneNumber: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
    collection: 'adminDB' // Explicitly set collection name as requested
  }
);

// Match admin entered password to hashed password in database
adminSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Encrypt password using bcrypt before saving
adminSchema.pre('save', async function () {
  if (!this.isModified('password')) {
    return;
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

const Admin = adminConnection.model('Admin', adminSchema);

module.exports = Admin;

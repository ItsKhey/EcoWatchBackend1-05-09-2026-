const mongoose = require('mongoose');
const { appConnection } = require('../config/db');

const notificationSchema = mongoose.Schema(
  {
    residentId: {
      type: String,
      required: true,
      ref: 'Resident',
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ['SYSTEM', 'ADMIN', 'REPORT_UPDATE'],
      default: 'SYSTEM',
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const Notification = appConnection.model('Notification', notificationSchema);
module.exports = Notification;

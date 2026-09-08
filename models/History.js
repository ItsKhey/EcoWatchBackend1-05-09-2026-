const mongoose = require('mongoose');
const { appConnection } = require('../config/db');

const historySchema = mongoose.Schema(
  {
    residentId: {
      type: String,
      required: true,
      ref: 'Resident',
    },
    reportId: {
      type: String,
      required: true,
    },
    action: {
      type: String,
      required: true,
      enum: ['SUBMITTED', 'MOVED_TO_TRASH', 'ARCHIVED', 'RESTORED', 'STATUS_CHANGED', 'PERMANENTLY_DELETED'],
    },
    oldStatus: {
      type: String,
      default: null,
    },
    newStatus: {
      type: String,
      default: null,
    },
    description: {
      type: String,
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

const History = appConnection.model('History', historySchema);

module.exports = History;

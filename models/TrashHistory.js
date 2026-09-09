const mongoose = require('mongoose');
const { appConnection } = require('../config/db');

const trashHistorySchema = mongoose.Schema(
  {
    residentId: { type: String, required: true },
    reportId: { type: String, required: true },
    action: { type: String, required: true },
    oldStatus: { type: String },
    newStatus: { type: String },
    description: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    deletedAt: { type: Date, default: Date.now }
  },
  {
    timestamps: true,
  }
);

const TrashHistory = appConnection.model('TrashHistory', trashHistorySchema);
module.exports = TrashHistory;

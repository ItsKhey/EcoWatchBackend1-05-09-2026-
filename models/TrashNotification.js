const mongoose = require('mongoose');
const { appConnection } = require('../config/db');

const trashNotificationSchema = mongoose.Schema(
  {
    residentId: { type: String, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    type: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    deletedAt: { type: Date, default: Date.now }
  },
  {
    timestamps: true,
  }
);

const TrashNotification = appConnection.model('TrashNotification', trashNotificationSchema);
module.exports = TrashNotification;

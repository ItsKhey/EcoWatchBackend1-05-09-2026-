const mongoose = require('mongoose');
const { appConnection } = require('../config/db');

const trashReportSchema = mongoose.Schema(
  {
    reportId: { type: String, required: true },
    title: { type: String, required: true },
    residentId: { type: String, required: true, ref: 'Resident' },
    category: { type: String, required: true },
    description: { type: String, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    imageUrl: { type: String, required: true },
    status: { type: String, required: true },
    isDeleted: { type: Boolean, default: true },
    deletedAt: { type: Date, default: Date.now },
    isArchived: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  }
);

const TrashReport = appConnection.model('TrashReport', trashReportSchema);
module.exports = TrashReport;

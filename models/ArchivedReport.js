const mongoose = require('mongoose');

const archivedReportSchema = mongoose.Schema(
  {
    reportId: { type: String, required: true },
    title: { type: String, required: true },
    residentId: { type: String, required: true, ref: 'Resident' },
    category: { type: String, required: true },
    description: { type: String, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    imageUrl: { type: String, required: true },
    status: { type: String, required: true, default: 'Completed' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    isArchived: { type: Boolean, default: true },
  },
  {
    timestamps: true,
  }
);

const ArchivedReport = mongoose.model('ArchivedReport', archivedReportSchema);
module.exports = ArchivedReport;

const mongoose = require('mongoose');

const trashReportSchema = mongoose.Schema(
  {
    reportId: {
      type: String,
      required: true,
      unique: true,
    },
    title: {
      type: String,
      required: true,
    },
    residentId: {
      type: String,
      required: true,
      ref: 'Resident',
    },
    category: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    latitude: {
      type: Number,
      required: true,
    },
    longitude: {
      type: Number,
      required: true,
    },
    imageUrl: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['Pending', 'Accepted', 'In Progress', 'Completed', 'Denied'],
      default: 'Pending',
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    isArchived: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    collection: 'trash_reports',
  }
);

const TrashReport = mongoose.model('TrashReport', trashReportSchema);

module.exports = TrashReport;

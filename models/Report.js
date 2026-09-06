const mongoose = require('mongoose');

const reportSchema = mongoose.Schema(
  {
    reportId: {
      type: String,
      required: true,
      unique: true,
    },

    residentId: {
      type: String,
      required: true,
      ref: 'Resident',
    },

    title: {
      type: String,
      required: true,
      trim: true,
    },

    category: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      required: true,
      trim: true,
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
  },
  {
    timestamps: true,
  }
);

const Report = mongoose.model('Report', reportSchema);

module.exports = Report;
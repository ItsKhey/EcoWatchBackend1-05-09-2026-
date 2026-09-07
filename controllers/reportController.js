const mongoose = require('mongoose');
const Report = require('../models/Report');
const ArchivedReport = require('../models/ArchivedReport');
const TrashReport = require('../models/TrashReport');
const { generateReportId } = require('../utils/generateId');
const { uploadImage } = require('../services/cloudinaryService');
const { logInfo, logError } = require('../utils/logger');

// @desc    Create a new report
// @route   POST /api/reports
// @access  Private
const createReport = async (req, res, next) => {
  const { title, category, description, latitude, longitude } = req.body;

  try {
    logInfo(req.requestId, 'REPORT', `New report submission from resident: ${req.resident.residentId}`);

    if (!req.file) {
      res.status(400);
      throw new Error('Please upload an image');
    }

    logInfo(req.requestId, 'IMAGE', 'Starting upload to Cloudinary');

    // Upload image to Cloudinary using buffer
    const result = await uploadImage(req.file.buffer, 'ecowatch/reports');

    logInfo(req.requestId, 'IMAGE', `Upload completed: ${result.secure_url}`);

    const report = await Report.create({
      reportId: generateReportId(),
      residentId: req.resident.residentId,
      title,
      category,
      description,
      latitude,
      longitude,
      imageUrl: result.secure_url,
    });

    logInfo(req.requestId, 'DATABASE', `Report created: ${report.reportId}`);

    res.status(201).json(report);
  } catch (error) {
    next(error);
  }
};

// @desc    Get current resident reports from all collections
// @route   GET /api/reports/my-reports
// @access  Private
const getMyReports = async (req, res, next) => {
  try {
    const residentFilter = { residentId: req.resident.residentId };

    // Fetch from all collections
    const [reports, archivedReports, trashReports] = await Promise.all([
      Report.find(residentFilter).lean(),
      ArchivedReport.find(residentFilter).lean(),
      TrashReport.find(residentFilter).lean(),
    ]);

    // Normalize and combine
    const allReports = [
      ...reports.map((r) => normalizeReport(r, 'reports')),
      ...archivedReports.map((r) => normalizeReport(r, 'archived_reports')),
      ...trashReports.map((r) => normalizeReport(r, 'trash_reports')),
    ];

    // Sort by newest first
    allReports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(allReports);
  } catch (error) {
    next(error);
  }
};

const normalizeReport = (report, sourceCollection) => {
  return {
    ...report,
    sourceCollection,
    isDeleted: sourceCollection === 'trash_reports',
    isArchived: sourceCollection === 'archived_reports',
    // Ensure id is mapped to _id for Room compat
    mongoId: report._id.toString()
  };
};

const findReportInAnyCollection = async (id, residentId) => {
  const query = mongoose.isValidObjectId(id) ? { _id: id } : { reportId: id };
  query.residentId = residentId;

  let report = await Report.findOne(query);
  if (report) return { report, Model: Report, source: 'reports' };

  report = await ArchivedReport.findOne(query);
  if (report) return { report, Model: ArchivedReport, source: 'archived_reports' };

  report = await TrashReport.findOne(query);
  if (report) return { report, Model: TrashReport, source: 'trash_reports' };

  return null;
};

// @desc    Move to Trash
// @route   POST /api/reports/:id/move-to-trash
const softDeleteReport = async (req, res, next) => {
  try {
    const found = await findReportInAnyCollection(req.params.id, req.resident.residentId);

    if (!found) {
      res.status(404);
      throw new Error('Report not found');
    }

    if (found.source === 'trash_reports') {
      return res.json(found.report);
    }

    const reportData = found.report.toObject();
    delete reportData._id; // Let Mongo generate new or keep same? Usually move keeps same ID

    const trashReport = await TrashReport.create({
      ...reportData,
      _id: found.report._id,
      isDeleted: true,
      deletedAt: new Date(),
      isArchived: false
    });

    await found.Model.deleteOne({ _id: found.report._id });

    res.json(normalizeReport(trashReport.toObject(), 'trash_reports'));
  } catch (error) {
    next(error);
  }
};

// @desc    Restore from Trash or Archive
// @route   POST /api/reports/:id/restore
const restoreReport = async (req, res, next) => {
  try {
    const found = await findReportInAnyCollection(req.params.id, req.resident.residentId);

    if (!found) {
      res.status(404);
      throw new Error('Report not found');
    }

    if (found.source === 'reports') {
      return res.json(normalizeReport(found.report.toObject(), 'reports'));
    }

    const reportData = found.report.toObject();

    const restoredReport = await Report.create({
      ...reportData,
      _id: found.report._id,
      isDeleted: false,
      deletedAt: null,
      isArchived: false
    });

    await found.Model.deleteOne({ _id: found.report._id });

    res.json(normalizeReport(restoredReport.toObject(), 'reports'));
  } catch (error) {
    next(error);
  }
};

// @desc    Move to Archive
// @route   POST /api/reports/:id/move-to-archive
const archiveReport = async (req, res, next) => {
  try {
    const found = await findReportInAnyCollection(req.params.id, req.resident.residentId);

    if (!found) {
      res.status(404);
      throw new Error('Report not found');
    }

    if (found.source === 'archived_reports') {
      return res.json(found.report);
    }

    const reportData = found.report.toObject();

    const archivedReport = await ArchivedReport.create({
      ...reportData,
      _id: found.report._id,
      isArchived: true,
      isDeleted: false,
      deletedAt: null
    });

    await found.Model.deleteOne({ _id: found.report._id });

    res.json(normalizeReport(archivedReport.toObject(), 'archived_reports'));
  } catch (error) {
    next(error);
  }
};

const bulkMoveReportsHandler = (targetCollection) => async (req, res, next) => {
  try {
    const { ids } = req.body;
    let modifiedCount = 0;

    for (const id of ids) {
      const found = await findReportInAnyCollection(id, req.resident.residentId);
      if (!found || found.source === targetCollection) continue;

      const reportData = found.report.toObject();
      let DestinationModel;
      let updates = {};

      if (targetCollection === 'archived_reports') {
        DestinationModel = ArchivedReport;
        updates = { isArchived: true, isDeleted: false };
      } else if (targetCollection === 'trash_reports') {
        DestinationModel = TrashReport;
        updates = { isDeleted: true, deletedAt: new Date(), isArchived: false };
      } else {
        DestinationModel = Report;
        updates = { isDeleted: false, isArchived: false };
      }

      await DestinationModel.create({ ...reportData, _id: found.report._id, ...updates });
      await found.Model.deleteOne({ _id: found.report._id });
      modifiedCount++;
    }

    res.json({ message: `Moved ${modifiedCount} reports`, modifiedCount });
  } catch (error) {
    next(error);
  }
};

const bulkSoftDeleteReports = bulkMoveReportsHandler('trash_reports');
const bulkRestoreReports = bulkMoveReportsHandler('reports');
const bulkArchiveReports = bulkMoveReportsHandler('archived_reports');

// @desc    Update a report
// @route   PATCH /api/reports/:id
const updateReport = async (req, res, next) => {
  const { title, category, description, latitude, longitude } = req.body;

  try {
    const report = await Report.findById(req.params.id);

    if (!report || report.residentId !== req.resident.residentId) {
      res.status(404);
      throw new Error('Report not found');
    }

    let imageUrl = report.imageUrl;
    if (req.file) {
      const result = await uploadImage(req.file.buffer, 'ecowatch/reports');
      imageUrl = result.secure_url;
    }

    report.title = title || report.title;
    report.category = category || report.category;
    report.description = description || report.description;
    report.latitude = latitude || report.latitude;
    report.longitude = longitude || report.longitude;
    report.imageUrl = imageUrl;

    const updatedReport = await report.save();
    res.json(updatedReport);
  } catch (error) {
    next(error);
  }
};

// @desc    Permanent Delete
// @route   DELETE /api/reports/:id
const deleteReport = async (req, res, next) => {
  try {
    const found = await findReportInAnyCollection(req.params.id, req.resident.residentId);

    if (!found) {
      res.status(404);
      throw new Error('Report not found');
    }

    await found.Model.deleteOne({ _id: found.report._id });
    res.json({ message: 'Report permanently removed' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createReport,
  getMyReports,
  updateReport,
  deleteReport,
  softDeleteReport,
  restoreReport,
  archiveReport,
  bulkSoftDeleteReports,
  bulkRestoreReports,
  bulkArchiveReports,
};

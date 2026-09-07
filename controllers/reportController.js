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
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    next(error);
  }
};

// @desc    Get current resident reports
// @route   GET /api/reports/my-reports
// @access  Private
const getMyReports = async (req, res, next) => {
  try {
    const view = req.query.view || 'default';
    if (!['default', 'archive', 'trash', 'inbox', 'all'].includes(view)) {
      res.status(400);
      throw new Error('Invalid report view. Use default, archive, trash, inbox, or all');
    }

    const residentFilter = { residentId: req.resident.residentId };
    const [reports, archivedReports, trashReports] = await Promise.all([
      Report.find(residentFilter).lean(),
      ArchivedReport.find(residentFilter).lean(),
      TrashReport.find(residentFilter).lean(),
    ]);

    const allReports = [
      ...reports.map((report) => normalizeReport(report, 'reports')),
      ...archivedReports.map((report) => normalizeReport(report, 'archived_reports')),
      ...trashReports.map((report) => normalizeReport(report, 'trash_reports')),
    ];

    const visibleReports = view === 'archive'
      ? allReports.filter((report) => report.sourceCollection === 'archived_reports')
      : view === 'trash'
        ? allReports.filter((report) => report.sourceCollection === 'trash_reports')
        : view === 'default'
          ? allReports
          : view === 'inbox'
            ? allReports.filter((report) => report.sourceCollection === 'reports')
          : allReports;

    visibleReports.sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
    res.json(visibleReports);
  } catch (error) {
    next(error);
  }
};

const normalizeReport = (report, sourceCollection) => ({
  ...report,
  sourceCollection,
  isDeleted: sourceCollection === 'trash_reports' || report.isDeleted === true,
  deletedAt: report.deletedAt ?? null,
  isArchived: sourceCollection === 'archived_reports' || report.isArchived === true,
});

const findOwnedReport = async (Model, id, residentId) => {
  const identifierQuery = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: id }, { reportId: id }] }
    : { reportId: id };

  return Model.findOne({ residentId, ...identifierQuery });
};

const findOwnedReportInCollections = async (models, id, residentId) => {
  for (const [Model, sourceCollection] of models) {
    const report = await findOwnedReport(Model, id, residentId);
    if (report) {
      return { report, Model, sourceCollection };
    }
  }

  return null;
};

const moveReport = async (source, DestinationModel, updates) => {
  const reportData = source.report.toObject();
  Object.assign(reportData, updates);

  const movedReport = await DestinationModel.create(reportData);
  await source.Model.deleteOne({ _id: source.report._id });
  return movedReport;
};

const bulkMoveReports = async (ids, residentId, sourceModels, DestinationModel, updates) => {
  let modifiedCount = 0;

  for (const id of ids) {
    const source = await findOwnedReportInCollections(sourceModels, id, residentId);
    if (source) {
      await moveReport(source, DestinationModel, updates);
      modifiedCount += 1;
    }
  }

  return modifiedCount;
};

const softDeleteReport = async (req, res, next) => {
  try {
    let report = mongoose.isValidObjectId(req.params.id)
      ? await Report.findById(req.params.id)
      : await Report.findOne({ reportId: req.params.id });
    let Model = Report;

    if (!report) {
      report = mongoose.isValidObjectId(req.params.id)
        ? await ArchivedReport.findById(req.params.id)
        : await ArchivedReport.findOne({ reportId: req.params.id });
      Model = ArchivedReport;
    }

    if (!report || report.residentId !== req.resident.residentId) {
      res.status(404);
      throw new Error('Report not found');
    }

    const movedReport = await moveReport({ report, Model }, TrashReport, {
      isDeleted: true,
      deletedAt: new Date(),
      isArchived: false,
    });

    res.json(normalizeReport(movedReport.toObject(), 'trash_reports'));
  } catch (error) {
    next(error);
  }
};

const restoreReport = async (req, res, next) => {
  try {
    const source = await findOwnedReportInCollections(
      [[TrashReport, 'trash_reports']],
      req.params.id,
      req.resident.residentId
    );

    if (!source) {
      res.status(404);
      throw new Error('Report not found in trash');
    }

    const movedReport = await moveReport(source, Report, {
      isDeleted: false,
      deletedAt: null,
      isArchived: false,
    });

    res.json(normalizeReport(movedReport.toObject(), 'reports'));
  } catch (error) {
    next(error);
  }
};

const archiveReport = async (req, res, next) => {
  try {
    const report = await Report.findById(req.params.id);

    if (!report || report.residentId !== req.resident.residentId) {
      res.status(404);
      throw new Error('Report not found');
    }

    const movedReport = await moveReport({
      report,
      Model: Report,
      sourceCollection: 'reports',
    }, ArchivedReport, {
      isDeleted: false,
      deletedAt: null,
      isArchived: true,
    });

    res.json(normalizeReport(movedReport.toObject(), 'archived_reports'));
  } catch (error) {
    next(error);
  }
};

const bulkMoveReportsHandler = (sourceModels, DestinationModel, updates, message) => async (req, res, next) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || !id.trim())) {
      res.status(400);
      throw new Error('Request body must contain a non-empty ids array of report IDs');
    }

    const modifiedCount = await bulkMoveReports(
      ids,
      req.resident.residentId,
      sourceModels,
      DestinationModel,
      updates
    );
    res.json({ message, modifiedCount });
  } catch (error) {
    next(error);
  }
};

const bulkSoftDeleteReports = bulkMoveReportsHandler(
  [[Report, 'reports'], [ArchivedReport, 'archived_reports']],
  TrashReport,
  { isDeleted: true, deletedAt: new Date(), isArchived: false },
  'Reports moved to trash'
);

const bulkRestoreReports = bulkMoveReportsHandler(
  [[TrashReport, 'trash_reports']],
  Report,
  { isDeleted: false, deletedAt: null, isArchived: false },
  'Reports restored'
);

const bulkArchiveReports = bulkMoveReportsHandler(
  [[Report, 'reports']],
  ArchivedReport,
  { isDeleted: false, deletedAt: null, isArchived: true },
  'Reports archived'
);

// @desc    Update a report
// @route   PATCH /api/reports/:id
// @access  Private
const updateReport = async (req, res, next) => {
  const { title, category, description, latitude, longitude } = req.body;

  try {
    logInfo(req.requestId, 'REPORT', `Update request for report: ${req.params.id}`);

    let report = await Report.findById(req.params.id);

    if (!report) {
      res.status(404);
      throw new Error('Report not found');
    }

    // Check ownership
    if (report.residentId !== req.resident.residentId) {
      res.status(401);
      throw new Error('Not authorized to update this report');
    }

    // Update image if new one is provided
    let imageUrl = report.imageUrl;
    if (req.file) {
      logInfo(req.requestId, 'IMAGE', 'Starting new image upload to Cloudinary');
      const result = await uploadImage(req.file.buffer, 'ecowatch/reports');
      imageUrl = result.secure_url;
      logInfo(req.requestId, 'IMAGE', `New upload completed: ${imageUrl}`);
    }

    report.title = title || report.title;
    report.category = category || report.category;
    report.description = description || report.description;
    report.latitude = latitude || report.latitude;
    report.longitude = longitude || report.longitude;
    report.imageUrl = imageUrl;

    const updatedReport = await report.save();

    logInfo(req.requestId, 'DATABASE', `Report updated: ${updatedReport.reportId}`);
    res.json(updatedReport);
  } catch (error) {
    next(error);
  }
};

// @desc    Delete a report
// @route   DELETE /api/reports/:id
// @access  Private
const deleteReport = async (req, res, next) => {
  try {
    logInfo(req.requestId, 'REPORT', `Delete request for report: ${req.params.id}`);

    const report = await Report.findById(req.params.id);

    if (!report) {
      res.status(404);
      throw new Error('Report not found');
    }

    // Check ownership
    if (report.residentId !== req.resident.residentId) {
      res.status(401);
      throw new Error('Not authorized to delete this report');
    }

    await report.deleteOne();

    logInfo(req.requestId, 'DATABASE', `Report deleted: ${report.reportId}`);
    res.json({ message: 'Report removed' });
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

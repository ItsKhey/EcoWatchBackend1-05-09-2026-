const mongoose = require('mongoose');
const Report = require('../models/Report');
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
    const filters = { residentId: req.resident.residentId };
    const notDeleted = { $or: [{ isDeleted: false }, { isDeleted: { $exists: false } }] };
    const completedOrDenied = { status: { $in: ['Completed', 'Denied'] } };
    const effectiveArchived = {
      $or: [
        { isArchived: true },
        { isArchived: { $exists: false }, ...completedOrDenied },
      ],
    };
    const notArchived = {
      $nor: [effectiveArchived],
    };

    if (view === 'archive') {
      filters.$and = [notDeleted];
      filters.$or = effectiveArchived.$or;
    } else if (view === 'trash') {
      filters.isDeleted = true;
    } else if (view === 'default') {
      filters.$and = [notDeleted, notArchived];
      filters.status = 'Pending';
    } else if (view !== 'all') {
      res.status(400);
      throw new Error('Invalid report view. Use default, archive, trash, or all');
    }

    const reports = await Report.find(filters).sort({ createdAt: -1 }).lean();
    const normalizedReports = reports.map((report) => ({
      ...report,
      isDeleted: report.isDeleted ?? false,
      deletedAt: report.deletedAt ?? null,
      isArchived: report.isArchived ?? ['Completed', 'Denied'].includes(report.status),
    }));
    res.json(normalizedReports);
  } catch (error) {
    next(error);
  }
};

const findOwnedReport = async (id, residentId) => {
  const identifierQuery = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: id }, { reportId: id }] }
    : { reportId: id };

  return Report.findOne({ residentId, ...identifierQuery });
};

const updateOwnedReports = async (ids, residentId, update) => {
  const objectIds = ids.filter((id) => mongoose.isValidObjectId(id));
  const reportIds = ids.filter((id) => !mongoose.isValidObjectId(id));
  const identifiers = [];

  if (objectIds.length) {
    identifiers.push({ _id: { $in: objectIds } });
  }
  if (reportIds.length) {
    identifiers.push({ reportId: { $in: reportIds } });
  }

  if (!identifiers.length) {
    return 0;
  }

  const result = await Report.updateMany(
    { residentId, $or: identifiers },
    update
  );

  return result.modifiedCount;
};

const softDeleteReport = async (req, res, next) => {
  try {
    const report = await findOwnedReport(req.params.id, req.resident.residentId);

    if (!report) {
      res.status(404);
      throw new Error('Report not found');
    }

    const deletedAt = req.body.deletedAt === undefined
      ? new Date()
      : new Date(req.body.deletedAt);

    if (Number.isNaN(deletedAt.getTime())) {
      res.status(400);
      throw new Error('deletedAt must be a valid timestamp');
    }

    report.isDeleted = true;
    report.deletedAt = deletedAt;
    await report.save();
    res.json(report);
  } catch (error) {
    next(error);
  }
};

const restoreReport = async (req, res, next) => {
  try {
    const report = await findOwnedReport(req.params.id, req.resident.residentId);

    if (!report) {
      res.status(404);
      throw new Error('Report not found');
    }

    report.isDeleted = false;
    report.deletedAt = null;
    await report.save();
    res.json(report);
  } catch (error) {
    next(error);
  }
};

const archiveReport = async (req, res, next) => {
  try {
    const report = await findOwnedReport(req.params.id, req.resident.residentId);

    if (!report) {
      res.status(404);
      throw new Error('Report not found');
    }

    report.isArchived = true;
    await report.save();
    res.json(report);
  } catch (error) {
    next(error);
  }
};

const bulkUpdateReports = (update, message) => async (req, res, next) => {
  try {
    const ids = req.body;

    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || !id.trim())) {
      res.status(400);
      throw new Error('Request body must be a non-empty array of report IDs');
    }

    const modifiedCount = await updateOwnedReports(ids, req.resident.residentId, update);
    res.json({ message, modifiedCount });
  } catch (error) {
    next(error);
  }
};

const bulkSoftDeleteReports = bulkUpdateReports(
  { $set: { isDeleted: true }, $currentDate: { deletedAt: true } },
  'Reports moved to trash'
);

const bulkRestoreReports = bulkUpdateReports(
  { $set: { isDeleted: false, deletedAt: null } },
  'Reports restored'
);

const bulkArchiveReports = bulkUpdateReports(
  { $set: { isArchived: true } },
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

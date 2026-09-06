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
    const reports = await Report.find({ residentId: req.resident.residentId }).sort({ createdAt: -1 });
    res.json(reports);
  } catch (error) {
    next(error);
  }
};

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
};

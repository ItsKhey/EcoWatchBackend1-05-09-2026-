const Report = require('../models/Report');
const { generateReportId } = require('../utils/generateId');
const { uploadImage } = require('../services/cloudinaryService');
const { logInfo, logError } = require('../utils/logger');

// @desc    Create a new report
// @route   POST /api/reports
// @access  Private
const createReport = async (req, res, next) => {
  const {
  title,
  category,
  description,
  latitude,
  longitude} = req.body;

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
    title: title.trim(),
    category: category.trim(),
    description: description.trim(),
    latitude: Number(latitude),
    longitude: Number(longitude),
    imageUrl: result.secure_url
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

module.exports = {
  createReport,
  getMyReports,
};

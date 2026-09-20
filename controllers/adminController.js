const Report = require('../models/Report');
const Notification = require('../models/Notification');
const History = require('../models/History');
const Resident = require('../models/Resident');
const { generateResidentId } = require('../utils/generateId');

// @desc    Get all reports for admin
// @route   GET /api/admin/reports
// @access  Private/Admin
const getAllReports = async (req, res, next) => {
  try {
    const reports = await Report.find({}).sort({ createdAt: -1 });
    res.json(reports);
  } catch (error) {
    next(error);
  }
};

// @desc    Assign personnel to a report
// @route   POST /api/admin/reports/:id/assign
// @access  Private/Admin
const assignPersonnel = async (req, res, next) => {
  const { assignedPersonnelIds, priority, handledById } = req.body;

  try {
    const report = await Report.findById(req.params.id);
    if (!report) {
      res.status(404);
      throw new Error('Report not found');
    }

    report.assignedPersonnelIds = assignedPersonnelIds;
    report.priority = priority || report.priority;
    report.handledById = handledById;
    report.status = 'Assigned';

    const updatedReport = await report.save();

    // Notify personnel
    for (const pId of assignedPersonnelIds) {
      await Notification.create({
        residentId: pId,
        title: 'New Task Assigned',
        message: `You have been assigned to report: ${report.title}`,
        type: 'TASK_ASSIGNED',
      });
    }

    // Log to history
    await History.create({
      residentId: report.residentId,
      reportId: report.reportId,
      action: 'ASSIGNED',
      oldStatus: 'Pending',
      newStatus: 'Assigned',
      description: `Report assigned to ${assignedPersonnelIds.length} personnel with ${priority} priority.`,
    });

    res.json(updatedReport);
  } catch (error) {
    next(error);
  }
};

// @desc    Get all personnel
// @route   GET /api/admin/personnel
// @access  Private/Admin
const getPersonnel = async (req, res, next) => {
  try {
    const personnel = await Resident.find({ role: 'Environmental Services Personnel' });
    res.json(personnel);
  } catch (error) {
    next(error);
  }
};

// @desc    Create personnel account
// @route   POST /api/admin/create-personnel
// @access  Private/Admin
const createPersonnel = async (req, res, next) => {
  const { firstName, lastName, username, email, password, phoneNumber } = req.body;

  try {
    const userExists = await Resident.findOne({ username });
    if (userExists) {
      res.status(400);
      throw new Error('Username is already taken');
    }

    const personnel = await Resident.create({
      residentId: generateResidentId(),
      firstName,
      lastName,
      username,
      email,
      password,
      phoneNumber,
      role: 'Environmental Services Personnel',
      isVerified: true,
      createdById: req.resident.residentId,
    });

    res.status(201).json({
      success: true,
      message: 'Personnel account created successfully',
      personnel: {
        residentId: personnel.residentId,
        username: personnel.username,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Approve a report completion
// @route   POST /api/admin/reports/:id/approve
// @access  Private/Admin
const approveReportCompletion = async (req, res, next) => {
  try {
    const report = await Report.findById(req.params.id);
    if (!report) {
      res.status(404);
      throw new Error('Report not found');
    }

    const oldStatus = report.status;
    report.status = 'Completed';
    report.resolvedAt = new Date().toISOString();
    await report.save();

    await Notification.create({
      residentId: report.residentId,
      title: 'Report Completed',
      message: `Your waste report has been completed. ID: ${report.reportId}`,
      type: 'REPORT_UPDATE'
    });

    await History.create({
      residentId: report.residentId,
      reportId: report.reportId,
      action: 'COMPLETED',
      oldStatus: oldStatus,
      newStatus: 'Completed',
      description: `Admin approved cleanup for report '${report.title}'.`
    });

    res.json({ message: 'Report completion approved and notification sent.' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllReports,
  assignPersonnel,
  getPersonnel,
  createPersonnel,
  approveReportCompletion,
};

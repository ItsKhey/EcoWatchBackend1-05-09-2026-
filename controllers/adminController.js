const Report = require('../models/Report');
const Notification = require('../models/Notification');
const History = require('../models/History');

// @desc    Approve a report completion (Simulating Admin action)
// @route   POST /api/admin/reports/:id/approve
// @access  Public (Should be restricted in production)
const approveReportCompletion = async (req, res, next) => {
  try {
    const report = await Report.findById(req.params.id);
    if (!report) {
      res.status(404);
      throw new Error('Report not found');
    }

    const oldStatus = report.status;
    report.status = 'Completed';
    await report.save();

    // 1. Create Notification for the Resident
    await Notification.create({
      residentId: report.residentId,
      title: 'Report Completed',
      message: `Your waste report has been completed. ID: ${report.reportId}`,
      type: 'REPORT_UPDATE'
    });

    // 2. Log to History
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

// @desc    Update report status and admin response
// @route   PATCH /api/admin/reports/:id/status
// @access  Public (Should be restricted in production)
const updateReportStatus = async (req, res, next) => {
  const { status, adminResponse } = req.body;

  try {
    const report = await Report.findById(req.params.id);
    if (!report) {
      res.status(404);
      throw new Error('Report not found');
    }

    // Validation for In Progress and Denied
    if ((status === 'In Progress' || status === 'Denied') && !adminResponse) {
      res.status(400);
      throw new Error(`Admin response is required when status is ${status}`);
    }

    const oldStatus = report.status;
    report.status = status || report.status;
    if (adminResponse !== undefined) {
      report.adminResponse = adminResponse;
    }

    await report.save();

    // Notification and History for major status changes
    if (status === 'In Progress' || status === 'Denied' || status === 'Completed') {
      let title = 'Report Update';
      let message = `Your waste report status is now: ${status}.`;
      let action = 'STATUS_CHANGED';

      if (status === 'In Progress') {
        title = 'Report In Progress';
        message = `Your waste report has been reviewed and assigned for cleanup. Status: In Progress.`;
      } else if (status === 'Denied') {
        title = 'Report Denied';
        message = `Your waste report was reviewed but could not be approved. Reason: ${adminResponse}`;
      } else if (status === 'Completed') {
        title = 'Report Completed';
        message = `Your waste report has been completed. ID: ${report.reportId}`;
        action = 'COMPLETED';
      }

      await Notification.create({
        residentId: report.residentId,
        title,
        message,
        type: 'REPORT_UPDATE'
      });

      await History.create({
        residentId: report.residentId,
        reportId: report.reportId,
        action,
        oldStatus,
        newStatus: status,
        description: `Admin updated report status to '${status}'. ${adminResponse ? 'Remarks: ' + adminResponse : ''}`
      });
    }

    res.json(report);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  approveReportCompletion,
  updateReportStatus
};

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

module.exports = {
  approveReportCompletion
};

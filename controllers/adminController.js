const reportRepository =
  require('../repositories/reportRepository');

const notificationRepository =
  require('../repositories/notificationRepository');

const historyRepository =
  require('../repositories/historyRepository');

const residentRepository =
  require('../repositories/residentRepository');

const { generateResidentId } =
  require('../utils/generateId');

// @desc    Get all reports for admin
// @route   GET /api/admin/reports
// @access  Private/Admin
const getAllReports = async (req, res, next) => {
  try {
    const reports = await reportRepository.findAll();

    res.json(reports);
  } catch (error) {
    next(error);
  }
};

// @desc    Assign personnel to a report
// @route   POST /api/admin/reports/:id/assign
// @access  Private/Admin
const assignPersonnel = async (req, res, next) => {
  const {
    assignedPersonnelIds,
    priority,
    handledById
  } = req.body;

  try {
    const report =
      await reportRepository.findByReportId(
        req.params.id
      );

    if (!report) {
      res.status(404);
      throw new Error('Report not found');
    }

    const oldStatus = report.status;

    const updatedReport =
      await reportRepository.updateReport(
        report.report_id,
        {
          assignedPersonnelIds:
            assignedPersonnelIds || [],

          priority:
            priority || report.priority,

          handledById:
            handledById || null,

          status: 'In Progress'
        }
      );

    // Notify assigned personnel
    for (const pId of assignedPersonnelIds || []) {
      await notificationRepository.createNotification({
        residentId: pId,
        reportId: report.report_id,
        title: 'New Task Assigned',
        message:
          `You have been assigned to report: ${report.title}`,
      });
    }

    // Log history
    await historyRepository.createHistory({
      residentId: report.resident_id,
      reportId: report.report_id,
      action: 'ASSIGNED',
      oldStatus,
      newStatus: 'In Progress',
      description:
        `Report assigned to ${
          (assignedPersonnelIds || []).length
        } personnel with ${
          priority || report.priority
        } priority.`,
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
    const personnel =
      await residentRepository.findByRole(
        'Environmental Services Personnel'
      );

    res.json(personnel);
  } catch (error) {
    next(error);
  }
};

// @desc    Create personnel account
// @route   POST /api/admin/create-personnel
// @access  Private/Admin
const createPersonnel = async (req, res, next) => {
  const {
    firstName,
    lastName,
    username,
    email,
    password,
    phoneNumber
  } = req.body;

  try {
    const userExists =
      await residentRepository.findByUsername(
        username
      );

    if (userExists) {
      res.status(400);
      throw new Error('Username is already taken');
    }

    /*
     * PASSWORD HASHING
     *
     * Do not insert the raw password here.
     *
     * We need to use the same password-hashing
     * mechanism currently used by the resident
     * registration/authentication system.
     */

    throw new Error(
      'Personnel creation migration requires the existing password hashing implementation.'
    );

  } catch (error) {
    next(error);
  }
};

// @desc    Approve a report completion
// @route   POST /api/admin/reports/:id/approve
// @access  Private/Admin
const approveReportCompletion = async (
  req,
  res,
  next
) => {
  try {
    const report =
      await reportRepository.findByReportId(
        req.params.id
      );

    if (!report) {
      res.status(404);
      throw new Error('Report not found');
    }

    const oldStatus = report.status;

    await reportRepository.updateReport(
      report.report_id,
      {
        status: 'Completed',
        resolvedAt: new Date()
      }
    );

    await notificationRepository.createNotification({
      residentId: report.resident_id,
      reportId: report.report_id,
      title: 'Report Completed',
      message:
        `Your waste report has been completed. ID: ${report.report_id}`
    });

    await historyRepository.createHistory({
      residentId: report.resident_id,
      reportId: report.report_id,
      action: 'COMPLETED',
      oldStatus,
      newStatus: 'Completed',
      description:
        `Admin approved cleanup for report '${report.title}'.`
    });

    res.json({
      message:
        'Report completion approved and notification sent.'
    });

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

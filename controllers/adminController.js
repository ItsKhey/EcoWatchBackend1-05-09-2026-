const bcrypt = require('bcryptjs');

const reportRepository =
  require('../repositories/reportRepository');

const notificationRepository =
  require('../repositories/notificationRepository');

const historyRepository =
  require('../repositories/historyRepository');

const personnelController =
  require('./personnelController');

const {
  assignPersonnelToReport,
  completePersonnelReport,
} = require('../services/reportAssignmentService');

const {
  findByIdentifier,
  findByAdminId,
  touchLastActive,
} = require('../repositories/adminRepository');

const {
  PERSONNEL_ID_PATTERN,
  ASSIGNMENT_ID_PATTERN,
  createHttpError,
} = require('../utils/personnelValidation');

const generateToken = require('../utils/generateToken');

const mapAdminAccount = (admin) => ({
  adminId: admin.admin_id,
  firstName: admin.first_name,
  lastName: admin.last_name,
  username: admin.username,
  email: admin.email,
  address: admin.address || '',
  profileImage: admin.profile_image || '',
  role: admin.role || 'ADMIN',
  status: admin.status || 'AVAILABLE',
  phoneNumber: admin.phone_number || '',
  createdAt: admin.created_at || null,
  updatedAt: admin.updated_at || null,
  // updated_at is a safe server-owned fallback during a rolling migration
  // before last_active is populated for an existing account.
  lastActive: admin.last_active || admin.updated_at || admin.created_at || null,
});

// @desc    Authenticate an admin
// @route   POST /api/admin/login
// @access  Public
const loginAdmin = async (req, res, next) => {
  const { username, password } = req.body;

  try {
    const identifier = username?.trim();
    const admin = await findByIdentifier(identifier);

    if (
      !admin ||
      String(admin.role || '').toUpperCase() !== 'ADMIN' ||
      !await bcrypt.compare(password, admin.password_hash)
    ) {
      res.status(401);
      throw new Error('Invalid username or password');
    }

    let lastActive = admin.last_active || null;
    try {
      lastActive = await touchLastActive(admin.admin_id) || lastActive;
    } catch (activityError) {
      // A telemetry write must not prevent a valid administrator login.
      console.warn(`[AUTH] Unable to update admin activity: ${activityError.message}`);
    }

    const adminResponse = mapAdminAccount({
      ...admin,
      last_active: lastActive || admin.updated_at || admin.created_at || null,
    });
    res.json({
      success: true,
      token: generateToken(admin.admin_id, {
        role: admin.role,
        admin_id: admin.admin_id,
      }),
      admin: adminResponse,
      // Compatibility alias for older admin clients. New clients use admin.
      resident: {
        ...adminResponse,
        residentId: admin.admin_id,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get the authenticated administrator account
// @route   GET /api/admin/me
// @access  Private/Admin
const getCurrentAdmin = async (req, res, next) => {
  try {
    const adminId = req.admin?.admin_id;
    if (!adminId) {
      res.status(401);
      throw new Error('Not authorized as an administrator');
    }

    const admin = await findByAdminId(adminId);
    if (!admin) {
      res.status(404);
      throw new Error('Administrator account not found');
    }

    res.json({
      success: true,
      admin: mapAdminAccount(admin),
    });
  } catch (error) {
    next(error);
  }
};

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
  try {
    const {
      assignedPersonnelIds = [],
      priority,
      handledById: requestedHandlerId = null,
    } = req.body || {};

    if (!Array.isArray(assignedPersonnelIds)) {
      throw createHttpError(400, 'assignedPersonnelIds must be an array.');
    }

    if (assignedPersonnelIds.length > 50) {
      throw createHttpError(400, 'A report cannot be assigned to more than 50 personnel.');
    }

    const normalizedPersonnelIds = assignedPersonnelIds.map((personnelId) => {
      if (
        typeof personnelId !== 'string' ||
        !ASSIGNMENT_ID_PATTERN.test(personnelId.trim().toUpperCase())
      ) {
        throw createHttpError(
          400,
          'Every assigned personnel ID must use PERS-XXXX or legacy RES-XXXXXXXX format.'
        );
      }

      return personnelId.trim().toUpperCase();
    });

    const uniqueAssignmentIds = [...new Set(normalizedPersonnelIds)];
    if (
      requestedHandlerId !== undefined &&
      requestedHandlerId !== null &&
      typeof requestedHandlerId !== 'string'
    ) {
      throw createHttpError(400, 'handledById must be a PERS-XXXX string or null.');
    }

    const handledById =
      typeof requestedHandlerId === 'string' && requestedHandlerId.trim()
        ? requestedHandlerId.trim().toUpperCase()
        : null;

    // Admin clients intentionally omit handledById. When a personnel client
    // supplies it, it must identify a real personnel_accounts record.
    if (handledById && !PERSONNEL_ID_PATTERN.test(handledById)) {
      throw createHttpError(400, 'handledById must use the PERS-XXXX format.');
    }

    if (
      priority !== undefined &&
      (typeof priority !== 'string' || !priority.trim() || priority.length > 20)
    ) {
      throw createHttpError(400, 'priority must be a valid non-empty string.');
    }

    const report = await reportRepository.findByReportId(req.params.id);

    if (!report) {
      throw createHttpError(404, 'Report not found.');
    }

    const oldStatus = report.status;
    const adminId = req.resident.admin_id || req.resident.resident_id;
    const updatedReport = await assignPersonnelToReport({
      report,
      assignedPersonnelIds: uniqueAssignmentIds,
      priority: priority?.trim() || report.priority,
      handledById,
      updatedByAdminId: adminId,
    });

    for (const personnelId of uniqueAssignmentIds) {
      await notificationRepository.createNotification({
        residentId: personnelId,
        reportId: report.report_id,
        title: 'New Task Assigned',
        message: `You have been assigned to report: ${report.title}`,
      });
    }

    await historyRepository.createHistory({
      residentId: report.resident_id,
      reportId: report.report_id,
      action: 'ASSIGNED',
      oldStatus,
      newStatus: 'In Progress',
      description:
        `Report assigned to ${uniqueAssignmentIds.length} personnel with ${
          priority?.trim() || report.priority
        } priority.`,
    });

    res.json(updatedReport);
  } catch (error) {
    next(error);
  }
};

// Shared personnel handlers keep /api/admin/personnel and the original
// /api/admin/create-personnel alias on the same production implementation.
const getPersonnel = personnelController.listPersonnelLegacy;
const createPersonnel = personnelController.createPersonnel;

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
    const adminId = req.resident.admin_id || req.resident.resident_id;

    await completePersonnelReport({
      report,
      updatedByAdminId: adminId,
    });

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
  loginAdmin,
  getCurrentAdmin,
  getAllReports,
  assignPersonnel,
  getPersonnel,
  createPersonnel,
  approveReportCompletion,
};

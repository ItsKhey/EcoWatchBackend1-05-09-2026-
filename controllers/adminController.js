const bcrypt = require('bcryptjs');

const reportRepository =
  require('../repositories/reportRepository');

const notificationRepository =
  require('../repositories/notificationRepository');

const personnelController =
  require('./personnelController');

const {
  assignPersonnelToReport,
  reassignPersonnelToReport,
  unassignPersonnelFromReport,
  getReportAssignment,
  completePersonnelReport,
  mapAssignmentReport,
} = require('../services/reportAssignmentService');

const {
  findByIdentifier,
  findByAdminId,
  touchLastActive,
} = require('../repositories/adminRepository');

const {
  createHttpError,
} = require('../utils/personnelValidation');
const {
  normalizeReportId,
  validateReportAssignmentPayload,
} = require('../utils/reportAssignmentValidation');
const { logError } = require('../utils/logger');

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

const requireAdminActor = (req) => {
  // Assignment audit fields are derived exclusively from the authenticated
  // admin record, never from a compatibility profile or client identifier.
  const adminId = req.admin?.admin_id;
  if (!adminId) {
    throw createHttpError(403, 'Authenticated administrator identity is missing.');
  }

  return String(adminId);
};

const assignmentResponse = (result) => {
  const report = mapAssignmentReport(
    result.report,
    result.assignment
  );

  const assignment = result.assignment || report.assignment;
  return {
    ...report,
    success: true,
    report: {
      ...report,
      assignment,
    },
    assignment,
  };
};

const requireCanonicalAdminResponse = (payload) => {
  if (payload.canonicalPersonnelId && !payload.adminResponse) {
    throw createHttpError(400, 'adminResponse is required for an assignment.');
  }
};

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

    // Keep the historical raw array contract while adding canonical
    // assignment aliases used by the Phase 2B client.
    res.json(reports.map((report) => mapAssignmentReport(report)));
  } catch (error) {
    next(error);
  }
};

// @desc    Assign one active personnel account to a report
// @route   POST /api/admin/reports/:id/assign
// @access  Private/Admin
const assignPersonnel = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const payload = validateReportAssignmentPayload(req.body);
    requireCanonicalAdminResponse(payload);
    const result = await assignPersonnelToReport({
      reportId: normalizeReportId(req.params.id),
      assignedPersonnelIds: payload.assignedPersonnelIds,
      canonicalPersonnelId: payload.canonicalPersonnelId,
      handledById: payload.handledById,
      adminResponse: payload.adminResponse,
      priority: payload.priority,
      adminId,
    });

    res.json(assignmentResponse(result));
  } catch (error) {
    next(error);
  }
};

// @desc    Reassign a report to a different active personnel account
// @route   POST /api/admin/reports/:id/reassign
// @access  Private/Admin
const reassignPersonnel = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const payload = validateReportAssignmentPayload(req.body);
    requireCanonicalAdminResponse(payload);
    const result = await reassignPersonnelToReport({
      reportId: normalizeReportId(req.params.id),
      assignedPersonnelIds: payload.assignedPersonnelIds,
      canonicalPersonnelId: payload.canonicalPersonnelId,
      handledById: payload.handledById,
      adminResponse: payload.adminResponse,
      priority: payload.priority,
      adminId,
    });

    res.json(assignmentResponse(result));
  } catch (error) {
    next(error);
  }
};

// @desc    Get the current report assignment and personnel details
// @route   GET /api/admin/reports/:id/assignment
// @access  Private/Admin
const getAssignment = async (req, res, next) => {
  try {
    requireAdminActor(req);
    const result = await getReportAssignment({
      reportId: normalizeReportId(req.params.id),
    });

    res.json(assignmentResponse(result));
  } catch (error) {
    next(error);
  }
};

// @desc    Remove the current report assignment
// @route   POST /api/admin/reports/:id/unassign
// @access  Private/Admin
const unassignPersonnel = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const result = await unassignPersonnelFromReport({
      reportId: normalizeReportId(req.params.id),
      adminId,
    });

    res.json(assignmentResponse(result));
  } catch (error) {
    next(error);
  }
};

// DELETE is the explicit REST alias used by newer admin clients.
const deleteReportAssignment = unassignPersonnel;

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
    const adminId = requireAdminActor(req);
    const result = await completePersonnelReport({
      reportId: normalizeReportId(req.params.id),
      updatedByAdminId: adminId,
    });

    // Completion is already committed with its history audit. Notification
    // delivery is ancillary and must not turn a successful approval into a
    // false failure.
    try {
      await notificationRepository.createNotification({
        residentId: result.report.resident_id,
        reportId: result.report.report_id,
        title: 'Report Completed',
        message:
          `Your waste report has been completed. ID: ${result.report.report_id}`,
      });
    } catch (notificationError) {
      logError(
        req.requestId,
        'COMPLETION_NOTIFICATION',
        `Unable to notify resident ${result.report.resident_id}: ${notificationError.message}`
      );
    }

    res.json({
      success: true,
      message: 'Report completion approved.',
      report: mapAssignmentReport(result.report),
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
  reassignPersonnel,
  getAssignment,
  getReportAssignment: getAssignment,
  unassignPersonnel,
  deleteReportAssignment,
  getPersonnel,
  createPersonnel,
  approveReportCompletion,
};

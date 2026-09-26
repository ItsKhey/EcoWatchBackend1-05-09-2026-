const bcrypt = require('bcryptjs');

const reportRepository =
  require('../repositories/reportRepository');

const personnelController =
  require('./personnelController');

const {
  archiveReport,
  trashReport,
  restoreReport,
  deleteReport: permanentlyDeleteReport,
  bulkLifecycle,
  normalizeReport: normalizeAdminLifecycleReport,
} = require('../services/adminReportLifecycleService');

const {
  assignPersonnelToReport,
  reassignPersonnelToReport,
  unassignPersonnelFromReport,
  getReportAssignment,
  completePersonnelReport,
  mapAssignmentReport,
} = require('../services/reportAssignmentService');

const {
  updateReportAdminStatus,
  updateReportAdminResponse,
} = require('../services/reportStatusService');

const {
  findByIdentifier,
  findByAdminId,
  touchLastActive,
  claimFcmToken,
  clearFcmToken,
} = require('../repositories/adminRepository');

const {
  createHttpError,
} = require('../utils/personnelValidation');
const {
  normalizeReportId,
  validateReportAssignmentPayload,
} = require('../utils/reportAssignmentValidation');
const {
  validateStatusPayload,
  validateResponsePayload,
} = require('../utils/reportStatusValidation');

const generateToken = require('../utils/generateToken');
const { logInfo } = require('../utils/logger');

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
    requireAdminActor(req);
    const view = req.query.view ? String(req.query.view).trim().toLowerCase() : 'all';
    const allowedViews = new Set(['all', 'active', 'inbox', 'archive', 'archived', 'trash', 'trashed']);
    if (!allowedViews.has(view)) {
      throw createHttpError(400, 'Invalid report view. Use all, active, archive, or trash.');
    }

    const search = req.query.search ? String(req.query.search).trim() : null;
    if (search && (search.length > 100 || /[\u0000-\u001f\u007f]/.test(search))) {
      throw createHttpError(400, 'Search must be at most 100 characters and contain no control characters.');
    }
    const reports = typeof reportRepository.findAllForAdmin === 'function'
      ? await reportRepository.findAllForAdmin({ view, search })
      : await reportRepository.findAll();

    res.set('Cache-Control', 'no-store');
    // Keep the historical raw array contract while adding canonical
    // assignment aliases and lifecycle metadata used by the admin client.
    res.json(reports.map((report) => ({
      ...mapAssignmentReport(report),
      isDeleted: report.is_deleted === true,
      isArchived: report.is_archived === true || report.source_collection === 'archived_reports',
      isRestored: report.is_restored === true,
      sourceCollection: report.source_collection,
    })));
  } catch (error) {
    next(error);
  }
};

const lifecycleResponse = (result) => {
  const report = normalizeAdminLifecycleReport(result.report, result.source);
  return {
    success: true,
    report: {
      ...report,
      ...mapAssignmentReport(result.report),
    },
  };
};

const archiveAdminReport = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const result = await archiveReport({
      rawReportId: normalizeReportId(req.params.id),
      adminId,
    });
    res.json(lifecycleResponse(result));
  } catch (error) {
    next(error);
  }
};

const trashAdminReport = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const result = await trashReport({
      rawReportId: normalizeReportId(req.params.id),
      adminId,
    });
    res.json(lifecycleResponse(result));
  } catch (error) {
    next(error);
  }
};

const restoreAdminReport = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const result = await restoreReport({
      rawReportId: normalizeReportId(req.params.id),
      adminId,
    });
    res.json(lifecycleResponse(result));
  } catch (error) {
    next(error);
  }
};

const deleteAdminReport = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const result = await permanentlyDeleteReport({
      rawReportId: normalizeReportId(req.params.id),
      adminId,
    });
    res.json({
      success: true,
      message: 'Report permanently removed.',
      report: lifecycleResponse(result).report,
    });
  } catch (error) {
    next(error);
  }
};

const bulkAdminLifecycle = (action) => async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const result = await bulkLifecycle({
      ids: Array.isArray(req.body) ? req.body : req.body?.ids,
      action,
      adminId,
    });
    res.json({
      success: true,
      ...result,
      results: (result.results || []).map((entry) => lifecycleResponse(entry).report),
    });
  } catch (error) {
    next(error);
  }
};

const bulkArchiveAdminReports = bulkAdminLifecycle('archive');
const bulkTrashAdminReports = bulkAdminLifecycle('trash');
const bulkRestoreAdminReports = bulkAdminLifecycle('restore');
const bulkDeleteAdminReports = bulkAdminLifecycle('delete');

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
      requestId: req.requestId,
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
      requestId: req.requestId,
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
      requestId: req.requestId,
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

const updateReportStatus = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const payload = validateStatusPayload(req.body);
    const result = await updateReportAdminStatus({
      reportId: normalizeReportId(req.params.id),
      status: payload.status,
      adminResponse: payload.adminResponse,
      adminId,
      requestId: req.requestId,
    });
    res.json({
      success: true,
      message: 'Report status updated.',
      report: mapAssignmentReport(result.report),
      notificationsCreated: result.notifications.length,
    });
  } catch (error) {
    next(error);
  }
};

const updateReportResponse = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const payload = validateResponsePayload(req.body);
    const result = await updateReportAdminResponse({
      reportId: normalizeReportId(req.params.id),
      adminResponse: payload.adminResponse,
      adminId,
      requestId: req.requestId,
    });
    res.json({
      success: true,
      message: result.responseChanged
        ? 'Admin response updated.'
        : 'Admin response is already current.',
      report: mapAssignmentReport(result.report),
      notificationsCreated: result.notifications.length,
    });
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
    const adminId = requireAdminActor(req);
    const result = await completePersonnelReport({
      reportId: normalizeReportId(req.params.id),
      updatedByAdminId: adminId,
      requestId: req.requestId,
    });

    res.json({
      success: true,
      message: 'Report completion approved.',
      report: mapAssignmentReport(result.report),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Phase 3A — binds this device's FCM token to the authenticated administrator
 * so NEW_REPORT broadcasts are delivered. The administrator identity comes only
 * from the verified token, never from the request body.
 */
const registerAdminFcmToken = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const forbidden = ['adminId', 'admin_id', 'residentId', 'resident_id']
      .filter((key) => Object.prototype.hasOwnProperty.call(req.body || {}, key));
    if (forbidden.length) {
      throw createHttpError(
        400,
        `Administrator identity is server-owned; remove: ${forbidden.join(', ')}.`
      );
    }

    const token = String(req.body?.token || req.body?.fcmToken || '').trim();
    if (
      token.length < 20
      || token.length > 4096
      || /[\s\u0000-\u001F\u007F]/.test(token)
    ) {
      throw createHttpError(400, 'A valid FCM registration token is required.');
    }

    const claimed = await claimFcmToken(adminId, token);
    if (!claimed) throw createHttpError(404, 'Administrator account not found.');

    logInfo(req.requestId, 'ADMIN_FCM_TOKEN', `Token registered for admin ${adminId}`);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

/** Releases the device token so a later login can rebind it. */
const clearAdminFcmToken = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    await clearFcmToken(adminId);
    logInfo(req.requestId, 'ADMIN_FCM_TOKEN', `Token cleared for admin ${adminId}`);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
};

module.exports = {
  loginAdmin,
  getCurrentAdmin,
  registerAdminFcmToken,
  clearAdminFcmToken,
  getAllReports,
  archiveAdminReport,
  trashAdminReport,
  restoreAdminReport,
  deleteAdminReport,
  bulkArchiveAdminReports,
  bulkTrashAdminReports,
  bulkRestoreAdminReports,
  bulkDeleteAdminReports,
  assignPersonnel,
  reassignPersonnel,
  getAssignment,
  getReportAssignment: getAssignment,
  unassignPersonnel,
  deleteReportAssignment,
  getPersonnel,
  createPersonnel,
  updateReportStatus,
  updateReportResponse,
  approveReportCompletion,
};

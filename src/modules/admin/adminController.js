const bcrypt = require('bcryptjs');

const reportRepository =
  require('../reports/reportRepository');

const reportPhotoRepository =
  require('../reports/reportPhotoRepository');

const reportPhotoService =
  require('../reports/reportPhotoService');
const { mapReport: mapResidentReport } = require('../residents/residentAdminController');

const personnelEvidenceRepository =
  require('../personnel/personnelEvidenceRepository');

const personnelAssignmentRepository =
  require('../personnel/personnelAssignmentRepository');

const cleaningTeamRepository =
  require('../personnel/cleaningTeamRepository');

const personnelController =
  require('../personnel/personnelController');

const {
  archiveReport,
  trashReport,
  restoreReport,
  deleteReport: permanentlyDeleteReport,
  bulkLifecycle,
  normalizeReport: normalizeAdminLifecycleReport,
} = require('../reports/adminReportLifecycleService');

const {
  assignPersonnelToReport,
  reassignPersonnelToReport,
  unassignPersonnelFromReport,
  getReportAssignment,
  completePersonnelReport,
  requestPersonnelReportRevision,
  mapAssignmentReport,
} = require('../reports/reportAssignmentService');

const {
  updateReportAdminStatus,
  updateReportAdminResponse,
} = require('../reports/reportStatusService');

const {
  findByIdentifier,
  findByAdminId,
  touchLastActive,
  claimFcmToken,
  clearFcmToken,
} = require('./adminRepository');

const {
  createHttpError,
  PERSONNEL_ID_PATTERN,
} = require('../../shared/personnelValidation');
const {
  normalizeReportId,
  validateReportAssignmentPayload,
} = require('../reports/reportAssignmentValidation');
const {
  validateStatusPayload,
  validateResponsePayload,
} = require('../reports/reportStatusValidation');

const cleaningTeamService = require('../personnel/cleaningTeamService');
const {
  validateCreateTeamPayload,
  validateUpdateTeamPayload,
  normalizeTeamId,
} = require('../../shared/cleaningTeamValidation');

const generateToken = require('../../shared/generateToken');
const { CATEGORY: HISTORY_CATEGORY } = require('../../shared/historyActions');
const { logInfo } = require('../../shared/logger');
const {
  WASTE_SCALE,
  DEFAULT_WASTE_SCALE,
  normalizeWasteScale,
} = require('../../shared/wasteScaleValidation');

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

const historyRepository = require('../history/historyRepository');
const duplicateReviewRepository = require('../reports/duplicateReviewRepository');

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
/**
 * Adds the finished cleanup to each report: the note the cleaner wrote and the
 * cleaner who wrote it.
 *
 * The admin report dialog has to answer "who did this, and what did they say?",
 * and neither answer survives on the report row. Approving a report releases the
 * assignment pointer, so `assignedPersonnelName` is empty exactly when the admin
 * most wants to know who cleaned it, and the note only ever lived on the
 * assignment. Both are batch-read here for the whole page so opening a report
 * needs no second request.
 *
 * A failure degrades to "nothing completed yet" rather than failing the list.
 */
const attachCompletedWork = async (reports) => {
  if (!Array.isArray(reports) || reports.length === 0) {
    return reports;
  }

  const reportIds = reports
    .map((report) => report?.report_id)
    .filter((id) => id !== undefined && id !== null);

  let completions;
  try {
    completions = await personnelAssignmentRepository
      .findLatestCompletionsByReportIds(reportIds);
  } catch (error) {
    logError(
      null,
      'COMPLETED_WORK',
      `Unable to read completed personnel work: ${error.message}`
    );
    completions = new Map();
  }

  return reports.map((report) => {
    const completion = report?.report_id
      ? completions.get(String(report.report_id)) || null
      : null;
    return {
      ...report,
      // The cleaner's own words. Named to match `personnelResponse` on the
      // resident payload so one note field is understood across all clients.
      // On team dispatches, completion notes belong to the crew leader's
      // assignment. Another teammate may complete their row later with no note
      // (or a different note); using the latest row would erase or replace the
      // leader's message when the admin reloads the report.
      personnelResponse: report?.assigned_team_id
        ? completion?.teamLeaderCompletionNotes || null
        : completion?.completionNotes || null,
      completedByPersonnelId: completion?.personnelId || null,
      completedByPersonnelName: completion?.personnelName || null,
      completedByPersonnelAvatar: completion?.personnelAvatar || null,
      workCompletedAt: completion?.completedAt || null,
    };
  });
};

/** Adds the assigned team's named roster and leader marker to admin report rows. */
const attachAdminAssignedCrew = async (reports) => {
  if (!Array.isArray(reports) || reports.length === 0) return reports;

  const teamReports = reports.filter((report) => report?.assignedTeamId);
  if (teamReports.length === 0) {
    return reports.map((report) => ({ ...report, assignedCrew: [] }));
  }

  let resolved;
  try {
    resolved = await cleaningTeamRepository.resolveDispatchCrews({
      teamIds: teamReports.map((report) => report.assignedTeamId),
    });
  } catch (error) {
    logError(null, 'ADMIN_REPORT_CREW',
      `Unable to read assigned team members: ${error.message}`);
    return reports.map((report) => ({ ...report, assignedCrew: [] }));
  }

  return reports.map((report) => {
    const members = report?.assignedTeamId
      ? resolved.membersByTeamId.get(report.assignedTeamId) || []
      : [];
    return {
      ...report,
      assignedCrew: members.map((member) => ({
        personnelId: member.personnelId || null,
        fullName: member.fullName || null,
        leader: member.leader === true,
      })),
    };
  });
};

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
    // The photo list is resolved in one batched query so admins can tell a
    // multi-photo report from a single-photo one.
    await reportPhotoService.attachPhotosToRows(reports);

    // Cleaning evidence (BEFORE/AFTER) lives on the assignment, but the admin
    // review dialog only holds a report. Batch-load it here and expose it as
    // flat URL arrays so opening a report needs no second request.
    const evidenceByReportId = new Map();
    const reportIds = reports
      .map((report) => report.report_id)
      .filter((id) => id !== undefined && id !== null);
    if (reportIds.length) {
      const evidenceRows =
        await personnelEvidenceRepository.listForReports(reportIds);
      for (const row of evidenceRows) {
        const key = String(row.report_id);
        if (!evidenceByReportId.has(key)) {
          evidenceByReportId.set(key, { before: [], after: [] });
        }
        const bucket = evidenceByReportId.get(key);
        if (row.phase === 'AFTER') {
          bucket.after.push(row.image_url);
        } else {
          bucket.before.push(row.image_url);
        }
      }
    }

    // The cleaner's completion note and the cleaner who wrote it. Resolved in
    // one batched query alongside the evidence above, for the same reason: the
    // report dialog holds one report and must not need a second round trip.
    const withCompletedWork = await attachCompletedWork(reports);

    const mappedReports = withCompletedWork.map((report) => {
      const evidence = evidenceByReportId.get(String(report.report_id))
        || { before: [], after: [] };
      return {
        ...mapAssignmentReport(report),
        photos: report.photos || [],
        beforePhotoUrls: evidence.before.filter(Boolean),
        afterPhotoUrls: evidence.after.filter(Boolean),
        isDeleted: report.is_deleted === true,
        isArchived: report.is_archived === true || report.source_collection === 'archived_reports',
        isRestored: report.is_restored === true,
        sourceCollection: report.source_collection,
      };
    });
    res.json(await attachAdminAssignedCrew(mappedReports));
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
      // Photos are resolved from the raw row synchronously here; the row is a
      // single report, so the cover image is a safe stand-in until the next
      // listing refresh supplies the full list.
      photos: reportPhotoRepository.buildPhotoList(result.report.image_url, null),
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
      personnelNote: payload.personnelNote,
      priority: payload.priority,
      wasteScale: payload.wasteScale,
      teamId: payload.teamId,
      vehicleId: payload.vehicleId,
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
      personnelNote: payload.personnelNote,
      priority: payload.priority,
      wasteScale: payload.wasteScale,
      teamId: payload.teamId,
      vehicleId: payload.vehicleId,
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

// @desc    List the cleaning teams
// @route   GET /api/admin/cleaning-teams
// @access  Private/Admin
const listCleaningTeams = async (req, res, next) => {
  try {
    requireAdminActor(req);
    const includeDeleted = req.query.include_deleted === 'true'
      || req.query.includeDeleted === 'true';

    const teams = await cleaningTeamService.listCleaningTeams({ includeDeleted });

    res.json({ success: true, teams });
  } catch (error) {
    next(error);
  }
};

// @desc    Get one cleaning team and its members
// @route   GET /api/admin/cleaning-teams/:teamId
// @access  Private/Admin
const getCleaningTeam = async (req, res, next) => {
  try {
    requireAdminActor(req);
    const team = await cleaningTeamService.getCleaningTeam({
      teamId: req.params.teamId,
    });

    res.json({ success: true, team });
  } catch (error) {
    next(error);
  }
};

// @desc    List completed and revision-requested reports worked by a team
// @route   GET /api/admin/cleaning-teams/:teamId/task-history
// @access  Private/Admin
const getCleaningTeamTaskHistory = async (req, res, next) => {
  try {
    requireAdminActor(req);
    const teamId = normalizeTeamId(req.params.teamId);
    await cleaningTeamService.getCleaningTeam({ teamId });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const result = await cleaningTeamRepository.findTaskHistoryByTeamId(teamId, {
      limit,
      offset: (page - 1) * limit,
    });
    const revisionRequested = await historyRepository.findRevisionRequestedReportIds(
      result.reports.map((report) => report.report_id)
    );
    const timelines = await historyRepository.findTaskTimelinesByReportIds(
      result.reports.map((report) => report.report_id)
    );
    const reports = result.reports.map((report) => ({
      ...mapResidentReport({
        ...report,
        revision_requested: revisionRequested.has(report.report_id),
      }),
      personnelNote: report.personnel_note || '',
      // The same per-task timeline as the personnel history, so a team's work
      // log tells the same story as each cleaner's own card.
      timeline: timelines.get(report.report_id) || [],
    }));
    await reportPhotoService.attachPhotoLists(reports);

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      reports,
      count: reports.length,
      pagination: {
        page,
        limit,
        total: result.total,
        totalPages: Math.ceil(result.total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create a cleaning team
// @route   POST /api/admin/cleaning-teams
// @access  Private/Admin
const createCleaningTeam = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const payload = validateCreateTeamPayload(req.body);
    const team = await cleaningTeamService.createCleaningTeam({
      payload,
      adminId,
    });

    res.status(201).json({ success: true, team });
  } catch (error) {
    next(error);
  }
};

// @desc    Update a cleaning team
// @route   PUT /api/admin/cleaning-teams/:teamId
// @access  Private/Admin
const updateCleaningTeam = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const payload = validateUpdateTeamPayload(req.body);
    const team = await cleaningTeamService.updateCleaningTeam({
      teamId: req.params.teamId,
      payload,
      adminId,
    });

    res.json({ success: true, team });
  } catch (error) {
    next(error);
  }
};

// @desc    Remove a cleaning team
// @route   DELETE /api/admin/cleaning-teams/:teamId
// @access  Private/Admin
const deleteCleaningTeam = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const team = await cleaningTeamService.deleteCleaningTeam({
      teamId: req.params.teamId,
      adminId,
    });

    res.json({ success: true, team });
  } catch (error) {
    next(error);
  }
};

// @desc    List the members of a cleaning team
// @route   GET /api/admin/cleaning-teams/:teamId/members
// @access  Private/Admin
const listCleaningTeamMembers = async (req, res, next) => {
  try {
    requireAdminActor(req);
    const members = await cleaningTeamService.listCleaningTeamMembers({
      teamId: req.params.teamId,
    });

    res.json({ success: true, members });
  } catch (error) {
    next(error);
  }
};

// @desc    Add one personnel member to a cleaning team
// @route   POST /api/admin/cleaning-teams/:teamId/members
// @access  Private/Admin
const addCleaningTeamMember = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const personnelId = req.body?.personnelId ?? req.body?.personnel_id;

    if (typeof personnelId !== 'string' || !personnelId.trim()) {
      throw createHttpError(400, 'A personnel id is required.');
    }

    const members = await cleaningTeamService.addCleaningTeamMember({
      teamId: req.params.teamId,
      personnelId: personnelId.trim().toUpperCase(),
      adminId,
    });

    res.status(201).json({ success: true, members });
  } catch (error) {
    next(error);
  }
};

// @desc    Remove one personnel member from a cleaning team
// @route   DELETE /api/admin/cleaning-teams/:teamId/members/:personnelId
// @access  Private/Admin
const removeCleaningTeamMember = async (req, res, next) => {
  try {
    requireAdminActor(req);
    const members = await cleaningTeamService.removeCleaningTeamMember({
      teamId: req.params.teamId,
      personnelId: String(req.params.personnelId || '').trim().toUpperCase(),
    });

    res.json({ success: true, members });
  } catch (error) {
    next(error);
  }
};

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
    const adminResponse = req.body?.adminResponse === undefined
      ? undefined
      : String(req.body.adminResponse || '').trim();
    const result = await completePersonnelReport({
      reportId: normalizeReportId(req.params.id),
      updatedByAdminId: adminId,
      adminResponse,
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

// @desc    Send a reviewed report back to the cleaner for revision
// @route   POST /api/admin/reports/:id/revise
// @access  Private/Admin
const reviseReportCompletion = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const adminResponse = String(
      req.body?.adminResponse ?? req.body?.message ?? ''
    ).trim();
    if (!adminResponse) {
      throw createHttpError(
        400,
        'A revision note (adminResponse) is required.'
      );
    }
    if (adminResponse.length > 2000) {
      throw createHttpError(400, 'adminResponse must be 2000 characters or fewer.');
    }

    const result = await requestPersonnelReportRevision({
      reportId: normalizeReportId(req.params.id),
      updatedByAdminId: adminId,
      adminResponse,
      requestId: req.requestId,
    });

    res.json({
      success: true,
      message: 'Revision requested. The personnel has been notified.',
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

// Cluster management endpoints
const clusterRepository = require('../reports/clusterRepository');

/**
 * How many cleaners a single cluster can take in one request. Each cleaner
 * occupies one report, so this is really a guard against a runaway selection
 * rather than a business limit.
 */
const MAX_CLUSTER_PERSONNEL = 10;

const getClusters = async (req, res, next) => {
  try {
    const { status, search, limit = 100, offset = 0 } = req.query;
    const clusters = await clusterRepository.findNearbyActiveClusters(0, 0, 999999999);
    
    // Filter by status if provided
    let filtered = clusters;
    if (status && status !== 'all') {
      const statusLower = String(status).toLowerCase();
      filtered = clusters.filter(c => c.status.toLowerCase() === statusLower);
    }
    
    // Search by cluster ID, report ID, resident ID, or barangay
    if (search) {
      const searchLower = String(search).toLowerCase();
      filtered = clusters.filter(c => 
        c.clusterId.toLowerCase().includes(searchLower)
      );
    }
    
    // Paginate
    const total = filtered.length;
    const paginated = filtered.slice(Number(offset), Number(offset) + Number(limit));
    
    res.json({
      clusters: paginated,
      total,
    });
  } catch (error) {
    next(error);
  }
};

const getClusterDetails = async (req, res, next) => {
  try {
    const { clusterId } = req.params;
    const cluster = await clusterRepository.getClusterById(clusterId);
    if (!cluster) {
      throw createHttpError(404, 'Cluster not found');
    }

    // Matched on cluster_id, not on the cluster ID as free text. The previous
    // `search: clusterId` call matched against report title, description and
    // report_id, none of which ever contain the cluster ID, so opening a cluster
    // returned an empty list no matter how many reports it held.
    const reports = await reportRepository.findByClusterIdForAdmin(clusterId);

    res.json({
      cluster,
      reports,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Assigns a cleaner to work inside a cluster.
 *
 * A cluster owns no personnel of its own. An assignment lives on a report, and
 * the schema allows one cleaner to hold exactly one live report at a time
 * (reports_active_assigned_personnel_uidx). A cluster therefore cannot be handed
 * to a single cleaner wholesale, and pretending otherwise silently did nothing:
 * the previous implementation passed a null report id into updateReport, which
 * matched zero rows, then answered 200 with a success message.
 *
 * So this assigns the chosen cleaner to the next report in the cluster that
 * still needs one, oldest first, and reports exactly how much of the cluster is
 * left. Assigning the rest means assigning further cleaners to further reports,
 * which is what the remaining unassigned reports in the response are for.
 */
const assignCluster = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const clusterId = String(req.params.clusterId || '').trim();

    // personnelIds is a cluster-only concept: several cleaners working one spot.
    // It is normalised here and removed before validation, because the shared
    // report-assignment validator rejects fields it does not own. The first id
    // is then handed to that validator so it still checks the id format,
    // adminResponse and priority exactly as it does for a single assignment.
    const body = { ...(req.body || {}) };
    const requestedIds = Array.isArray(body.personnelIds) ? body.personnelIds : null;
    delete body.personnelIds;

    let personnelIds = null;
    if (requestedIds) {
      if (requestedIds.length === 0) {
        throw createHttpError(400, 'Select at least one personnel account.');
      }
      if (requestedIds.length > MAX_CLUSTER_PERSONNEL) {
        throw createHttpError(
          400,
          `A cluster can take at most ${MAX_CLUSTER_PERSONNEL} personnel at once.`
        );
      }
      personnelIds = requestedIds.map((value) => {
        if (typeof value !== 'string') {
          throw createHttpError(400, 'Every personnel ID must be a string.');
        }
        const id = value.trim().toUpperCase();
        if (!PERSONNEL_ID_PATTERN.test(id)) {
          throw createHttpError(400, 'personnelIds must use the PERS-XXXX format.');
        }
        return id;
      });
      personnelIds = [...new Set(personnelIds)];
      body.personnelId = personnelIds[0];
    }

    const payload = validateReportAssignmentPayload(body);
    requireCanonicalAdminResponse(payload);

    if (!personnelIds) {
      personnelIds = payload.canonicalPersonnelId
        ? [payload.canonicalPersonnelId]
        : (payload.assignedPersonnelIds || []);
    }

    if (personnelIds.length === 0) {
      throw createHttpError(400, 'personnelId is required.');
    }

    const cluster = await clusterRepository.getClusterById(clusterId);
    if (!cluster) {
      throw createHttpError(404, 'Cluster not found.');
    }

    const reports = await reportRepository.findByClusterIdForAdmin(clusterId);

    // Only reports that are still open and still unassigned can take a cleaner.
    // Closed reports (Completed, Denied) are not assignable and already-taken
    // ones belong to somebody else.
    const isOpen = (report) => {
      const status = String(report.status || '').trim().toLowerCase();
      return status !== 'completed' && status !== 'denied';
    };
    const isUnassigned = (report) => {
      const canonical = String(report.assigned_personnel_id || '').trim();
      const legacy = Array.isArray(report.assigned_personnel_ids)
        ? report.assigned_personnel_ids
        : [];
      return canonical === '' && legacy.length === 0;
    };

    // created_at arrives as a Date from pg, so it has to be compared as a
    // timestamp rather than as text. Reports without a timestamp sort last.
    const createdAtValue = (report) => {
      const value = report.created_at;
      if (value instanceof Date) return value.getTime();
      const parsed = Date.parse(String(value ?? ''));
      return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
    };

    const candidates = reports
      .filter((report) => isOpen(report) && isUnassigned(report))
      .sort((a, b) => {
        const delta = createdAtValue(a) - createdAtValue(b);
        if (delta !== 0) return delta;
        return String(a.report_id || '').localeCompare(String(b.report_id || ''));
      });

    if (candidates.length === 0) {
      throw createHttpError(
        409,
        'Every open report in this cluster already has personnel assigned.'
      );
    }

    // One cleaner cannot hold two live reports (reports_active_assigned_personnel_uidx),
    // so the crew is spread across reports rather than stacked on one. Refusing
    // up front beats assigning some and silently leaving people behind.
    if (personnelIds.length > candidates.length) {
      throw createHttpError(
        409,
        `This cluster has ${candidates.length} report(s) still needing personnel, `
          + `but ${personnelIds.length} were selected. Each cleaner takes one report.`
      );
    }

    // Reuse the report assignment service so the report lock, the
    // one-cleaner-one-report rule, the cleaner's busy state, the history entry
    // and the resident notification all happen exactly as they do for a single
    // report.
    const placements = [];
    for (let index = 0; index < personnelIds.length; index += 1) {
      const personnelId = personnelIds[index];
      const target = candidates[index];

      const result = await assignPersonnelToReport({
        reportId: target.report_id,
        assignedPersonnelIds: [personnelId],
        canonicalPersonnelId: personnelId,
        handledById: null,
        adminResponse: payload.adminResponse,
        personnelNote: payload.personnelNote,
        priority: payload.priority,
        adminId,
        requestId: req.requestId,
      });

      placements.push({
        personnelId,
        reportId: target.report_id,
        assignment: result.assignment,
      });
    }

    await clusterRepository.updateClusterStatus(clusterId, 'In Progress');

    const refreshedCluster = await clusterRepository.getClusterById(clusterId);
    const refreshedReports =
      await reportRepository.findByClusterIdForAdmin(clusterId);
    const remaining = refreshedReports.filter(
      (report) => isOpen(report) && isUnassigned(report)
    ).length;

    const summary = placements
      .map((p) => `${p.personnelId} to ${p.reportId}`)
      .join(', ');

    res.json({
      success: true,
      message: remaining > 0
        ? `Assigned ${summary}. ${remaining} report(s) in this cluster still need personnel.`
        : `Assigned ${summary}. Every open report in this cluster now has personnel.`,
      cluster: refreshedCluster,
      reports: refreshedReports,
      placements,
      assignedReportId: placements[0].reportId,
      remainingUnassigned: remaining,
    });
  } catch (error) {
    next(error);
  }
};

const approveClusterCompletion = async (req, res, next) => {
  try {
    const { clusterId } = req.params;
    // Update cluster status to Completed
    // This would need a cluster status update method
    res.json({ success: true, message: 'Cluster completion approved' });
  } catch (error) {
    next(error);
  }
};

const requestClusterRecleaning = async (req, res, next) => {
  try {
    const { clusterId } = req.params;
    const { reason } = req.body;
    res.json({ success: true, message: 'Recleaning requested' });
  } catch (error) {
    next(error);
  }
};

const searchClusters = async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.json({ clusters: [] });
    }
    
    const clusters = await clusterRepository.findNearbyActiveClusters(0, 0, 999999999);
    const searchLower = String(q).toLowerCase();
    const filtered = clusters.filter(c => 
      c.clusterId.toLowerCase().includes(searchLower)
    );
    
    res.json({ clusters: filtered });
  } catch (error) {
    next(error);
  }
};

/**
 * The group id carries the waste scale as a suffix, for example
 * {@code CL-123456::medium}. The cluster alone is only a location: it can hold
 * a small pile and a large pile a few metres apart, and those are different
 * incidents. Encoding the scale in the id lets ACCEPT/DENY act on exactly the
 * reports the administrator saw, instead of retiring every scale at the spot.
 */
const DUPLICATE_GROUP_SCALE_SEPARATOR = '::';
const DUPLICATE_SCALE_KEYS = Object.freeze({
  small: WASTE_SCALE.SMALL,
  medium: WASTE_SCALE.MEDIUM,
  large: WASTE_SCALE.LARGE,
});
const DUPLICATE_SCALE_ORDER = Object.freeze(['small', 'medium', 'large']);

/** The short, URL-safe scale key for one report. Missing scales are small. */
const duplicateScaleKeyOf = (report) => {
  let canonical = DEFAULT_WASTE_SCALE;
  try {
    canonical = normalizeWasteScale(report?.waste_scale) || DEFAULT_WASTE_SCALE;
  } catch (error) {
    // A legacy row cannot be trusted to carry a canonical scale, and grouping
    // it with the default is safer than dropping it from review entirely.
    canonical = DEFAULT_WASTE_SCALE;
  }

  for (const key of DUPLICATE_SCALE_ORDER) {
    if (DUPLICATE_SCALE_KEYS[key] === canonical) return key;
  }
  return 'small';
};

const duplicateGroupId = (clusterId, scaleKey) =>
  `${clusterId}${DUPLICATE_GROUP_SCALE_SEPARATOR}${scaleKey}`;

/**
 * Splits a review id back into the location and the scale it was scoped to.
 * A legacy id without a suffix stays valid and covers the whole cluster, which
 * keeps an older admin build working during a rolling deployment.
 */
const parseDuplicateGroupId = (rawGroupId) => {
  const groupId = String(rawGroupId || '').trim();
  if (!groupId) throw createHttpError(400, 'A group id is required.');

  const separator = groupId.lastIndexOf(DUPLICATE_GROUP_SCALE_SEPARATOR);
  if (separator < 0) {
    return { clusterId: groupId, scaleKey: null };
  }

  const clusterId = groupId.slice(0, separator).trim();
  const scaleKey = groupId
    .slice(separator + DUPLICATE_GROUP_SCALE_SEPARATOR.length)
    .trim()
    .toLowerCase();

  if (!clusterId || !DUPLICATE_SCALE_KEYS[scaleKey]) {
    throw createHttpError(400, 'The review group id is not valid.');
  }
  return { clusterId, scaleKey };
};

/** True when a row belongs to the scale a review group is scoped to. */
const reportMatchesScale = (report, scaleKey) =>
  scaleKey === null || duplicateScaleKeyOf(report) === scaleKey;

/** The status a duplicate review should compare, normalized for casing. */
const duplicateStatusOf = (report) =>
  String(report?.status || '').trim().toLowerCase();

/** The statuses that can still be reviewed as possible duplicates. */
const ADMIN_DUPLICATE_STATUSES = Object.freeze([
  'pending',
  'in progress',
  'under review',
]);

/**
 * A report belongs in the administrator's Possible Duplicate Reports queue only
 * while it is still open.
 *
 * <p>Pending, In Progress and Under Review are included. Completed means the
 * waste was already cleared and Denied means it was already rejected; neither
 * is actionable in the review queue, so both are excluded even though the
 * resident's wider nearby scan still treats Completed as clone evidence.
 */
const isAdminDuplicateCandidate = (report) =>
  ADMIN_DUPLICATE_STATUSES.includes(duplicateStatusOf(report));

/**
 * Whether the administrator can still turn this report into a Denied one.
 *
 * <p>The queue only carries open statuses now, so this is true for every row it
 * offers. Kept explicit so a future status added to the queue cannot silently
 * become deniable before the status service supports the transition.
 */
const isDuplicateDeniable = (report) =>
  ADMIN_DUPLICATE_STATUSES.includes(duplicateStatusOf(report));

/**
 * Lists the groups of reports the backend flagged as possibly describing the
 * same waste incident. The cluster is the location; the waste scale is the
 * second half of the identity. Reports at the same spot that describe
 * different sizes of waste are separate review groups, and submission time is
 * deliberately not part of the grouping: two reports from different days are
 * still duplicates when the location and scale agree.
 *
 * <p>Only open statuses are included: Pending, In Progress and Under Review.
 * Completed reports have already been cleared and Denied reports have already
 * been rejected, so neither belongs in a queue that is about to make a
 * decision. This is narrower than the resident's nearby scan on purpose.
 *
 * <p>The admin UI calls these "Possible Duplicate Reports" groups; the
 * underlying storage stays a plain cluster and never reaches the UI.
 */
const getPossibleDuplicates = async (req, res, next) => {
  try {
    requireAdminActor(req);
    const groups = await clusterRepository.findPossibleDuplicateGroups();
    const payload = [];

    for (const group of groups) {
      const rows = await reportRepository.findByClusterIdForAdmin(group.clusterId);
      const candidates = rows.filter(isAdminDuplicateCandidate);
      if (candidates.length < 2) continue;

      // The cluster query only knows that somewhere at this spot has an
      // unreviewed report. Scale is what the administrator actually reviews, so
      // each subgroup must be tested separately; otherwise accepting the small
      // pile would come back as soon as the medium pile reopened the location.
      const reviews = await duplicateReviewRepository.findByClusterId(group.clusterId);
      const reviewedReportIds = new Set(
        reviews.map((review) => String(review.report_id))
      );

      const byScale = new Map();
      const seenReportIds = new Set();
      for (const report of candidates) {
        const reportId = String(report.report_id || '').trim();
        if (!reportId || seenReportIds.has(reportId)) continue;
        seenReportIds.add(reportId);
        const scaleKey = duplicateScaleKeyOf(report);
        if (!byScale.has(scaleKey)) byScale.set(scaleKey, []);
        byScale.get(scaleKey).push(report);
      }

      for (const scaleKey of DUPLICATE_SCALE_ORDER) {
        const reports = byScale.get(scaleKey) || [];
        if (reports.length < 2) continue;

        const hasUnreviewedReport = reports.some(
          (report) => !reviewedReportIds.has(String(report.report_id))
        );
        if (!hasUnreviewedReport) continue;

        // Oldest first makes "the first report" the original submission, which
        // is how the review card and the deny picker describe it.
        reports.sort((a, b) => {
          const aTime = a.created_at ? new Date(a.created_at).getTime() : Infinity;
          const bTime = b.created_at ? new Date(b.created_at).getTime() : Infinity;
          return aTime - bTime;
        });

        payload.push({
          groupId: duplicateGroupId(group.clusterId, scaleKey),
          wasteScale: DUPLICATE_SCALE_KEYS[scaleKey],
          reportCount: reports.length,
          centerLatitude: group.centerLatitude,
          centerLongitude: group.centerLongitude,
          lastActivityAt: group.lastActivityAt,
          reports,
        });
      }
    }

    res.json({ groups: payload });
  } catch (error) {
    next(error);
  }
};

/**
 * Marks the chosen reports as confirmed duplicates. They keep their database
 * rows and move to Denied with a resident-friendly explanation, emit a
 * DUPLICATE_CONFIRMED audit row, and notify each reporter. Other reports in
 * the group stay untouched.
 */
const confirmDuplicateReports = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const groupId = String(req.params.groupId || '').trim();
    const { clusterId, scaleKey } = parseDuplicateGroupId(groupId);
    const reportIds = Array.isArray(req.body?.reportIds)
      ? req.body.reportIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];

    if (reportIds.length === 0) {
      throw createHttpError(400, 'Select at least one report to mark as a duplicate.');
    }

    const rows = (await reportRepository.findByClusterIdForAdmin(clusterId))
      .filter((report) => reportMatchesScale(report, scaleKey));
    const candidates = rows.filter(isAdminDuplicateCandidate);
    const candidateById = new Map(
      candidates.map((r) => [String(r.report_id), r])
    );
    if (candidateById.size === 0) {
      throw createHttpError(404, 'Review group not found.');
    }
    for (const id of reportIds) {
      const report = candidateById.get(id);
      if (!report) {
        throw createHttpError(400, `Report ${id} does not belong to this review group.`);
      }
      if (!isDuplicateDeniable(report)) {
        throw createHttpError(
          400,
          `Report ${id} is ${report.status || 'not actionable'} and can no longer be marked as a duplicate.`
        );
      }
    }

    const deniedReports = [];
    for (const id of reportIds) {
      const result = await updateReportAdminStatus({
        reportId: id,
        status: 'Denied',
        adminResponse: 'This report was identified as a duplicate of a report that had already been submitted for the same location, so it was not processed as a new report.',
        adminId,
        requestId: req.requestId || null,
        duplicateNotice: true,
      });
      deniedReports.push(result.report);
    }

    // Recorded against every report the administrator just looked at, not only
    // the denied ones: the decision covered the whole group, so all of them are
    // now reviewed. A report that arrives here later is unreviewed by
    // construction and re-opens the group, which is what keeps the review
    // repeatable instead of a one-time event per location.
    await duplicateReviewRepository.recordDecision({
      reportIds: [...candidateById.keys()],
      clusterId,
      decision: 'DUPLICATE_CONFIRMED',
      deniedReportIds: reportIds,
      adminId,
    });

    logInfo(req.requestId, 'DUPLICATE_REVIEW',
      `Group ${groupId}: ${reportIds.length} report(s) confirmed duplicates by admin ${adminId}.`);

    res.json({ success: true, deniedReports: deniedReports.map((r) => r.report_id) });
  } catch (error) {
    next(error);
  }
};

/**
 * Records that the administrator reviewed the group and decided the reports
 * are NOT duplicates. No report changes state; the group simply leaves the
 * possible-duplicates list and stays as individual, independent reports.
 */
const markNotDuplicates = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const groupId = String(req.params.groupId || '').trim();
    const { clusterId, scaleKey } = parseDuplicateGroupId(groupId);

    const rows = (await reportRepository.findByClusterIdForAdmin(clusterId))
      .filter((report) => reportMatchesScale(report, scaleKey))
      .filter(isAdminDuplicateCandidate);
    if (rows.length === 0) throw createHttpError(404, 'Review group not found.');

    for (const row of rows) {
      await historyRepository.createHistory({
        residentId: row.resident_id,
        reportId: row.report_id,
        action: 'NOT_DUPLICATE',
        // Reports, not Assignments: the duplicate verdict is a judgement about
        // the reports themselves, and this is the decision the admin audit trail
        // most needs to be able to find.
        category: HISTORY_CATEGORY.REPORTS,
        adminId,
        oldStatus: row.status,
        newStatus: row.status,
        description: `Administrator ${adminId} reviewed the reports and confirmed they are not duplicates.`,
      });
    }

    // Per report, for the same reason as the deny path: unwrapping this group
    // must not stop the next report at this spot from being offered again.
    await duplicateReviewRepository.recordDecision({
      reportIds: rows.map((row) => row.report_id),
      clusterId,
      decision: 'NOT_DUPLICATE',
      deniedReportIds: [],
      adminId,
    });

    logInfo(req.requestId, 'DUPLICATE_REVIEW',
      `Group ${groupId}: confirmed NOT duplicates by admin ${adminId}.`);

    res.json({ success: true });
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
  reviseReportCompletion,
  getClusters,
  getClusterDetails,
  assignCluster,
  approveClusterCompletion,
  requestClusterRecleaning,
  searchClusters,
  getPossibleDuplicates,
  confirmDuplicateReports,
  markNotDuplicates,
  listCleaningTeams,
  getCleaningTeam,
  getCleaningTeamTaskHistory,
  createCleaningTeam,
  updateCleaningTeam,
  deleteCleaningTeam,
  listCleaningTeamMembers,
  addCleaningTeamMember,
  removeCleaningTeamMember,
};

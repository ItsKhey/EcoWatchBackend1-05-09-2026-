const bcrypt = require('bcryptjs');

const residentRepository = require('./residentRepository');
const reportRepository = require('../reports/reportRepository');
const historyRepository = require('../history/historyRepository');
const reportPhotoService = require('../reports/reportPhotoService');
const firebaseAuthService = require('../auth/firebaseAuthService');
const { createHttpError, requireObject, validatePassword } = require('../../shared/personnelValidation');
const {
  parseReportPageQuery,
  parseResidentListQuery,
  validateResidentId,
} = require('../../shared/residentValidation');
const { DISABLED_RESIDENT_STATUSES } = require('../../shared/residentAuth');
const { CATEGORY, SUBJECT_TYPE } = require('../../shared/historyActions');
const { logError, logInfo } = require('../../shared/logger');

const BCRYPT_ROUNDS = 12;

const requireAuthenticatedAdmin = (req) => {
  const adminId = req.admin?.admin_id;
  const role = String(req.admin?.role || '').toUpperCase();

  if (!adminId || role !== 'ADMIN') {
    throw createHttpError(403, 'Administrator access is required.');
  }

  return adminId;
};

const mapResident = (resident) => {
  const rawStatus = String(resident.status || 'AVAILABLE').trim();
  const normalizedStatus = rawStatus.toUpperCase();
  const disabled = DISABLED_RESIDENT_STATUSES.has(normalizedStatus)
    || resident.is_disabled === true
    || resident.enabled === false;
  const firstName = resident.first_name || '';
  const lastName = resident.last_name || '';

  const mapped = {
    residentId: resident.resident_id,
    serverId: resident.resident_id,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim() || 'Unnamed resident',
    username: resident.username || '',
    email: resident.email || '',
    address: resident.address || '',
    profileImage: resident.profile_image || '',
    profileImageUrl: resident.profile_image || '',
    role: resident.role || 'RESIDENT',
    status: rawStatus || 'AVAILABLE',
    accountStatus: disabled ? 'Disabled' : 'Active',
    isActive: !disabled,
    isDisabled: disabled,
    isVerified: resident.is_verified === true,
    phoneNumber: resident.phone_number || '',
    messengerLink: resident.messenger_link || '',
    lastActive: resident.last_active || null,
    dateCreated: resident.created_at || null,
    createdAt: resident.created_at || null,
    updatedAt: resident.updated_at || null,
    // Why an account is disabled, which the status alone cannot say. A reporter
    // who paused their own account can sign back in; one disabled here cannot,
    // because that is decided by the absence of the self-service marker.
    disabledAt: resident.disabled_at || null,
    disabledByResident: resident.disabled_by_resident === true,
    disabledByAdmin: !resident.disabled_by_resident && disabled,
    disabledByAdminId: resident.disabled_by_admin_id || null,
    totalReports: Number.isFinite(Number(resident.total_reports))
      ? Number(resident.total_reports)
      : 0,
  };
  mapped.reportCounts = { total: mapped.totalReports };
  return mapped;
};

const mapStatistics = (statistics) => ({
  total: Number(statistics?.total || 0),
  pending: Number(statistics?.pending || 0),
  inProgress: Number(statistics?.in_progress || 0),
  in_progress: Number(statistics?.in_progress || 0),
  completed: Number(statistics?.completed || 0),
  denied: Number(statistics?.denied || 0),
});

const mapReport = (report) => ({
  reportId: report.report_id,
  mongoId: report.report_id,
  residentId: report.resident_id,
  title: report.title || 'Untitled report',
  category: report.category || 'Uncategorized',
  description: report.description || '',
  latitude: report.latitude == null ? null : Number(report.latitude),
  longitude: report.longitude == null ? null : Number(report.longitude),
  imageUrl: report.image_url || '',
  photoUrl: report.image_url || '',
  status: report.status || 'Pending',
  // True only while this assignment cycle carries an administrator revision
  // request newer than the assignment. Clients must not infer it from
  // `personnelNote`, which also holds ordinary assignment instructions.
  revisionRequested: report.revision_requested === true,
  // Kept on historical report rows too: personnel, team, and vehicle logs
  // reuse this mapper before the Android detail dialog binds the scale.
  wasteScale: report.waste_scale || report.wasteScale || null,
  adminResponse: report.admin_response || '',
  assignedPersonnelIds: Array.isArray(report.assigned_personnel_ids)
    ? report.assigned_personnel_ids
    : [],
  assignedPersonnelId: report.assigned_personnel_id || null,
  assignedByAdminId: report.assigned_by_admin_id || null,
  assignedAt: report.assigned_at || null,
  priority: report.priority || 'Normal',
  isDeleted: report.is_deleted === true,
  deletedAt: report.deleted_at || null,
  isArchived: report.is_archived === true,
  isRestored: report.is_restored === true,
  createdAt: report.created_at || null,
  updatedAt: report.updated_at || null,
  handledById: report.handled_by_id || null,
  resolutionImageUrl: report.resolution_image_url || null,
  resolvedAt: report.resolved_at || null,
});

const findRequiredResident = async (rawResidentId) => {
  const residentId = validateResidentId(rawResidentId);
  const resident = await residentRepository.findPublicByResidentId(residentId);

  if (!resident) {
    throw createHttpError(404, 'Resident account not found.');
  }

  return resident;
};

const listResidents = async (req, res, next) => {
  try {
    requireAuthenticatedAdmin(req);
    const options = parseResidentListQuery(req.query);
    const [residents, total] = await Promise.all([
      residentRepository.findAllForAdmin(options),
      residentRepository.countAllForAdmin(options),
    ]);

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      residents: residents.map(mapResident),
      count: residents.length,
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        totalPages: Math.ceil(total / options.limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

const getResidentDetails = async (req, res, next) => {
  try {
    requireAuthenticatedAdmin(req);
    const resident = await findRequiredResident(req.params.residentId);
    const statistics = await reportRepository.getReportCountsByResidentId(
      resident.resident_id
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      resident: mapResident(resident),
      statistics: mapStatistics(statistics),
      // Alias retained for clients that call the aggregate block counts.
      counts: mapStatistics(statistics),
    });
  } catch (error) {
    next(error);
  }
};

const getResidentReports = async (req, res, next) => {
  try {
    requireAuthenticatedAdmin(req);
    const resident = await findRequiredResident(req.params.residentId);
    const options = parseReportPageQuery(req.query);
    const reportPage = await reportRepository.findPageForResident(
      resident.resident_id,
      options
    );
    const total = reportPage.total;
    const totalPages = Math.ceil(total / options.limit);

    res.set('Cache-Control', 'no-store');
    const revisionRequested = await historyRepository.findRevisionRequestedReportIds(
      reportPage.reports.map((report) => report.report_id)
    );
    const reports = reportPage.reports.map((report) => mapReport({
      ...report,
      revision_requested: revisionRequested.has(report.report_id),
    }));
    await reportPhotoService.attachPhotoLists(reports);
    res.json({
      success: true,
      reports,
      count: reportPage.reports.length,
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    next(error);
  }
};

const getResidentReportStatistics = async (req, res, next) => {
  try {
    requireAuthenticatedAdmin(req);
    const resident = await findRequiredResident(req.params.residentId);
    const statistics = await reportRepository.getReportCountsByResidentId(
      resident.resident_id
    );
    const mappedStatistics = mapStatistics(statistics);

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      statistics: mappedStatistics,
      counts: mappedStatistics,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Records a reporter account-management decision in the Admin History trail.
 *
 * Best-effort for the same reason as the personnel and announcement trails: the
 * account change is already committed and the administrator has seen it
 * accepted, so a failed audit write is logged rather than turned into a failed
 * action. The worst case is one missing row; the worst case of throwing would be
 * an account change the administrator believes was rolled back when it was not.
 */
const recordResidentHistory = async (residentId, {
  action,
  description,
  adminId,
  label = null,
  oldStatus = null,
  newStatus = null,
}) => {
  try {
    await historyRepository.createHistory({
      action,
      category: CATEGORY.ACCOUNT,
      subjectType: SUBJECT_TYPE.RESIDENT,
      subjectId: residentId,
      subjectLabel: label,
      adminId: adminId || null,
      oldStatus,
      newStatus,
      description,
    });
  } catch (error) {
    logError(
      null,
      'RESIDENT_HISTORY',
      `Resident ${residentId} was handled but its history record failed: ${error.message}`
    );
  }
};

/**
 * @desc    Reset a reporter's password
 * @route   POST /api/admin/residents/:residentId/reset-password
 * @access  Private/Admin
 *
 * The administrator chooses the new password and hands it over out of band, the
 * same contract as the personnel reset. Supabase is the authority and is
 * written first, so the reporter can sign in with the new password the moment
 * this returns; the Firebase identity is then re-aligned best-effort, and a
 * failure there is reported as a warning rather than as a failed reset. That is
 * the same ordering the emailed self-service reset uses, because a reset that
 * half-succeeded would leave a reporter who knows the new password locked out.
 *
 * An administrator resetting somebody else's credential is a decision with
 * consequences, so it is recorded in the Admin History trail without the
 * password itself, stating explicitly that it was not recorded.
 */
const resetResidentPassword = async (req, res, next) => {
  try {
    const adminId = requireAuthenticatedAdmin(req);
    const resident = await findRequiredResident(req.params.residentId);
    const body = requireObject(req.body);
    const password = validatePassword(body.newPassword ?? body.password, 'New password');

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const updated = await residentRepository.updatePassword(
      resident.resident_id,
      passwordHash
    );

    if (!updated) {
      throw createHttpError(404, 'Resident account not found.');
    }

    logInfo(
      req.requestId,
      'RESIDENT',
      `Reporter password reset: ${resident.resident_id} by ${adminId}`
    );

    let firebaseSynced = false;
    let warning = null;

    try {
      const identity = await firebaseAuthService.ensureIdentityForReset({
        email: resident.email,
        displayName: [resident.first_name, resident.last_name].filter(Boolean).join(' '),
        requestId: req.requestId,
      });

      await firebaseAuthService.overwriteIdentityPassword({
        uid: identity.uid,
        password,
        requestId: req.requestId,
      });
      firebaseSynced = true;
    } catch (error) {
      // Supabase already holds the new hash, so the reporter can log in. Firebase
      // only has to stay usable enough to deliver a future reset email, which
      // sync-firebase-password exists to repair.
      warning =
        'The EcoWatch password was changed, but the email service could not be updated. Contact your administrator if you need to reset it again.';
      logError(
        req.requestId,
        'FIREBASE_AUTH',
        `Supabase password updated for ${resident.resident_id} but Firebase sync failed: ${error.message}`
      );
    }

    await recordResidentHistory(resident.resident_id, {
      action: 'RESIDENT_PASSWORD_RESET',
      label: mapResident(updated).fullName,
      adminId,
      description: `Reporter account credentials reset for ${resident.resident_id}. `
        + 'The password itself is not recorded.',
    });

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      firebaseSynced,
      message: warning
        || 'Reporter password reset successfully.',
      resident: mapResident(updated),
      // Echoed so the administrator can read it back to the reporter. It was
      // chosen by this administrator, not derived from anything private, and the
      // request must be sent with no-store.
      temporaryPassword: password,
      ...(warning ? { warning } : {}),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Disable a reporter account
 * @route   PATCH /api/admin/residents/:residentId/disable
 * @access  Private/Admin
 *
 * A pause, not a deletion: the profile, reports, history and settings are all
 * preserved, exactly as they are for a resident's own self-service pause. The
 * difference is reversibility. This route deliberately does NOT set
 * `disabled_by_resident`, and the login path restores an account only when that
 * marker is true, so a reporter disabled here stays blocked no matter what
 * password they sign in with.
 *
 * Distinct from POST /api/auth/disable-account, which is mounted
 * `protect, protectResident` and therefore pauses the CALLER's own account.
 */
const disableResident = async (req, res, next) => {
  try {
    const adminId = requireAuthenticatedAdmin(req);
    const resident = await findRequiredResident(req.params.residentId);

    if (DISABLED_RESIDENT_STATUSES.has(String(resident.status || '').toUpperCase())) {
      throw createHttpError(409, 'This reporter account is already disabled.');
    }

    const updated = await residentRepository.disableResidentAccount(
      resident.resident_id,
      adminId
    );

    if (!updated) {
      throw createHttpError(409, 'This reporter account is already disabled.');
    }

    logInfo(
      req.requestId,
      'RESIDENT',
      `Reporter account disabled: ${resident.resident_id} by ${adminId}`
    );

    await recordResidentHistory(resident.resident_id, {
      action: 'RESIDENT_ACCOUNT_DISABLED',
      label: mapResident(updated).fullName,
      adminId,
      oldStatus: resident.status || null,
      newStatus: updated.status || 'DISABLED',
      description: `Reporter account disabled for ${resident.resident_id} by an administrator. `
        + 'Their profile, reports and history are preserved and cannot be restored by the reporter.',
    });

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      message:
        'Reporter account disabled. Their profile, reports and history are preserved.',
      resident: mapResident(updated),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Restore a reporter account
 * @route   PATCH /api/admin/residents/:residentId/enable
 * @access  Private/Admin
 *
 * The undo for disableResident, and the only way back: an administrator disable
 * deliberately leaves no self-service marker, so the reporter cannot restore
 * their own account by signing in.
 *
 * Restoring puts the account back to the same AVAILABLE state a resident's own
 * pause restore produces, so the two paths are indistinguishable afterwards and
 * a later login works normally.
 */
const enableResident = async (req, res, next) => {
  try {
    const adminId = requireAuthenticatedAdmin(req);
    const resident = await findRequiredResident(req.params.residentId);

    if (!DISABLED_RESIDENT_STATUSES.has(String(resident.status || '').toUpperCase())) {
      throw createHttpError(409, 'This reporter account is not disabled.');
    }

    const updated = await residentRepository.enableResidentAccount(
      resident.resident_id
    );

    if (!updated) {
      throw createHttpError(409, 'This reporter account is not disabled.');
    }

    logInfo(
      req.requestId,
      'RESIDENT',
      `Reporter account enabled: ${resident.resident_id} by ${adminId}`
    );

    await recordResidentHistory(resident.resident_id, {
      action: 'RESIDENT_ACCOUNT_ENABLED',
      label: mapResident(updated).fullName,
      adminId,
      oldStatus: resident.status || null,
      newStatus: updated.status || 'AVAILABLE',
      description: `Reporter account restored for ${resident.resident_id} by an administrator. `
        + 'They can sign in again with their existing credentials.',
    });

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      message:
        'Reporter account enabled. They can sign in again with their existing credentials.',
      resident: mapResident(updated),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Permanently delete a reporter account and every row it owns
 * @route   DELETE /api/admin/residents/:residentId
 * @access  Private/Admin
 *
 * Irreversible, and deliberately the most destructive route in this controller.
 * It reuses the same cascade the resident's own DELETE /api/auth/account uses, so
 * one implementation governs what "delete the account" means: the profile, every
 * report across the active, archived and trash collections, the report history,
 * the notifications, the uploaded photos released from Cloudinary, and any
 * outstanding password-reset codes all go together.
 *
 * There is no admin-side undo. `enableResident` restores a PAUSED account because
 * the rows are still there; after this route there is nothing left to restore, so
 * an accidental call needs a database restore, not another request.
 *
 * Distinct from DELETE /api/auth/account, which is mounted `protect,
 * protectResident` and deletes the CALLER's own account. An admin token must
 * never be able to reach somebody else's account through it.
 */
const deleteResident = async (req, res, next) => {
  try {
    const adminId = requireAuthenticatedAdmin(req);
    const resident = await findRequiredResident(req.params.residentId);

    // Read the name before the cascade, because afterwards there is no row left to
    // read it from. It is only used for the audit line.
    const deletedName = mapResident(resident).fullName;

    const deletedResidentId = await residentRepository.deleteResidentAccount(
      resident.resident_id
    );

    if (!deletedResidentId) {
      throw createHttpError(404, 'Resident account not found.');
    }

    logInfo(
      req.requestId,
      'RESIDENT',
      `Reporter account permanently deleted: ${deletedResidentId} (${deletedName}) by ${adminId}`
    );

    /*
     * The reporter's own history row is deleted by the cascade along with
     * everything else, so there is nowhere left to record this action against
     * them. Logging it above is what leaves an audit trail.
     */
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      message:
        'Reporter account and all of its data were deleted permanently. This cannot be undone.',
      residentId: deletedResidentId,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  listResidents,
  getResidentDetails,
  getResidentReports,
  getResidentReportStatistics,
  resetResidentPassword,
  disableResident,
  enableResident,
  deleteResident,
  mapResident,
  mapReport,
  mapStatistics,
};

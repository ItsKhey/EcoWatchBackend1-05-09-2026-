const { withTransaction } = require('../config/db');
const reportRepository = require('../repositories/reportRepository');
const personnelRepository = require('../repositories/personnelRepository');
const residentRepository = require('../repositories/residentRepository');
const historyRepository = require('../repositories/historyRepository');
const notificationRepository = require('../repositories/notificationRepository');
const {
  PERSONNEL_ID_PATTERN,
  createHttpError,
} = require('../utils/personnelValidation');
const { normalizeReportId } = require('../utils/reportAssignmentValidation');
const { logError } = require('../utils/logger');

const uniqueUpper = (values) => [
  ...new Set(
    (Array.isArray(values) ? values : [])
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean)
  ),
];

const parseLegacyAssignmentIds = (value) => {
  if (Array.isArray(value)) {
    return uniqueUpper(value);
  }

  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  const raw = value.trim();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return uniqueUpper(parsed);
    }
  } catch (error) {
    // A few old clients persisted a comma-separated string instead of JSON.
  }

  return uniqueUpper(raw.split(','));
};

const reportAssignmentIds = (report) => uniqueUpper([
  report.assigned_personnel_id,
  ...parseLegacyAssignmentIds(report.assigned_personnel_ids),
  report.handled_by_id,
]);

const personnelIds = (ids) =>
  ids.filter((id) => PERSONNEL_ID_PATTERN.test(id));

const legacyPersonnelIds = (ids) =>
  ids.filter((id) => !PERSONNEL_ID_PATTERN.test(id));

const canonicalPersonnelId = (report) => {
  if (typeof report.assigned_personnel_id === 'string') {
    const id = report.assigned_personnel_id.trim().toUpperCase();
    if (PERSONNEL_ID_PATTERN.test(id)) return id;
  }

  const ids = reportAssignmentIds(report);
  return ids.length === 1 && PERSONNEL_ID_PATTERN.test(ids[0])
    ? ids[0]
    : null;
};

const reportStatus = (report) =>
  String(report.status || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

const isReportActive = (report) =>
  report.is_deleted !== true && report.is_archived !== true;

const assertActiveReport = (report) => {
  if (!report) {
    throw createHttpError(404, 'Report not found.');
  }

  if (!isReportActive(report)) {
    throw createHttpError(
      409,
      'Only active reports can be assigned, reassigned, or unassigned.'
    );
  }
};

const assertAssignableStatus = (report) => {
  assertActiveReport(report);
  const status = reportStatus(report);
  if (status === 'completed' || status === 'denied') {
    throw createHttpError(
      409,
      `A report with status '${report.status}' cannot be assigned.`
    );
  }
};

const requireAdminId = (adminId) => {
  if (typeof adminId !== 'string' || !adminId.trim() || adminId.length > 50) {
    throw createHttpError(403, 'Authenticated administrator identity is missing.');
  }

  return adminId.trim();
};

const assignmentText = (report) => {
  const title = String(report.title || '').trim();
  return (title || `Report ${report.report_id}`).slice(0, 255);
};

const assignmentLocation = (report) => ({
  latitude: report.latitude ?? null,
  longitude: report.longitude ?? null,
});

const mapPersonnelDetails = (personnel) => {
  if (!personnel) return null;

  const location = personnel.current_assignment_location || null;
  return {
    personnelId: personnel.personnel_id,
    firstName: personnel.first_name || '',
    lastName: personnel.last_name || '',
    fullName: `${personnel.first_name || ''} ${personnel.last_name || ''}`.trim(),
    username: personnel.username || '',
    email: personnel.email || null,
    profileImage: personnel.profile_image || null,
    avatarUrl: personnel.profile_image || null,
    status: personnel.status || null,
    enabled: personnel.enabled === true,
    isDeleted: Boolean(personnel.deleted_at),
    isCleaning:
      personnel.is_cleaning === true
      || String(personnel.status || '').toUpperCase() === 'CLEANING',
    currentAssignment: personnel.current_assignment || null,
    location,
    assignedAt:
      personnel.current_assignment_assigned_at
      || personnel.personnel_assignment_assigned_at
      || null,
  };
};

const buildAssignmentDetails = (report, personnelById = new Map()) => {
  const ids = reportAssignmentIds(report);
  const assignedPersonnelId = canonicalPersonnelId(report);
  if (!assignedPersonnelId && ids.length === 0) return null;
  const primaryId = assignedPersonnelId || (ids.length === 1 ? ids[0] : null);
  let personnel = primaryId ? personnelById.get(primaryId) : null;

  if (!personnel && primaryId && report.assigned_personnel_first_name) {
    personnel = {
      personnel_id: primaryId,
      first_name: report.assigned_personnel_first_name,
      last_name: report.assigned_personnel_last_name,
      username: report.assigned_personnel_username,
      email: report.assigned_personnel_email,
      profile_image: report.assigned_personnel_profile_image || null,
      status: report.assigned_personnel_status,
      enabled: report.assigned_personnel_enabled,
      deleted_at: report.assigned_personnel_deleted_at,
      current_assignment: assignmentText(report),
      current_assignment_location: report.assigned_personnel_location
        || assignmentLocation(report),
      current_assignment_assigned_at:
        report.personnel_assignment_assigned_at || report.assigned_at,
    };
  }

  if (
    personnel &&
    assignedPersonnelId &&
    reportStatus(report) === 'in progress'
  ) {
    personnel = {
      ...personnel,
      is_cleaning: true,
      current_assignment: assignmentText(report),
      current_assignment_location:
        personnel.current_assignment_location || assignmentLocation(report),
      current_assignment_assigned_at:
        personnel.current_assignment_assigned_at || report.assigned_at,
    };
  }

  return {
    reportId: report.report_id,
    assignedPersonnelId: assignedPersonnelId || null,
    assignedPersonnelIds: ids,
    legacyPersonnelIds: legacyPersonnelIds(ids),
    assignedPersonnel: mapPersonnelDetails(personnel),
    assignedPersonnelName: personnel
      ? `${personnel.first_name || ''} ${personnel.last_name || ''}`.trim() || null
      : null,
    assignedPersonnelAvatar: personnel?.profile_image || null,
    assignedByAdminId: report.assigned_by_admin_id || null,
    assignedAt: report.assigned_at || null,
    adminResponse: report.admin_response || '',
    status: report.status || 'Pending',
    priority: report.priority || 'Normal',
  };
};

const mapAssignmentReport = (report, assignment = null) => {
  if (!report) return null;

  const ids = reportAssignmentIds(report);
  const assignedPersonnelId = canonicalPersonnelId(report);
  const resolvedAssignment = assignment || buildAssignmentDetails(report);
  return {
    ...report,
    reportId: report.report_id,
    mongoId: report.report_id,
    residentId: report.resident_id,
    assignedPersonnelId,
    assignedPersonnelIds: ids,
    assignedPersonnelName: resolvedAssignment?.assignedPersonnelName || null,
    assignedPersonnelAvatar: resolvedAssignment?.assignedPersonnelAvatar || null,
    assignedByAdminId: report.assigned_by_admin_id || null,
    assignedAt: report.assigned_at || null,
    adminResponse: report.admin_response || '',
    assignment: resolvedAssignment,
  };
};

const findLegacyPersonnelForAssignment = async (
  ids,
  client,
  { allowUnavailable = false, allowMissing = false } = {}
) => {
  if (!ids.length) return [];

  const rows = await residentRepository.findLegacyPersonnelByIds(ids, {
    queryable: client,
    lock: true,
  });
  const foundIds = new Set(rows.map((row) => String(row.resident_id).toUpperCase()));
  const missingIds = ids.filter((id) => !foundIds.has(id));

  if (missingIds.length && !allowMissing) {
    throw createHttpError(
      400,
      `Legacy personnel account is missing or is not a legacy Environmental Services Personnel record: ${missingIds.join(', ')}`
    );
  }

  const unavailableRows = rows.filter((row) => {
    const status = String(row.status || '').trim().toUpperCase();
    return row.deleted_at || ['DISABLED', 'DELETED', 'INACTIVE', 'SUSPENDED'].includes(status);
  });
  if (unavailableRows.length && !allowUnavailable) {
    throw createHttpError(
      409,
      `Legacy personnel account is disabled or deleted: ${unavailableRows
        .map((row) => row.resident_id)
        .join(', ')}`
    );
  }

  return rows;
};

const assertPersonnelCanReceiveAssignment = (personnel, reportId) => {
  if (!personnel) {
    throw createHttpError(404, 'Personnel account not found.');
  }

  if (
    personnel.role &&
    String(personnel.role).toUpperCase() !== 'PERSONNEL'
  ) {
    throw createHttpError(
      409,
      `Account ${personnel.personnel_id} is not a personnel account.`
    );
  }

  if (personnel.deleted_at || personnel.enabled !== true) {
    throw createHttpError(
      409,
      `Personnel account ${personnel.personnel_id} is disabled or deleted and cannot receive an assignment.`
    );
  }

  const currentReportId = personnel.current_assignment_report_id
    ? String(personnel.current_assignment_report_id).trim().toUpperCase()
    : null;
  const normalizedReportId = String(reportId).trim().toUpperCase();
  if (currentReportId && currentReportId !== normalizedReportId) {
    throw createHttpError(
      409,
      `Personnel account ${personnel.personnel_id} is already assigned to report ${currentReportId}.`
    );
  }

  // A cleaning flag or legacy text without a report reference is treated as
  // busy rather than overwritten, because it may represent work started by
  // an older client whose report pointer was lost.
  if (
    !currentReportId &&
    (personnel.is_cleaning === true || personnel.current_assignment)
  ) {
    throw createHttpError(
      409,
      `Personnel account ${personnel.personnel_id} is already marked busy.`
    );
  }

  if (
    !currentReportId &&
    String(personnel.status || '').toUpperCase() === 'CLEANING'
  ) {
    throw createHttpError(
      409,
      `Personnel account ${personnel.personnel_id} is already marked busy.`
    );
  }
};

const lockAssignmentRows = async ({
  report,
  requestedIds,
  handledById,
  client,
}) => {
  const reportIds = reportAssignmentIds(report);
  const idsToLock = uniqueUpper([
    ...reportIds,
    ...requestedIds,
    ...(handledById ? [handledById] : []),
  ]).sort();
  const requestedPersonnelIds = personnelIds([
    ...requestedIds,
    ...(handledById ? [handledById] : []),
  ]);
  const currentRows = await personnelRepository.findForAssignmentLocks(
    idsToLock,
    report.report_id,
    { queryable: client }
  );
  const personnelById = new Map(
    currentRows.map((row) => [String(row.personnel_id).toUpperCase(), row])
  );

  const oldPersonnelIds = uniqueUpper([
    ...personnelIds(reportIds),
    ...currentRows
      .filter((row) => row.current_assignment_report_id === report.report_id)
      .map((row) => row.personnel_id),
  ]);

  return {
    personnelById,
    oldPersonnelIds,
    requestedPersonnelIds,
    currentRows,
  };
};

const writeAssignmentHistory = async ({
  client,
  report,
  adminId,
  action,
  oldStatus,
  newStatus,
  description,
}) => {
  await historyRepository.createHistory(
    {
      residentId: report.resident_id,
      reportId: report.report_id,
      action,
      oldStatus,
      newStatus,
      description: `${description} (administrator: ${adminId})`,
    },
    client
  );
};

const notifyPersonnelSafely = async ({
  personnelIds: recipients,
  report,
  action,
}) => {
  for (const recipient of uniqueUpper(recipients)) {
    try {
      await notificationRepository.createNotification({
        residentId: recipient,
        reportId: report.report_id,
        title: action === 'unassigned' ? 'Assignment Removed' : 'New Task Assigned',
        message: action === 'unassigned'
          ? `Your assignment for report ${report.report_id} was removed.`
          : `You have been assigned to report: ${report.title}`,
      });
    } catch (error) {
      // Notifications are ancillary. The assignment transaction has already
      // committed, so a notification outage must not turn it into a false
      // assignment failure.
      logError(
        null,
        'ASSIGNMENT_NOTIFICATION',
        `Unable to notify ${recipient} about report ${report.report_id}: ${error.message}`
      );
    }
  }
};

const mutateAssignment = async ({
  reportId: rawReportId,
  report: legacyReport = null,
  updatedByAdminId: legacyAdminId = null,
  assignedPersonnelIds = [],
  canonicalPersonnelId: requestedCanonicalId = null,
  handledById = null,
  adminResponse,
  priority,
  adminId: rawAdminId,
  mode = 'assign',
}) => {
  const reportId = normalizeReportId(rawReportId || legacyReport?.report_id);
  const adminId = requireAdminId(rawAdminId || legacyAdminId);
  const requestedIds = uniqueUpper(assignedPersonnelIds);
  const requestedPersonnelIds = personnelIds([
    ...requestedIds,
    ...(handledById ? [handledById] : []),
  ]);
  const canonicalId = requestedCanonicalId
    ? String(requestedCanonicalId).trim().toUpperCase()
    : null;

  if (canonicalId && !PERSONNEL_ID_PATTERN.test(canonicalId)) {
    throw createHttpError(400, 'personnelId must use the PERS-XXXX format.');
  }

  return withTransaction(async (client) => {
    // Serialize assignment commands before locking report/personnel rows. This
    // prevents cross-report deadlocks while preserving transactional rollback.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('myecowatch:phase-2b:assignment-command:v1'))"
    );
    const report = await reportRepository.findByReportIdForUpdate(
      reportId,
      client
    );
    assertAssignableStatus(report);

    const existingIds = reportAssignmentIds(report);
    const hasExistingAssignment = existingIds.length > 0;

    if (mode === 'assign' && canonicalId && hasExistingAssignment) {
      throw createHttpError(
        409,
        'Report already has an assignment. Use the reassign endpoint to replace it.'
      );
    }

    const effectiveCanonicalId = canonicalId
      || (mode === 'reassign'
        && requestedIds.length === 1
        && PERSONNEL_ID_PATTERN.test(requestedIds[0])
        ? requestedIds[0]
        : null);

    if (mode === 'reassign') {
      if (!hasExistingAssignment) {
        throw createHttpError(
          409,
          'Report has no assignment to reassign. Use the assign endpoint first.'
        );
      }
      if (!effectiveCanonicalId) {
        throw createHttpError(
          400,
          'Reassignment requires one PERS-XXXX personnelId.'
        );
      }
    }

    if (mode === 'reassign' && requestedIds.length !== 1) {
      throw createHttpError(
        400,
        'Reassignment accepts exactly one personnelId.'
      );
    }

    const locked = await lockAssignmentRows({
      report,
      requestedIds,
      handledById,
      client,
    });

    const requestedLegacyIds = legacyPersonnelIds([
      ...requestedIds,
      ...(handledById ? [handledById] : []),
    ]);
    const oldLegacyIds = legacyPersonnelIds(existingIds);
    await findLegacyPersonnelForAssignment(requestedLegacyIds, client);
    await findLegacyPersonnelForAssignment(oldLegacyIds, client, {
      allowUnavailable: true,
      allowMissing: true,
    });

    for (const personnelId of requestedPersonnelIds) {
      assertPersonnelCanReceiveAssignment(
        locked.personnelById.get(personnelId),
        report.report_id
      );
    }

    const nextPersonnelIds = uniqueUpper([
      ...requestedPersonnelIds,
      ...(handledById ? [handledById] : []),
    ]);
    const nextCanonicalId = effectiveCanonicalId
      || (requestedIds.length === 1 && PERSONNEL_ID_PATTERN.test(requestedIds[0])
        ? requestedIds[0]
        : null);
    const assignedAt = new Date();
    const oldStatus = report.status;
    const nextStatus = 'In Progress';
    const nextPriority = priority || report.priority || 'Normal';
    const nextArray = requestedIds;
    const nextHandledById = effectiveCanonicalId || handledById || null;

    const updatedReport = await reportRepository.updateReport(
      report.report_id,
      {
        assignedPersonnelIds: nextArray,
        assignedPersonnelId: nextCanonicalId,
        assignedByAdminId: adminId,
        assignedAt,
        adminResponse:
          adminResponse === undefined ? report.admin_response || '' : adminResponse,
        status: nextStatus,
        priority: nextPriority,
        handledById: nextHandledById,
      },
      client
    );

    if (!updatedReport) {
      throw createHttpError(404, 'Report not found.');
    }

    await personnelRepository.syncReportAssignments(
      {
        reportId: report.report_id,
        location: assignmentLocation(report),
        assignmentText: assignmentText(report),
        assignedAt,
        previousPersonnelIds: locked.oldPersonnelIds,
        nextPersonnelIds,
        updatedByAdminId: adminId,
      },
      client
    );

    const action = mode === 'reassign' ? 'REASSIGNED' : 'ASSIGNED';
    const description = mode === 'reassign'
      ? `Report reassigned to ${requestedIds.join(', ')}.`
      : `Report assigned to ${requestedIds.join(', ')}.`;
    await writeAssignmentHistory({
      client,
      report,
      adminId,
      action,
      oldStatus,
      newStatus: nextStatus,
      description,
    });

    const assignment = buildAssignmentDetails(
      updatedReport,
      locked.personnelById
    );
    return {
      report: updatedReport,
      assignment,
      oldPersonnelIds: locked.oldPersonnelIds,
      notificationPersonnelIds: uniqueUpper([
        ...nextPersonnelIds,
        ...requestedIds,
      ]),
      mode,
    };
  }).then(async (result) => {
    await notifyPersonnelSafely({
      personnelIds: result.notificationPersonnelIds,
      report: result.report,
      action: result.mode === 'reassign' ? 'reassigned' : 'assigned',
    });
    return result;
  });
};

const assignPersonnelToReport = (options) =>
  mutateAssignment({ ...options, mode: 'assign' });

const reassignPersonnelToReport = (options) =>
  mutateAssignment({ ...options, mode: 'reassign' });

const unassignPersonnelFromReport = async ({
  reportId: rawReportId,
  adminId: rawAdminId,
}) => {
  const reportId = normalizeReportId(rawReportId);
  const adminId = requireAdminId(rawAdminId);

  const result = await withTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('myecowatch:phase-2b:assignment-command:v1'))"
    );
    const report = await reportRepository.findByReportIdForUpdate(
      reportId,
      client
    );
    assertActiveReport(report);

    const existingIds = reportAssignmentIds(report);
    if (!existingIds.length) {
      return {
        report,
        clearedPersonnelIds: [],
        notificationPersonnelIds: [],
        assignment: buildAssignmentDetails(report),
      };
    }

    const locked = await lockAssignmentRows({
      report,
      requestedIds: [],
      handledById: null,
      client,
    });
    await findLegacyPersonnelForAssignment(
      legacyPersonnelIds(existingIds),
      client,
      { allowUnavailable: true, allowMissing: true }
    );

    const oldStatus = report.status;
    const shouldReturnToPending =
      isReportActive(report)
      && !['completed', 'denied'].includes(reportStatus(report));
    const updatedReport = await reportRepository.updateReport(
      report.report_id,
      {
        assignedPersonnelIds: [],
        assignedPersonnelId: null,
        assignedByAdminId: null,
        assignedAt: null,
        handledById: null,
        status: shouldReturnToPending ? 'Pending' : report.status,
      },
      client
    );

    if (!updatedReport) {
      throw createHttpError(404, 'Report not found.');
    }

    const clearedPersonnelIds =
      await personnelRepository.clearCurrentAssignmentsForReport(
        report.report_id,
        adminId,
        client,
        { personnelIds: locked.oldPersonnelIds }
      );

    await writeAssignmentHistory({
      client,
      report,
      adminId,
      action: 'UNASSIGNED',
      oldStatus,
      newStatus: updatedReport.status,
      description: `Report assignment to ${existingIds.join(', ')} was removed.`,
    });

    return {
      report: updatedReport,
      clearedPersonnelIds,
      notificationPersonnelIds: uniqueUpper([
        ...locked.oldPersonnelIds,
        ...existingIds,
      ]),
    };
  });

  await notifyPersonnelSafely({
    personnelIds: result.notificationPersonnelIds,
    report: result.report,
    action: 'unassigned',
  });

  return {
    ...result,
    assignment: buildAssignmentDetails(result.report),
  };
};

const getReportAssignment = async ({ reportId: rawReportId }) => {
  const reportId = normalizeReportId(rawReportId);
  const report = await reportRepository.findAssignmentByReportId(reportId);

  if (!report) {
    throw createHttpError(404, 'Report not found.');
  }

  const ids = personnelIds(reportAssignmentIds(report));
  const personnel = ids.length
    ? await personnelRepository.findByIdsForAssignment(ids)
    : [];
  const personnelById = new Map(
    personnel.map((row) => [String(row.personnel_id).toUpperCase(), row])
  );

  return {
    report,
    assignment: buildAssignmentDetails(report, personnelById),
  };
};

const completePersonnelReport = async ({
  reportId: rawReportId,
  report: legacyReport = null,
  updatedByAdminId: rawAdminId,
}) => {
  const reportId = normalizeReportId(rawReportId || legacyReport?.report_id);
  const adminId = requireAdminId(rawAdminId);

  return withTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('myecowatch:phase-2b:assignment-command:v1'))"
    );
    const report = await reportRepository.findByReportIdForUpdate(
      reportId,
      client
    );
    if (!report) {
      throw createHttpError(404, 'Report not found.');
    }
    assertActiveReport(report);

    const ids = reportAssignmentIds(report);
    const locked = await lockAssignmentRows({
      report,
      requestedIds: [],
      handledById: null,
      client,
    });
    const oldStatus = report.status;
    const updatedReport = await reportRepository.updateReport(
      report.report_id,
      {
        status: 'Completed',
        resolvedAt: new Date(),
      },
      client
    );

    if (!updatedReport) {
      throw createHttpError(404, 'Report not found.');
    }

    const clearedPersonnelIds =
      await personnelRepository.clearCurrentAssignmentsForReport(
        report.report_id,
        adminId,
        client,
        { personnelIds: locked.oldPersonnelIds }
      );

    await writeAssignmentHistory({
      client,
      report,
      adminId,
      action: 'COMPLETED',
      oldStatus,
      newStatus: 'Completed',
      description: `Admin approved cleanup for report '${report.title}'.`,
    });

    return {
      report: updatedReport,
      clearedPersonnelIds,
      previousAssignmentIds: ids,
    };
  });
};

module.exports = {
  assignPersonnelToReport,
  reassignPersonnelToReport,
  unassignPersonnelFromReport,
  unassignPersonnel: unassignPersonnelFromReport,
  getReportAssignment,
  getAssignment: getReportAssignment,
  completePersonnelReport,
  mapAssignmentReport,
  buildAssignmentDetails,
};

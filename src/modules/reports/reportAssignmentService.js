const { withTransaction } = require('../../config/db');
const reportRepository = require('./reportRepository');
const personnelRepository = require('../personnel/personnelRepository');
const personnelAssignmentRepository = require('../personnel/personnelAssignmentRepository');
const personnelEvidenceRepository = require('../personnel/personnelEvidenceRepository');
const residentRepository = require('../residents/residentRepository');
const historyRepository = require('../history/historyRepository');
const cleaningTeamRepository = require('../personnel/cleaningTeamRepository');
const vehicleRepository = require('../vehicles/vehicleRepository');
const notificationService = require('../notifications/notificationService');
const personnelNotificationService = require('../personnel/personnelNotificationService');
const cloudinaryService = require('../../shared/cloudinaryService');
const {
  PERSONNEL_ID_PATTERN,
  createHttpError,
} = require('../../shared/personnelValidation');
const { normalizeReportId } = require('./reportAssignmentValidation');
const {
  DEFAULT_WASTE_SCALE,
  TEAM_MINIMUM_CREW_SIZE,
  WASTE_SCALE,
  assertAssignmentMatchesScale,
  isWasteScale,
  requiresTeam,
  requiresVehicle,
} = require('../../shared/wasteScaleValidation');
const { CATEGORY: HISTORY_CATEGORY } = require('../../shared/historyActions');
const { logError } = require('../../shared/logger');

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

const buildAssignmentDetails = (
  report,
  personnelById = new Map(),
  { teamName = null, vehiclePlateNumber = null, vehicleType = null } = {}
) => {
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
    // Personnel-only note. Admin and personnel both read it; the resident never
    // does, because it is excluded from every resident-facing SELECT.
    personnelNote: report.personnel_note || '',
    status: report.status || 'Pending',
    priority: report.priority || 'Normal',
    // How big the reported waste is, and what went out to deal with it. The
    // crew and the truck are the scale made visible: one person for a small
    // job, a team for a medium one, a team and a truck for a large one.
    wasteScale: report.waste_scale || DEFAULT_WASTE_SCALE,
    assignedTeamId: report.assigned_team_id || null,
    assignedTeamName: teamName || null,
    assignedVehicleId: report.assigned_vehicle_id || null,
    assignedVehiclePlateNumber: vehiclePlateNumber || null,
    assignedVehicleType: vehicleType || null,
  };
};

/**
 * The crew name and the number plate behind a report.
 *
 * The report row only carries the ids; the readable names live on the team and
 * on the vehicle. Resolving them in one place keeps every caller of the
 * assignment shape showing the same thing.
 */
const resolveTeamAndVehicleNames = async (report) => {
  const teamId = report?.assigned_team_id || null;
  const vehicleId = report?.assigned_vehicle_id || null;

  if (!teamId && !vehicleId) {
    return { teamName: null, vehiclePlateNumber: null, vehicleType: null };
  }

  const { teams, vehicles } = await cleaningTeamRepository.resolveTeamAndVehicle({
    teamIds: teamId ? [teamId] : [],
    vehicleIds: vehicleId ? [vehicleId] : [],
  });

  const team = teamId ? teams.get(teamId) : null;
  const vehicle = vehicleId ? vehicles.get(vehicleId) : null;

  return {
    teamName: team ? team.team_name : null,
    vehiclePlateNumber: vehicle ? vehicle.plate_number : null,
    vehicleType: vehicle ? vehicle.vehicle_type : null,
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
    personnelNote: report.personnel_note || '',
    // The scale and the crew that matches it. The names are joined onto the
    // report row by the admin listing query, so the list and the detail
    // dialog read the same way.
    wasteScale: report.waste_scale || DEFAULT_WASTE_SCALE,
    assignedTeamId: report.assigned_team_id || null,
    assignedTeamName:
      report.assigned_team_name
      || resolvedAssignment?.assignedTeamName
      || null,
    assignedVehicleId: report.assigned_vehicle_id || null,
    assignedVehiclePlateNumber:
      report.assigned_vehicle_plate_number
      || resolvedAssignment?.assignedVehiclePlateNumber
      || null,
    assignedVehicleType:
      report.assigned_vehicle_type
      || resolvedAssignment?.assignedVehicleType
      || null,
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
  category,
}) => {
  await historyRepository.createHistory(
    {
      residentId: report.resident_id,
      reportId: report.report_id,
      action,
      oldStatus,
      newStatus,
      // Stated where the decision is made rather than left for each client to
      // derive from the action constant. Undefined falls back to the shared
      // action-to-category table, so a new call site is categorised correctly.
      category,
      adminId,
      description: `${description} (administrator: ${adminId})`,
    },
    client
  );
};

const notifyResidentEventsSafely = async ({
  report,
  events,
  requestId = null,
}) => {
  const notifications = [];
  for (const type of events) {
    try {
      notifications.push(await notificationService.createForReportEvent({
        reportId: report.report_id,
        type,
        report,
        requestId,
      }));
    } catch (error) {
      // The report mutation has already committed. Keep that success durable
      // even if notification persistence is temporarily unavailable.
      logError(
        requestId,
        'RESIDENT_NOTIFICATION',
        `Unable to create ${type} notification for report ${report.report_id}: ${error.message}`
      );
    }
  }
  return notifications;
};

/**
 * Personnel notices are best-effort for the same reason resident notices are:
 * the assignment mutation already committed, so a notification or push failure
 * must not fail the administrator's action. Personnel who were not actually
 * inserted (a repeated save) are never re-notified.
 */
const notifyPersonnelAssignmentSafely = async ({
  personnelIds,
  report,
  notes = null,
  requestId = null,
}) => {
  const notifications = [];

  for (const personnelId of personnelIds || []) {
    try {
      notifications.push(
        await personnelNotificationService.notifyAssignmentAssigned({
          personnelId,
          report,
          notes,
          requestId,
        })
      );
    } catch (error) {
      logError(
        requestId,
        'PERSONNEL_NOTIFICATION',
        `Unable to notify ${personnelId} of assignment to ${report.report_id}: ${error.message}`
      );
    }
  }

  return notifications;
};

const notifyPersonnelUnassignmentSafely = async ({
  personnelIds,
  report,
  requestId = null,
}) => {
  const notifications = [];

  for (const personnelId of personnelIds || []) {
    try {
      notifications.push(
        await personnelNotificationService.notifyAssignmentUnassigned({
          personnelId,
          report,
          requestId,
        })
      );
    } catch (error) {
      logError(
        requestId,
        'PERSONNEL_NOTIFICATION',
        `Unable to notify ${personnelId} of removal from ${report.report_id}: ${error.message}`
      );
    }
  }

  return notifications;
};

const notifyPersonnelApprovalSafely = async ({
  personnelIds,
  report,
  requestId = null,
}) => {
  const notifications = [];

  for (const personnelId of personnelIds || []) {
    try {
      notifications.push(
        await personnelNotificationService.notifyAssignmentApproved({
          personnelId,
          report,
          requestId,
        })
      );
    } catch (error) {
      logError(
        requestId,
        'PERSONNEL_NOTIFICATION',
        `Unable to notify ${personnelId} of approval for ${report.report_id}: ${error.message}`
      );
    }
  }

  return notifications;
};

/**
 * Tells the cleaner their finished work was sent back with a note. Best-effort
 * for the same reason as every other notice: the revision is already committed.
 */
const notifyPersonnelRevisionSafely = async ({
  personnelIds,
  report,
  notes = null,
  requestId = null,
}) => {
  const notifications = [];

  for (const personnelId of personnelIds || []) {
    try {
      notifications.push(
        await personnelNotificationService.notifyAssignmentRevisionRequested({
          personnelId,
          report,
          notes,
          requestId,
        })
      );
    } catch (error) {
      logError(
        requestId,
        'PERSONNEL_NOTIFICATION',
        `Unable to notify ${personnelId} of revision for ${report.report_id}: ${error.message}`
      );
    }
  }

  return notifications;
};

/**
 * The scale this assignment has to satisfy.
 *
 * The resident filed the report under a scale and that is the one that counts.
 * The administrator may restate it while dispatching, so the payload wins when
 * it carries one; otherwise the report's own scale is used, and a report filed
 * before the feature existed falls back to Small-Scale Waste.
 */
const resolveWasteScale = (report, requestedScale) => {
  const stored = report?.waste_scale;
  const storedScale = stored && isWasteScale(stored) ? stored : null;

  // The scale belongs to the report, not to the request.
  //
  // The resident picks it when they file, and the administrator dispatches
  // against it. A request may not scale it down, because that would hand a
  // large job to one cleaner with no truck -- the exact failure this
  // vocabulary exists to prevent. A client that sends a stale or different
  // scale is ignored rather than obeyed, so a cached report cannot rewrite
  // what the resident asked for.
  //
  // The requested scale is only consulted for a report that has none, which
  // is a report filed before the field existed.
  if (storedScale) return storedScale;

  const requested = requestedScale && isWasteScale(requestedScale) ? requestedScale : null;
  if (requested) return requested;

  return DEFAULT_WASTE_SCALE;
};

/**
 * Resolves the cleaning team the assignment is dispatching.
 *
 * A crew may be ad hoc: the administrator can bulk-select2 or more available
 * personnel directly, and that selection is a valid crew with no named team
 * behind it (teamId stays null). The team is therefore optional -- it exists
 * for dispatches that go out under a saved, named crew.
 *
 * When a team *is* named, the crew is not just a label: the people sent have
 * to actually be on it, so a team whose membership is not what the
 * administrator saw on screen is caught here rather than discovered on site.
 */
const resolveCleaningTeam = async ({
  teamId,
  personnelIds,
  scale,
  client,
}) => {
  if (!requiresTeam(scale)) {
    if (teamId) {
      throw createHttpError(
        400,
        `${scale} is handled by one personnel member and cannot be assigned to a cleaning team.`
      );
    }
    return null;
  }

  // No named team: an ad hoc crew of2+ personnel. The crew-size rule itself is
  // enforced by assertAssignmentMatchesScale, so nothing is left unchecked.
  if (!teamId) {
    return null;
  }

  const team = await cleaningTeamRepository.findTeamById(teamId, client);
  if (!team || team.is_deleted === true) {
    throw createHttpError(404, 'Cleaning team not found.');
  }

  const memberIds = await cleaningTeamRepository.listTeamMemberIds(teamId, client);
  if (memberIds.length < TEAM_MINIMUM_CREW_SIZE) {
    throw createHttpError(
      400,
      `Cleaning team ${team.team_name} has fewer than ${TEAM_MINIMUM_CREW_SIZE} active members.`
    );
  }

  const outsiders = personnelIds.filter((id) => !memberIds.includes(id));
  if (outsiders.length) {
    throw createHttpError(
      400,
      `These personnel are not members of ${team.team_name}: ${outsiders.join(', ')}.`
    );
  }

  return { team, memberIds };
};

/**
 * Resolves the collection vehicle the assignment is dispatching.
 *
 * A truck that is under maintenance cannot go out, and a truck that is already
 * out on another collection cannot be sent to a second one.
 */
const resolveCollectionVehicle = async ({
  vehicleId,
  scale,
  reportId,
  client,
}) => {
  if (!requiresVehicle(scale)) {
    if (vehicleId) {
      throw createHttpError(
        400,
        `${scale} is handled without a collection vehicle.`
      );
    }
    return null;
  }

  if (!vehicleId) {
    throw createHttpError(
      400,
      `${scale} requires a collection vehicle to be assigned.`
    );
  }

  const vehicle = await vehicleRepository.findByVehicleId(vehicleId, client);
  if (!vehicle || vehicle.isDeleted) {
    throw createHttpError(404, 'Collection vehicle not found.');
  }

  if (vehicle.status === 'Maintenance') {
    throw createHttpError(
      409,
      `Vehicle ${vehicle.plateNumber} is under maintenance and cannot be dispatched.`
    );
  }

  if (vehicle.currentReportId && vehicle.currentReportId !== reportId) {
    throw createHttpError(
      409,
      `Vehicle ${vehicle.plateNumber} is already dispatched to report ${vehicle.currentReportId}.`
    );
  }

  return vehicle;
};

/**
 * The driver bound to the truck that is going out.
 *
 * <p>A vehicle is not a self-driving piece of equipment: its owner is the
 * personnel account whose occupation is Driver. A Large-Scale dispatch names a
 * cleaning team and a truck, and the team roster does not necessarily include
 * that driver, so without this lookup the one person actually driving the truck
 * would be the only member of the dispatch who is neither assigned nor
 * notified.
 */
const resolveVehicleDriverId = async (vehicle, client) => {
  if (!vehicle || !vehicle.vehicleId) return null;

  const driver = await personnelRepository.findByAssignedVehicleId(
    vehicle.vehicleId,
    {},
    client
  );

  return driver
    ? String(driver.personnel_id).trim().toUpperCase()
    : null;
};

const mutateAssignment = async ({
  reportId: rawReportId,
  report: legacyReport = null,
  updatedByAdminId: legacyAdminId = null,
  assignedPersonnelIds = [],
  canonicalPersonnelId: requestedCanonicalId = null,
  handledById = null,
  adminResponse,
  personnelNote,
  priority,
  wasteScale: requestedWasteScale = null,
  teamId: requestedTeamId = null,
  vehicleId: requestedVehicleId = null,
  adminId: rawAdminId,
  requestId = null,
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

    // The scale the resident filed the report under decides how much has to be
    // sent to the site, and therefore what shape this assignment may take.
    const effectiveScale = resolveWasteScale(report, requestedWasteScale);
    const scaleNeedsCrew = requiresTeam(effectiveScale);

    if (mode === 'reassign') {
      if (!hasExistingAssignment) {
        throw createHttpError(
          409,
          'Report has no assignment to reassign. Use the assign endpoint first.'
        );
      }
      // A crew is dispatched as a list of people, so the single-personnel rule
      // only applies to the scales that are handled by one person.
      if (!scaleNeedsCrew && !effectiveCanonicalId) {
        throw createHttpError(
          400,
          'Reassignment requires one PERS-XXXX personnelId.'
        );
      }
    }

    if (mode === 'reassign' && requestedIds.length !== 1 && !scaleNeedsCrew) {
      throw createHttpError(
        400,
        'Reassignment accepts exactly one personnelId.'
      );
    }

    // The crew and the truck have to match the scale. This is checked before
    // anything is written so a mismatched dispatch leaves nothing behind.
    const cleaningTeam = await resolveCleaningTeam({
      teamId: requestedTeamId,
      personnelIds: requestedPersonnelIds,
      scale: effectiveScale,
      client,
    });

    const collectionVehicle = await resolveCollectionVehicle({
      vehicleId: requestedVehicleId,
      scale: effectiveScale,
      reportId: report.report_id,
      client,
    });

    // The truck's driver goes out with the truck. They are deliberately added
    // after resolveCleaningTeam: a Driver is not a cleaner, so requiring them
    // to be on the cleaning team's roster would reject every valid dispatch
    // that uses a truck driven by someone outside that team.
    const vehicleDriverId = await resolveVehicleDriverId(collectionVehicle, client);
    const crewPersonnelIds = uniqueUpper([
      ...requestedPersonnelIds,
      ...(vehicleDriverId ? [vehicleDriverId] : []),
    ]);
    const assignmentPersonnelIds = uniqueUpper([
      ...requestedIds,
      ...(vehicleDriverId ? [vehicleDriverId] : []),
    ]);

    assertAssignmentMatchesScale({
      scale: effectiveScale,
      personnelIds: crewPersonnelIds,
      vehicleId: requestedVehicleId,
      teamId: requestedTeamId,
    });

    const locked = await lockAssignmentRows({
      report,
      requestedIds: assignmentPersonnelIds,
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

    for (const personnelId of crewPersonnelIds) {
      assertPersonnelCanReceiveAssignment(
        locked.personnelById.get(personnelId),
        report.report_id
      );
    }

    const nextPersonnelIds = uniqueUpper([
      ...crewPersonnelIds,
      ...(handledById ? [handledById] : []),
    ]);
    // A crew has no single canonical person, so the canonical pointer is left
    // empty and the whole crew lives in the assignment array. The one-person
    // scales keep the pointer because the rest of the system reads it.
    const nextCanonicalId = scaleNeedsCrew
      ? null
      : effectiveCanonicalId
        || (requestedIds.length === 1 && PERSONNEL_ID_PATTERN.test(requestedIds[0])
          ? requestedIds[0]
          : null);
    const assignedAt = new Date();
    const oldStatus = report.status;
    const nextStatus = 'In Progress';
    const nextPriority = priority || report.priority || 'Normal';
    // The report's own crew list carries the driver as well. That is what lets
    // a later reassignment or unassignment find them and cancel their row,
    // rather than leaving them permanently marked busy on a report they no
    // longer work.
    const nextArray = assignmentPersonnelIds;
    const nextHandledById = effectiveCanonicalId || handledById || null;
    const nextTeamId = cleaningTeam ? cleaningTeam.team.team_id : null;
    const nextVehicleId = collectionVehicle ? collectionVehicle.vehicleId : null;
    const nextAdminResponse = adminResponse === undefined
      ? report.admin_response || ''
      : String(adminResponse || '').trim();
    const responseChanged = nextAdminResponse !== (report.admin_response || '');
    // The personnel note is a second, independent channel: the admin can give
    // the resident an answer and give the cleaner separate instructions in the
    // same save, and each keeps its own audience.
    const nextPersonnelNote = personnelNote === undefined
      ? report.personnel_note || ''
      : String(personnelNote || '').trim();
    const personnelNoteChanged = nextPersonnelNote !== (report.personnel_note || '');

    const updatedReport = await reportRepository.updateReport(
      report.report_id,
      {
        assignedPersonnelIds: nextArray,
        assignedPersonnelId: nextCanonicalId,
        assignedByAdminId: adminId,
        assignedAt,
        adminResponse: nextAdminResponse,
        personnelResponse: nextPersonnelNote,
        status: nextStatus,
        priority: nextPriority,
        handledById: nextHandledById,
        wasteScale: effectiveScale,
        assignedTeamId: nextTeamId,
        assignedVehicleId: nextVehicleId,
      },
      client
    );

    if (!updatedReport) {
      throw createHttpError(404, 'Report not found.');
    }

    // The truck follows the report: the new one goes out, and the one that was
    // on this report before (if any) goes back to the depot.
    const previousVehicleId = report.assigned_vehicle_id || null;
    if (previousVehicleId && previousVehicleId !== nextVehicleId) {
      await vehicleRepository.releaseFromReport(previousVehicleId, adminId, client);
    }
    if (nextVehicleId && nextVehicleId !== previousVehicleId) {
      await vehicleRepository.assignToReport(
        nextVehicleId,
        {
          reportId: report.report_id,
          clusterId: report.cluster_id || null,
          adminId,
        },
        client
      );
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

    // Mirror the canonical pointer into the personnel-owned lifecycle table so
    // the cleaner can acknowledge, upload evidence, start and finish the task.
    // Only real PERS-XXXX accounts can back the foreign key; legacy resident-id
    // personnel records keep working through the legacy pointer above.
    const trackedPersonnelIds = uniqueUpper([
      ...crewPersonnelIds,
      ...(nextCanonicalId && PERSONNEL_ID_PATTERN.test(nextCanonicalId)
        ? [nextCanonicalId]
        : []),
    ]);
    const personnelAssignments =
      await personnelAssignmentRepository.syncReportAssignments(
        {
          reportId: report.report_id,
          personnelIds: trackedPersonnelIds,
          clusterId: report.cluster_id || null,
          assignedByAdminId: adminId,
          assignedAt,
          assignedTeamId: nextTeamId,
          assignedVehicleId: nextVehicleId,
          wasteScale: effectiveScale,
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
      category: HISTORY_CATEGORY.ASSIGNMENTS,
    });

    const assignment = buildAssignmentDetails(
      updatedReport,
      locked.personnelById,
      {
        teamName: cleaningTeam ? cleaningTeam.team.team_name : null,
        vehiclePlateNumber: collectionVehicle ? collectionVehicle.plateNumber : null,
        vehicleType: collectionVehicle ? collectionVehicle.vehicleType : null,
      }
    );
    return {
      report: updatedReport,
      assignment,
      oldPersonnelIds: locked.oldPersonnelIds,
      personnelAssignedIds: personnelAssignments.created,
      personnelCancelledIds: personnelAssignments.cancelled,
      events: [
        notificationService.NOTIFICATION_TYPES.PERSONNEL_ASSIGNED,
        ...(responseChanged
          ? [notificationService.NOTIFICATION_TYPES.ADMIN_RESPONSE_UPDATED]
          : []),
      ],
      responseChanged,
      // Only the resident-visible response raises a resident notice. A change to
      // the personnel-only note is silent for the reporter by design.
      personnelNoteChanged,
      personnelNote: nextPersonnelNote,
      wasteScale: effectiveScale,
      assignedTeamId: nextTeamId,
      assignedVehicleId: nextVehicleId,
      mode,
      requestId,
    };
  }).then(async (result) => {
    const notifications = await notifyResidentEventsSafely({
      report: result.report,
      events: result.events,
      requestId: result.requestId,
    });

    // A reassignment can both create and cancel personnel rows; tell each side.
    await notifyPersonnelAssignmentSafely({
      personnelIds: result.personnelAssignedIds,
      report: result.report,
      notes: result.personnelNote,
      requestId: result.requestId,
    });
    await notifyPersonnelUnassignmentSafely({
      personnelIds: result.personnelCancelledIds,
      report: result.report,
      requestId: result.requestId,
    });

    return { ...result, notifications };
  });
};

const assignPersonnelToReport = (options) =>
  mutateAssignment({ ...options, mode: 'assign' });

const reassignPersonnelToReport = (options) =>
  mutateAssignment({ ...options, mode: 'reassign' });

const unassignPersonnelFromReport = async ({
  reportId: rawReportId,
  adminId: rawAdminId,
  requestId = null,
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
        events: [],
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
    const releasedVehicleId = report.assigned_vehicle_id || null;
    const updatedReport = await reportRepository.updateReport(
      report.report_id,
      {
        assignedPersonnelIds: [],
        assignedPersonnelId: null,
        assignedByAdminId: null,
        assignedAt: null,
        handledById: null,
        status: shouldReturnToPending ? 'Pending' : report.status,
        // The crew and the truck go back with the people who were sent.
        assignedTeamId: null,
        assignedVehicleId: null,
      },
      client
    );

    if (!updatedReport) {
      throw createHttpError(404, 'Report not found.');
    }

    if (releasedVehicleId) {
      await vehicleRepository.releaseFromReport(releasedVehicleId, adminId, client);
    }

    const clearedPersonnelIds =
      await personnelRepository.clearCurrentAssignmentsForReport(
        report.report_id,
        adminId,
        client,
        { personnelIds: locked.oldPersonnelIds }
      );

    const cancelledAssignmentIds =
      await personnelAssignmentRepository.cancelActiveForReport(
        report.report_id,
        client
      );

    await writeAssignmentHistory({
      client,
      report,
      adminId,
      action: 'UNASSIGNED',
      oldStatus,
      newStatus: updatedReport.status,
      description: `Report assignment to ${existingIds.join(', ')} was removed.`,
      category: HISTORY_CATEGORY.ASSIGNMENTS,
    });

    return {
      report: updatedReport,
      clearedPersonnelIds,
      cancelledAssignmentIds,
      events: [notificationService.NOTIFICATION_TYPES.PERSONNEL_UNASSIGNED],
    };
  });

  const notifications = await notifyResidentEventsSafely({
    report: result.report,
    events: result.events,
    requestId,
  });

  await notifyPersonnelUnassignmentSafely({
    personnelIds: result.cancelledAssignmentIds,
    report: result.report,
    requestId,
  });

  return {
    ...result,
    notifications,
    assignment: buildAssignmentDetails(result.report),
  };
};

/**
 * Releases the active personnel relationship without changing the report
 * lifecycle collection. Resident-owned archive/trash operations use this
 * helper before moving a report so a personnel account cannot remain busy on a
 * report that is no longer actionable. Administrator lifecycle operations use
 * the same invariant in their transaction.
 */
const releaseReportAssignment = async ({
  reportId: rawReportId,
  updatedByAdminId = null,
}) => {
  const reportId = normalizeReportId(rawReportId);

  return withTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('myecowatch:phase-2b:assignment-command:v1'))"
    );
    const report = await reportRepository.findByReportIdForUpdate(reportId, client);
    if (!report) return null;

    const ids = reportAssignmentIds(report);
    const locked = await lockAssignmentRows({
      report,
      requestedIds: [],
      handledById: null,
      client,
    });
    const oldStatus = report.status;
    const releasedVehicleId = report.assigned_vehicle_id || null;
    const updatedReport = await reportRepository.updateReport(
      reportId,
      {
        assignedPersonnelIds: [],
        assignedPersonnelId: null,
        handledById: null,
        status: reportStatus(report) === 'in progress' ? 'Pending' : oldStatus,
        assignedTeamId: null,
        assignedVehicleId: null,
      },
      client
    );

    await personnelRepository.clearCurrentAssignmentsForReport(
      reportId,
      updatedByAdminId,
      client,
      { personnelIds: locked.oldPersonnelIds }
    );

    // The truck is released too, otherwise it would sit on a collection that
    // no longer exists.
    if (releasedVehicleId) {
      await vehicleRepository.releaseFromReport(
        releasedVehicleId,
        updatedByAdminId,
        client
      );
    }

    // The report is leaving the actionable set, so the cleaner's live task must
    // not survive as a dangling assignment they can no longer work on.
    await personnelAssignmentRepository.cancelActiveForReport(reportId, client);

    return updatedReport;
  });
};

const mapEvidenceRows = (rows = []) => {
  const before = [];
  const after = [];

  for (const row of rows) {
    const item = {
      evidenceId: row.evidence_id,
      assignmentId: row.assignment_id,
      reportId: row.report_id,
      personnelId: row.personnel_id,
      phase: row.phase,
      imageUrl: row.image_url,
      uploadedAt: row.uploaded_at,
    };

    if (row.phase === 'AFTER') {
      after.push(item);
    } else {
      before.push(item);
    }
  }

  return { before, after };
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

  const assignment = buildAssignmentDetails(
    report,
    personnelById,
    await resolveTeamAndVehicleNames(report)
  );
  if (assignment) {
    const evidence = mapEvidenceRows(
      await personnelEvidenceRepository.listForReport(reportId)
    );
    assignment.evidence = evidence;
    assignment.beforePhotos = evidence.before;
    assignment.afterPhotos = evidence.after;
  }

  return { report, assignment };
};

const completePersonnelReport = async ({
  reportId: rawReportId,
  report: legacyReport = null,
  updatedByAdminId: rawAdminId,
  adminResponse,
  requestId = null,
}) => {
  const reportId = normalizeReportId(rawReportId || legacyReport?.report_id);
  const adminId = requireAdminId(rawAdminId);

  const result = await withTransaction(async (client) => {
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
    if (!ids.length) {
      throw createHttpError(409, 'Assign personnel before completing a report.');
    }
    const currentStatus = reportStatus(report);
    if (currentStatus !== 'in progress' && currentStatus !== 'under review') {
      throw createHttpError(
        409,
        'Only an In Progress or Under Review report can be completed.'
      );
    }

    const locked = await lockAssignmentRows({
      report,
      requestedIds: [],
      handledById: null,
      client,
    });
    const oldStatus = report.status;
    const releasedVehicleId = report.assigned_vehicle_id || null;
    const nextResponse = adminResponse === undefined
      ? report.admin_response || ''
      : String(adminResponse || '').trim();
    const responseChanged = nextResponse !== (report.admin_response || '');
    const updates = {
      status: 'Completed',
      resolvedAt: new Date(),
      // Completion releases the active assignment. Keeping the canonical
      // pointer (or its legacy array fallback) populated would make the
      // personnel appear busy and trip the active-assignment unique index.
      assignedPersonnelId: null,
      assignedPersonnelIds: [],
      handledById: null,
    };
    if (adminResponse !== undefined) updates.adminResponse = nextResponse;

    const updatedReport = await reportRepository.updateReport(
      report.report_id,
      updates,
      client
    );

    if (!updatedReport) {
      throw createHttpError(404, 'Report not found.');
    }

    // Completion ends the vehicle's live collection state too. The report keeps
    // its assigned vehicle id as historical dispatch detail, while the fleet
    // row becomes available for the next collection.
    if (releasedVehicleId) {
      await vehicleRepository.releaseFromReport(releasedVehicleId, adminId, client);
    }

    const clearedPersonnelIds =
      await personnelRepository.clearCurrentAssignmentsForReport(
        report.report_id,
        adminId,
        client,
        { personnelIds: locked.oldPersonnelIds }
      );

    // The cleaner's task is only approved once the administrator completes the
    // report. In the review workflow the cleaner already marked theirs COMPLETED
    // before the report reached Under Review, so completeActiveForReport is a
    // no-op there; fall back to the report's recorded assignment so the
    // acceptance notice still reaches the cleaner.
    const approvedPersonnelIds =
      await personnelAssignmentRepository.completeActiveForReport(
        report.report_id,
        client
      );
    const notificationPersonnelIds = uniqueUpper([
      ...approvedPersonnelIds,
      ...personnelIds(ids),
    ]);

    await writeAssignmentHistory({
      client,
      report,
      adminId,
      // Recorded under Reports, not Cleaning: this is the administrator approving
      // the report, which is a report decision. The cleaner's own completion is
      // recorded separately as CLEANING_COMPLETED.
      action: 'COMPLETED',
      oldStatus,
      newStatus: 'Completed',
      description: `Admin approved cleanup for report '${report.title}'.`,
      category: HISTORY_CATEGORY.REPORTS,
    });
    if (responseChanged) {
      await historyRepository.createHistory(
        {
          residentId: report.resident_id,
          reportId: report.report_id,
          action: 'ADMIN_RESPONSE_UPDATED',
          category: HISTORY_CATEGORY.REPORTS,
          adminId,
          oldStatus,
          newStatus: 'Completed',
          description: 'Admin updated the resident-visible report response while completing the report.',
        },
        client
      );
    }

    return {
      report: updatedReport,
      clearedPersonnelIds,
      approvedPersonnelIds: notificationPersonnelIds,
      previousAssignmentIds: ids,
      responseChanged,
      events: [
        notificationService.NOTIFICATION_TYPES.REPORT_COMPLETED,
        ...(responseChanged
          ? [notificationService.NOTIFICATION_TYPES.ADMIN_RESPONSE_UPDATED]
          : []),
      ],
    };
  });

  const notifications = await notifyResidentEventsSafely({
    report: result.report,
    events: result.events,
    requestId,
  });

  await notifyPersonnelApprovalSafely({
    personnelIds: result.approvedPersonnelIds,
    report: result.report,
    requestId,
  });

  return { ...result, notifications };
};

/**
 * Sends a report back to the cleaner after an administrator reviews the
 * finished work and is not satisfied.
 *
 * The report returns to In Progress and the cleaner's completed assignment is
 * reopened to IN_PROGRESS so it reappears as their current task. The old AFTER
 * photos are removed, because the user chose a clean resubmission; BEFORE photos
 * are kept so the cleaner does not have to re-photograph the original condition.
 *
 * The administrator's note is written to `personnel_note`, the personnel-only
 * channel, and pushed to the cleaner. It deliberately does NOT touch
 * `admin_response` and raises no resident notification: the note is internal
 * review feedback ("the after photos do not show the drain was cleared"), and
 * writing it into the resident-facing field used to show the reporter feedback
 * that was never meant for them while claiming their admin had replied.
 */
const requestPersonnelReportRevision = async ({
  reportId: rawReportId,
  updatedByAdminId: rawAdminId,
  adminResponse,
  requestId = null,
}) => {
  const reportId = normalizeReportId(rawReportId);
  const adminId = requireAdminId(rawAdminId);
  const revisionNote = String(adminResponse || '').trim();
  if (!revisionNote) {
    throw createHttpError(400, 'A revision note is required.');
  }

  const result = await withTransaction(async (client) => {
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

    if (reportStatus(report) !== 'under review') {
      throw createHttpError(
        409,
        'Only a report that is Under Review can be sent back for revision.'
      );
    }

    const ids = reportAssignmentIds(report);
    const revisionPersonnelIds = personnelIds(ids);
    if (revisionPersonnelIds.length === 0) {
      throw createHttpError(409, 'This report has no personnel to revise.');
    }

    const oldStatus = report.status;
    const updatedReport = await reportRepository.updateReport(
      report.report_id,
      { status: 'In Progress', personnelResponse: revisionNote },
      client
    );
    if (!updatedReport) {
      throw createHttpError(404, 'Report not found.');
    }

    const reopened = await personnelAssignmentRepository.reopenCompletedForReport(
      report.report_id,
      client
    );
    const reopenedPersonnelIds = personnelIds(
      reopened.map((row) => row.personnel_id)
    );

    const removedEvidence = [];
    for (const row of reopened) {
      const deleted = await personnelEvidenceRepository.deleteAfterForAssignment(
        row.assignment_id,
        client
      );
      removedEvidence.push(...deleted);
    }

    await writeAssignmentHistory({
      client,
      report,
      adminId,
      action: 'REVISION_REQUESTED',
      oldStatus,
      newStatus: 'In Progress',
      description: `Admin requested a revision for report '${report.title}'.`,
      // Cleaning, not Assignments: the change is to the cleaning that has to be
      // redone, which is what the administrator's Cleaning tab is about.
      category: HISTORY_CATEGORY.CLEANING,
    });
    // No ADMIN_RESPONSE_UPDATED history row: nothing the resident can see
    // changed. The reporter's timeline only records the status move.

    return {
      report: updatedReport,
      // Notify every cleaner recorded on the report, whether or not a completed
      // row still existed to reopen.
      revisionPersonnelIds: uniqueUpper([
        ...reopenedPersonnelIds,
        ...revisionPersonnelIds,
      ]),
      removedEvidenceUrls: removedEvidence
        .map((row) => row.image_url)
        .filter(Boolean),
    };
  });

  await notifyPersonnelRevisionSafely({
    personnelIds: result.revisionPersonnelIds,
    report: result.report,
    notes: revisionNote,
    requestId,
  });

  // The rows are already gone; release the stored assets best-effort so an
  // orphaned AFTER photo cannot be served from the old submission.
  for (const url of result.removedEvidenceUrls) {
    try {
      await cloudinaryService.destroyImage(url);
    } catch (cleanupError) {
      logError(
        requestId,
        'EVIDENCE_STORAGE',
        `Unable to delete revised evidence photo asset: ${cleanupError.message}`
      );
    }
  }

  return result;
};

module.exports = {
  assignPersonnelToReport,
  reassignPersonnelToReport,
  unassignPersonnelFromReport,
  unassignPersonnel: unassignPersonnelFromReport,
  releaseReportAssignment,
  getReportAssignment,
  getAssignment: getReportAssignment,
  completePersonnelReport,
  requestPersonnelReportRevision,
  mapAssignmentReport,
  buildAssignmentDetails,
};

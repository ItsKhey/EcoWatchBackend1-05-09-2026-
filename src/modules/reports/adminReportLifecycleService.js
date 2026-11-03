const { withTransaction } = require('../../config/db');
const reportRepository = require('./reportRepository');
const archivedReportRepository = require('./archivedReportRepository');
const trashReportRepository = require('./trashReportRepository');
const personnelRepository = require('../personnel/personnelRepository');
const historyRepository = require('../history/historyRepository');
const { createHttpError } = require('../../shared/personnelValidation');
const { normalizeReportId } = require('./reportAssignmentValidation');
const { DEFAULT_WASTE_SCALE } = require('../../shared/wasteScaleValidation');
const { CATEGORY: HISTORY_CATEGORY } = require('../../shared/historyActions');

// Share the assignment command lock so lifecycle moves cannot race an
// assign/reassign/complete transaction.
const LIFECYCLE_LOCK = 'myecowatch:phase-2b:assignment-command:v1';
const MAX_BULK_IDS = 100;

const uniqueUpper = (values) => [
  ...new Set(
    (Array.isArray(values) ? values : [])
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean)
  ),
];

const parseLegacyAssignmentIds = (value) => {
  if (Array.isArray(value)) return uniqueUpper(value);

  if (typeof value !== 'string' || !value.trim()) return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return uniqueUpper(parsed);
  } catch (error) {
    // Continue with the legacy comma-separated representation.
  }

  return uniqueUpper(value.split(','));
};

const assignmentIds = (report) => uniqueUpper([
  report?.assigned_personnel_id,
  ...parseLegacyAssignmentIds(report?.assigned_personnel_ids),
  report?.handled_by_id,
]);

const statusKey = (report) =>
  String(report?.status || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

const shouldReturnToPending = (report) => statusKey(report) === 'in progress';

const normalizeReport = (report, sourceCollection = 'reports') => {
  if (!report) return null;

  const source = sourceCollection;
  return {
    ...report,
    reportId: report.report_id,
    mongoId: report.report_id,
    residentId: report.resident_id,
    assignedPersonnelIds: parseLegacyAssignmentIds(report.assigned_personnel_ids),
    assignedPersonnelId: report.assigned_personnel_id || null,
    assignedByAdminId: report.assigned_by_admin_id || null,
    assignedAt: report.assigned_at || null,
    adminResponse: report.admin_response || '',
    wasteScale: report.waste_scale || DEFAULT_WASTE_SCALE,
    assignedTeamId: report.assigned_team_id || null,
    assignedVehicleId: report.assigned_vehicle_id || null,
    isDeleted: source === 'trash_reports' || report.is_deleted === true,
    isArchived: source === 'archived_reports' || report.is_archived === true,
    isRestored: report.is_restored === true || report.restored_at != null,
    sourceCollection: source,
  };
};

const assignmentClearUpdates = (report) => ({
  assignedPersonnelIds: [],
  assignedPersonnelId: null,
  handledById: null,
  // Keep the last assignment audit fields for history/reporting. They do not
  // represent an active assignment and are intentionally not used to infer one.
  assignedByAdminId: report.assigned_by_admin_id || null,
  assignedAt: report.assigned_at || null,
  // The crew and the truck go with the people: a lifecycle move releases the
  // dispatch, so nothing may be left pointing at a crew that is not working.
  assignedTeamId: null,
  assignedVehicleId: null,
  status: shouldReturnToPending(report) ? 'Pending' : report.status || 'Pending',
});

const activeReportInput = (report, overrides = {}) => ({
  reportId: report.report_id,
  residentId: report.resident_id,
  title: report.title,
  category: report.category,
  description: report.description,
  latitude: report.latitude,
  longitude: report.longitude,
  imageUrl: report.image_url,
  status: report.status || 'Pending',
  adminResponse: report.admin_response || '',
  assignedPersonnelIds: parseLegacyAssignmentIds(report.assigned_personnel_ids),
  assignedPersonnelId: report.assigned_personnel_id || null,
  assignedByAdminId: report.assigned_by_admin_id || null,
  assignedAt: report.assigned_at || null,
  priority: report.priority || 'Normal',
  // The scale is the resident's own label for the problem, so it travels with
  // the report between collections.
  wasteScale: report.waste_scale || DEFAULT_WASTE_SCALE,
  assignedTeamId: report.assigned_team_id || null,
  assignedVehicleId: report.assigned_vehicle_id || null,
  isDeleted: false,
  deletedAt: null,
  isArchived: false,
  isRestored: true,
  handledById: report.handled_by_id || null,
  resolutionImageUrl: report.resolution_image_url || null,
  resolvedAt: report.resolved_at || null,
  ...overrides,
});

const archiveReportInput = (report, overrides = {}) => ({
  reportId: report.report_id,
  residentId: report.resident_id,
  title: report.title,
  category: report.category,
  description: report.description,
  latitude: report.latitude,
  longitude: report.longitude,
  imageUrl: report.image_url,
  status: report.status || 'Pending',
  adminResponse: report.admin_response || '',
  assignedPersonnelIds: [],
  assignedPersonnelId: null,
  assignedByAdminId: report.assigned_by_admin_id || null,
  assignedAt: report.assigned_at || null,
  priority: report.priority || 'Normal',
  wasteScale: report.waste_scale || DEFAULT_WASTE_SCALE,
  assignedTeamId: null,
  assignedVehicleId: null,
  deletedAt: null,
  restoredAt: null,
  ...overrides,
});

const findReportState = async (reportId, client) => {
  // The advisory lock serializes the whole lifecycle command. The fixed row
  // order below then prevents a report/personnel deadlock with assignment
  // commands that lock the report first.
  const active = await reportRepository.findByReportIdForUpdate(reportId, client);
  const archived = await archivedReportRepository.findByReportIdForUpdate(
    reportId,
    client
  );
  const trash = await trashReportRepository.findByReportIdForUpdate(reportId, client);

  if (active) {
    if (active.is_deleted === true || trash) {
      return { report: active, source: 'trash_reports', active, trash };
    }
    // A non-deleted active row is authoritative even if a stale archive copy
    // remains from an interrupted legacy move.
    return { report: active, source: 'reports', active, archived, trash };
  }

  if (archived) {
    return { report: archived, source: 'archived_reports', trash };
  }

  // A trash marker without its report row is an orphaned legacy record. It is
  // not safe to reconstruct a report from the marker alone, so report it as
  // missing and let the caller decide whether to clean it up separately.
  return null;
};

const clearPersonnelAssignments = async ({
  report,
  reportId,
  adminId,
  client,
}) => {
  const ids = assignmentIds(report);
  const locked = await personnelRepository.findForAssignmentLocks(
    ids,
    reportId,
    { queryable: client }
  );
  const lockedIds = uniqueUpper([
    ...ids,
    ...locked.map((row) => row.personnel_id),
  ]);

  const cleared = await personnelRepository.clearCurrentAssignmentsForReport(
    reportId,
    adminId,
    client,
    lockedIds.length ? { personnelIds: lockedIds } : {}
  );

  return [...new Set([...lockedIds, ...cleared])];
};

const writeLifecycleHistory = async ({
  client,
  report,
  reportId,
  adminId,
  action,
  oldStatus,
  newStatus,
  description,
}) => {
  await historyRepository.createHistory(
    {
      residentId: report.resident_id,
      reportId,
      action,
      // Every lifecycle move here is a report decision. Stated rather than
      // derived so an action constant reused elsewhere cannot move these rows to
      // a different tab.
      category: HISTORY_CATEGORY.REPORTS,
      adminId,
      oldStatus,
      newStatus,
      description: `${description} (administrator: ${adminId})`,
    },
    client
  );
};

const replaceStaleArchive = async (reportId, client) => {
  // A previous interrupted deployment could leave both rows. The active row
  // is authoritative, so remove only the stale archive before recreating it.
  await archivedReportRepository.deleteByReportId(reportId, client);
};

const moveToTrash = async ({ state, reportId, adminId, client }) => {
  const { report, source } = state;
  await clearPersonnelAssignments({ report, reportId, adminId, client });

  if (source === 'trash_reports') {
    const current = state.active || report;
    await reportRepository.updateReport(
      reportId,
      {
        ...assignmentClearUpdates(current),
        isDeleted: true,
        deletedAt: current.deleted_at || new Date(),
        isArchived: false,
      },
      client
    );
    if (!state.trash) {
      await trashReportRepository.createTrashRecord(
        { reportId, residentId: current.resident_id },
        client
      );
    }
    return reportRepository.findByReportIdForUpdate(reportId, client) || current;
  }

  let currentReport = report;
  if (source === 'archived_reports') {
    currentReport = await reportRepository.createReport(
      activeReportInput(report, assignmentClearUpdates(report)),
      client
    );
    await archivedReportRepository.deleteByReportId(reportId, client);
  } else {
    currentReport = await reportRepository.updateReport(
      reportId,
      {
        ...assignmentClearUpdates(report),
        isDeleted: true,
        deletedAt: new Date(),
        isArchived: false,
      },
      client
    );
  }

  await trashReportRepository.createTrashRecord(
    { reportId, residentId: currentReport.resident_id },
    client
  );

  return currentReport;
};

const moveToArchive = async ({ state, reportId, adminId, client }) => {
  const { report, source } = state;
  await clearPersonnelAssignments({ report, reportId, adminId, client });

  if (source === 'archived_reports') {
    const cleared = await archivedReportRepository.updateByReportId(
      reportId,
      {
        assignedPersonnelIds: [],
        assignedPersonnelId: null,
        assignedByAdminId: report.assigned_by_admin_id || null,
        assignedAt: report.assigned_at || null,
        status: shouldReturnToPending(report) ? 'Pending' : report.status,
      },
      client
    );
    return cleared || report;
  }

  let currentReport = report;
  if (source === 'trash_reports') {
    if (state.trash) {
      await trashReportRepository.deleteByReportId(reportId, client);
    }
    currentReport = await reportRepository.updateReport(
      reportId,
      {
        ...assignmentClearUpdates(report),
        isDeleted: false,
        deletedAt: null,
        isArchived: false,
      },
      client
    );
  } else {
    currentReport = await reportRepository.updateReport(
      reportId,
      assignmentClearUpdates(report),
      client
    );
  }

  await replaceStaleArchive(reportId, client);
  const archived = await archivedReportRepository.createArchivedReport(
    archiveReportInput(currentReport),
    client
  );
  await reportRepository.deleteByReportId(reportId, client);
  return archived;
};

const restoreToInbox = async ({ state, reportId, adminId, client }) => {
  const { report, source } = state;
  await clearPersonnelAssignments({ report, reportId, adminId, client });

  if (source === 'reports') {
    if (report.is_archived || report.is_deleted) {
      return reportRepository.updateReport(
        reportId,
        {
          ...assignmentClearUpdates(report),
          isDeleted: false,
          deletedAt: null,
          isArchived: false,
          isRestored: true,
        },
        client
      );
    }
    return report;
  }

  if (source === 'trash_reports') {
    const restored = await reportRepository.updateReport(
      reportId,
      {
        ...assignmentClearUpdates(report),
        isDeleted: false,
        deletedAt: null,
        isArchived: false,
        isRestored: true,
      },
      client
    );
    await trashReportRepository.deleteByReportId(reportId, client);
    return restored;
  }

  const restored = await reportRepository.createReport(
    activeReportInput(report, assignmentClearUpdates(report)),
    client
  );
  if (state.trash) {
    await trashReportRepository.deleteByReportId(reportId, client);
  }
  await archivedReportRepository.deleteByReportId(reportId, client);
  return restored;
};

const permanentlyDelete = async ({ state, reportId, adminId, client }) => {
  const { report, source } = state;
  await clearPersonnelAssignments({ report, reportId, adminId, client });

  if (source === 'archived_reports') {
    if (state.trash) {
      await trashReportRepository.deleteByReportId(reportId, client);
    }
    // An archived row owns its own copy of the photo, so it has to be released
    // through the shared cleanup before the copy itself is removed.
    await reportRepository.releaseReportImage(reportId, client);
    await archivedReportRepository.deleteByReportId(reportId, client);
  } else {
    if (state.trash) {
      await trashReportRepository.deleteByReportId(reportId, client);
    }
    await reportRepository.permanentlyDeleteByReportId(reportId, client);
  }

  return report;
};

const executeLifecycle = async ({ rawReportId, action, adminId }) => {
  const reportId = normalizeReportId(rawReportId);
  if (!adminId || String(adminId).trim().length === 0) {
    throw createHttpError(403, 'Authenticated administrator identity is missing.');
  }

  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${LIFECYCLE_LOCK}'))`);
    const state = await findReportState(reportId, client);
    if (!state) {
      throw createHttpError(404, 'Report not found.');
    }

    const report = state.report;
    const oldStatus = report.status || 'Pending';
    let resultReport;
    let historyAction;
    let historyDescription;
    let newStatus = oldStatus;

    if (action === 'trash') {
      if (state.source === 'trash_reports') {
        resultReport = report;
        historyAction = 'MOVED_TO_TRASH';
        historyDescription = `Report '${report.title}' is already in trash.`;
      } else {
        resultReport = await moveToTrash({ state, reportId, adminId, client });
        historyAction = 'MOVED_TO_TRASH';
        historyDescription = `Report '${report.title}' moved to trash.`;
      }
      newStatus = resultReport.status || oldStatus;
    } else if (action === 'archive') {
      if (state.source === 'archived_reports') {
        resultReport = report;
        historyAction = 'ARCHIVED';
        historyDescription = `Report '${report.title}' is already archived.`;
      } else {
        resultReport = await moveToArchive({ state, reportId, adminId, client });
        historyAction = 'ARCHIVED';
        historyDescription = `Report '${report.title}' moved to archive.`;
      }
      newStatus = resultReport.status || oldStatus;
    } else if (action === 'restore') {
      if (state.source === 'reports'
          && !report.is_deleted
          && !report.is_archived) {
        resultReport = report;
        historyAction = 'RESTORED';
        historyDescription = `Report '${report.title}' is already in the inbox.`;
      } else {
        resultReport = await restoreToInbox({ state, reportId, adminId, client });
        historyAction = 'RESTORED';
        historyDescription = `Report '${report.title}' restored to inbox.`;
      }
      newStatus = resultReport.status || oldStatus;
    } else if (action === 'delete') {
      resultReport = await permanentlyDelete({ state, reportId, adminId, client });
      historyAction = 'PERMANENTLY_DELETED';
      historyDescription = `Report '${report.title}' permanently deleted.`;
      newStatus = 'Permanently Deleted';
    } else {
      throw createHttpError(400, 'Unsupported report lifecycle action.');
    }

    await writeLifecycleHistory({
      client,
      report,
      reportId,
      adminId,
      action: historyAction,
      oldStatus,
      newStatus,
      description: historyDescription,
    });

    const source = action === 'trash'
      ? 'trash_reports'
      : action === 'archive'
        ? 'archived_reports'
        : action === 'delete'
          ? state.source
          : 'reports';

    return {
      report: normalizeReport(resultReport, source),
      source,
    };
  });
};

const archiveReport = (options) => executeLifecycle({ ...options, action: 'archive' });
const trashReport = (options) => executeLifecycle({ ...options, action: 'trash' });
const restoreReport = (options) => executeLifecycle({ ...options, action: 'restore' });
const deleteReport = (options) => executeLifecycle({ ...options, action: 'delete' });

const bulkLifecycle = async ({ ids, action, adminId }) => {
  if (!['archive', 'trash', 'restore', 'delete'].includes(action)) {
    throw createHttpError(400, 'Unsupported report lifecycle action.');
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    throw createHttpError(400, 'ids must be a non-empty array of report IDs.');
  }
  if (ids.length > MAX_BULK_IDS) {
    throw createHttpError(400, `A bulk report action accepts at most ${MAX_BULK_IDS} IDs.`);
  }

  const normalizedIds = [...new Set(ids.map((id) => normalizeReportId(id)))];
  const results = [];
  let modifiedCount = 0;
  let skippedCount = 0;

  for (const reportId of normalizedIds) {
    try {
      const result = await executeLifecycle({ rawReportId: reportId, action, adminId });
      results.push(result);
      modifiedCount++;
    } catch (error) {
      if (error.statusCode === 404) {
        skippedCount++;
        continue;
      }
      throw error;
    }
  }

  const actionLabel = action === 'trash'
    ? 'moved to trash'
    : action === 'archive'
      ? 'archived'
      : action === 'restore'
        ? 'restored'
        : 'permanently deleted';

  return {
    message: `${modifiedCount} report${modifiedCount === 1 ? '' : 's'} ${actionLabel}.`,
    modifiedCount,
    skippedCount,
    results,
  };
};

module.exports = {
  archiveReport,
  trashReport,
  restoreReport,
  deleteReport,
  bulkLifecycle,
  normalizeReport,
};

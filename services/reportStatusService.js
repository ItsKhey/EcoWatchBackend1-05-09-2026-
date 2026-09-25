const { withTransaction } = require('../config/db');
const reportRepository = require('../repositories/reportRepository');
const personnelRepository = require('../repositories/personnelRepository');
const historyRepository = require('../repositories/historyRepository');
const notificationService = require('./notificationService');
const { completePersonnelReport } = require('./reportAssignmentService');
const { createHttpError } = require('../utils/personnelValidation');
const { normalizeReportId } = require('../utils/reportAssignmentValidation');
const {
  ADMIN_REPORT_STATUSES,
  normalizeReportStatus,
} = require('../utils/reportStatusValidation');

const requireAdminId = (adminId) => {
  const normalized = String(adminId || '').trim();
  if (!normalized || normalized.length > 50) {
    throw createHttpError(403, 'Authenticated administrator identity is missing.');
  }
  return normalized;
};

const assignmentIds = (report) => {
  const ids = [];
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) ids.push(value.trim().toUpperCase());
  };
  add(report.assigned_personnel_id);
  add(report.handled_by_id);
  if (Array.isArray(report.assigned_personnel_ids)) {
    report.assigned_personnel_ids.forEach(add);
  } else if (typeof report.assigned_personnel_ids === 'string') {
    try {
      const parsed = JSON.parse(report.assigned_personnel_ids);
      if (Array.isArray(parsed)) parsed.forEach(add);
    } catch (error) {
      report.assigned_personnel_ids.split(',').forEach(add);
    }
  }
  return [...new Set(ids)];
};

const assertTransitionAllowed = (currentStatus, nextStatus, report) => {
  if (['denied', 'completed'].includes(currentStatus)) {
    throw createHttpError(409, `A ${currentStatus} report cannot change status.`);
  }
  if (nextStatus === ADMIN_REPORT_STATUSES.COMPLETED) {
    if (currentStatus !== ADMIN_REPORT_STATUSES.IN_PROGRESS) {
      throw createHttpError(409, 'Only an In Progress report can be completed.');
    }
    if (assignmentIds(report).length === 0) {
      throw createHttpError(409, 'Assign personnel before completing a report.');
    }
  }
  if (
    nextStatus === ADMIN_REPORT_STATUSES.IN_PROGRESS
    && currentStatus === ADMIN_REPORT_STATUSES.DENIED
  ) {
    throw createHttpError(409, 'A denied report cannot return to In Progress.');
  }
  if (
    nextStatus === ADMIN_REPORT_STATUSES.PENDING
    && assignmentIds(report).length > 0
  ) {
    throw createHttpError(409, 'Unassign personnel before returning a report to Pending.');
  }
};

const deliverEvents = async ({ events, report, requestId }) => {
  const results = [];
  for (const type of events) {
    results.push(await notificationService.createForReportEvent({
      reportId: report.report_id,
      type,
      report,
      requestId,
    }));
  }
  return results;
};

async function updateReportAdminStatus({
  reportId: rawReportId,
  status,
  adminResponse,
  adminId: rawAdminId,
  requestId = null,
}) {
  const reportId = normalizeReportId(rawReportId);
  const adminId = requireAdminId(rawAdminId);
  const nextStatus = normalizeReportStatus(status);
  if (!nextStatus) throw createHttpError(400, 'Invalid report status.');

  if (nextStatus === ADMIN_REPORT_STATUSES.COMPLETED) {
    return completePersonnelReport({
      reportId,
      updatedByAdminId: adminId,
      adminResponse,
      requestId,
    });
  }

  const result = await withTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('myecowatch:phase-2b:assignment-command:v1'))"
    );
    const report = await reportRepository.findByReportIdForUpdate(reportId, client);
    if (!report) throw createHttpError(404, 'Report not found.');
    if (report.is_deleted === true || report.is_archived === true) {
      throw createHttpError(409, 'Only active reports can change status.');
    }

    const currentStatus = normalizeReportStatus(report.status)
      || ADMIN_REPORT_STATUSES.PENDING;
    assertTransitionAllowed(currentStatus, nextStatus, report);

    const nextResponse = adminResponse === undefined
      ? report.admin_response || ''
      : String(adminResponse || '').trim();
    const statusChanged = currentStatus !== nextStatus;
    const responseChanged = nextResponse !== (report.admin_response || '');
    if (!statusChanged && !responseChanged) {
      return { report, events: [], statusChanged, responseChanged };
    }

    const updates = { status: nextStatus };
    if (adminResponse !== undefined) updates.adminResponse = nextResponse;
    if (nextStatus === ADMIN_REPORT_STATUSES.DENIED) {
      Object.assign(updates, {
        assignedPersonnelId: null,
        assignedPersonnelIds: [],
        handledById: null,
        resolvedAt: null,
      });
    }

    const updatedReport = await reportRepository.updateReport(
      report.report_id,
      updates,
      client
    );
    if (!updatedReport) throw createHttpError(404, 'Report not found.');

    if (nextStatus === ADMIN_REPORT_STATUSES.IN_PROGRESS) {
      const ids = assignmentIds(report);
      if (ids.length) {
        await personnelRepository.syncReportAssignments(
          {
            reportId: report.report_id,
            location: {
              latitude: report.latitude ?? null,
              longitude: report.longitude ?? null,
            },
            assignmentText: String(report.title || `Report ${report.report_id}`).slice(0, 255),
            assignedAt: report.assigned_at || new Date(),
            previousPersonnelIds: ids,
            nextPersonnelIds: ids,
            updatedByAdminId: adminId,
          },
          client
        );
      }
    }

    if (nextStatus === ADMIN_REPORT_STATUSES.DENIED) {
      await personnelRepository.clearCurrentAssignmentsForReport(
        report.report_id,
        adminId,
        client
      );
    }

    if (statusChanged) {
      await historyRepository.createHistory(
        {
          residentId: report.resident_id,
          reportId: report.report_id,
          action: 'STATUS_CHANGED',
          oldStatus: report.status,
          newStatus: nextStatus,
          description: `Admin changed report status from ${report.status} to ${nextStatus}.`,
        },
        client
      );
    }
    if (responseChanged) {
      await historyRepository.createHistory(
        {
          residentId: report.resident_id,
          reportId: report.report_id,
          action: 'ADMIN_RESPONSE_UPDATED',
          oldStatus: report.status,
          newStatus: nextStatus,
          description: 'Admin updated the resident-visible report response.',
        },
        client
      );
    }

    const events = [];
    if (statusChanged && nextStatus === ADMIN_REPORT_STATUSES.IN_PROGRESS) {
      events.push(notificationService.NOTIFICATION_TYPES.CLEANING_STARTED);
    }
    if (statusChanged && nextStatus === ADMIN_REPORT_STATUSES.DENIED) {
      events.push(notificationService.NOTIFICATION_TYPES.REPORT_DENIED);
    }
    if (responseChanged) {
      events.push(notificationService.NOTIFICATION_TYPES.ADMIN_RESPONSE_UPDATED);
    }

    return { report: updatedReport, events, statusChanged, responseChanged };
  });

  const notifications = await deliverEvents({
    events: result.events,
    report: result.report,
    requestId,
  });
  return { ...result, notifications };
}

async function updateReportAdminResponse({
  reportId: rawReportId,
  adminResponse,
  adminId: rawAdminId,
  requestId = null,
}) {
  const reportId = normalizeReportId(rawReportId);
  const adminId = requireAdminId(rawAdminId);
  const nextResponse = String(adminResponse || '').trim();
  if (!nextResponse) throw createHttpError(400, 'adminResponse is required.');

  const result = await withTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('myecowatch:phase-2b:assignment-command:v1'))"
    );
    const report = await reportRepository.findByReportIdForUpdate(reportId, client);
    if (!report) throw createHttpError(404, 'Report not found.');
    if (report.is_deleted === true || report.is_archived === true) {
      throw createHttpError(409, 'Only active reports can be updated.');
    }
    if (['denied', 'completed'].includes(normalizeReportStatus(report.status))) {
      throw createHttpError(409, 'A closed report response cannot be changed.');
    }
    if ((report.admin_response || '') === nextResponse) {
      return { report, events: [], responseChanged: false };
    }

    const updatedReport = await reportRepository.updateReport(
      report.report_id,
      { adminResponse: nextResponse },
      client
    );
    await historyRepository.createHistory(
      {
        residentId: report.resident_id,
        reportId: report.report_id,
        action: 'ADMIN_RESPONSE_UPDATED',
        oldStatus: report.status,
        newStatus: report.status,
        description: 'Admin updated the resident-visible report response.',
      },
      client
    );
    return {
      report: updatedReport,
      events: [notificationService.NOTIFICATION_TYPES.ADMIN_RESPONSE_UPDATED],
      responseChanged: true,
    };
  });

  const notifications = await deliverEvents({
    events: result.events,
    report: result.report,
    requestId,
  });
  return { ...result, notifications };
}

module.exports = {
  updateReportAdminStatus,
  updateReportAdminResponse,
};

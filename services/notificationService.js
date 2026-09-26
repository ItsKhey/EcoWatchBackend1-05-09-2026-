const notificationRepository = require('../repositories/notificationRepository');
const reportRepository = require('../repositories/reportRepository');
const adminRepository = require('../repositories/adminRepository');
const residentRepository = require('../repositories/residentRepository');
const fcmService = require('./fcmService');
const { createHttpError } = require('../utils/personnelValidation');
const { logError, logInfo } = require('../utils/logger');

const NOTIFICATION_TYPES = Object.freeze({
  PERSONNEL_ASSIGNED: 'PERSONNEL_ASSIGNED',
  PERSONNEL_UNASSIGNED: 'PERSONNEL_UNASSIGNED',
  CLEANING_STARTED: 'CLEANING_STARTED',
  ADMIN_RESPONSE_UPDATED: 'ADMIN_RESPONSE_UPDATED',
  REPORT_DENIED: 'REPORT_DENIED',
  REPORT_COMPLETED: 'REPORT_COMPLETED',
  // Phase 3A — admin-facing event created when a resident submits a report.
  NEW_REPORT: 'NEW_REPORT',
  // Resident-facing event created when CENRO publishes an announcement.
  ANNOUNCEMENT: 'ANNOUNCEMENT',
});

/** Event types that are delivered to administrators, not residents. */
const ADMIN_EVENT_TYPES = Object.freeze([NOTIFICATION_TYPES.NEW_REPORT]);

/** Event types that are broadcasts rather than events about one report. */
const BROADCAST_EVENT_TYPES = Object.freeze([NOTIFICATION_TYPES.ANNOUNCEMENT]);

const cleanText = (value, maxLength) =>
  String(value || '')
    .trim()
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);

const reportReference = (report) => `Report ID: ${report.report_id}`;

const eventContent = (type, report) => {
  const response = cleanText(report.admin_response, 500);
  switch (type) {
    case NOTIFICATION_TYPES.PERSONNEL_ASSIGNED:
      return {
        title: 'Personnel Assigned',
        message: `Cleanup personnel have been assigned to your report. ${reportReference(report)}`,
      };
    case NOTIFICATION_TYPES.PERSONNEL_UNASSIGNED:
      return {
        title: 'Assignment Removed',
        message: `The assigned personnel were removed and your report returned to Pending. ${reportReference(report)}`,
      };
    case NOTIFICATION_TYPES.CLEANING_STARTED:
      return {
        title: 'Cleaning Started',
        message: `Cleaning operations have started for your report. ${reportReference(report)}`,
      };
    case NOTIFICATION_TYPES.ADMIN_RESPONSE_UPDATED:
      return {
        title: 'Admin Response Updated',
        message: response
          ? `${response} ${reportReference(report)}`
          : `The CENRO response for your report was updated. ${reportReference(report)}`,
      };
    case NOTIFICATION_TYPES.REPORT_DENIED:
      return {
        title: 'Report Denied',
        message: response
          ? `Your report was denied. ${response} ${reportReference(report)}`
          : `Your report was denied by the CENRO. ${reportReference(report)}`,
      };
    case NOTIFICATION_TYPES.REPORT_COMPLETED:
      return {
        title: 'Report Completed',
        message: `Cleanup is complete and your report has been resolved. ${reportReference(report)}`,
      };
    case NOTIFICATION_TYPES.NEW_REPORT:
      return {
        title: 'New Report Submitted',
        message: `A resident submitted a new report. ${reportReference(report)}`,
      };
    default:
      throw createHttpError(400, 'Unsupported notification event type.');
  }
};

function isAdminEventType(type) {
  return ADMIN_EVENT_TYPES.includes(type);
}

/**
 * Copy for a published announcement.
 *
 * <p>Kept separate from {@link eventContent} because that function is
 * report-shaped: every branch it has interpolates a report id, and an
 * announcement has no report. Building announcement copy by faking a report
 * object would have put a bogus "Report ID: undefined" in front of every
 * resident's notification.
 *
 * <p>The title is the announcement's own title so the notice is recognisable
 * in the shade, and the body is the message trimmed to something a notification
 * can actually show.
 */
const announcementContent = (announcement) => ({
  title: cleanText(announcement.title, 80) || 'CENRO Announcement',
  message: cleanText(announcement.message, 200),
});

function isBroadcastEventType(type) {
  return BROADCAST_EVENT_TYPES.includes(type);
}

function normalizeEventType(value) {
  const type = String(value || '').trim().toUpperCase();
  if (!Object.values(NOTIFICATION_TYPES).includes(type)) {
    throw createHttpError(
      400,
      'type must be a supported server report event.'
    );
  }
  return type;
}

function validateCreateEventRequest(body = {}) {
  const forbidden = [
    'residentId',
    'resident_id',
    'title',
    'message',
    'isRead',
    'is_read',
    'createdAt',
    'created_at',
  ].filter((key) => Object.prototype.hasOwnProperty.call(body, key));
  if (forbidden.length > 0) {
    throw createHttpError(
      400,
      `Notification content is server-owned; remove: ${forbidden.join(', ')}.`
    );
  }

  const reportId = String(body.reportId || body.report_id || '').trim();
  if (!reportId || reportId.length > 100) {
    throw createHttpError(400, 'A valid reportId is required.');
  }
  const type = normalizeEventType(body.type);
  // Broadcasts are server-generated when CENRO publishes an announcement, so
  // they must not be creatable by hand through the report-event route.
  if (isBroadcastEventType(type)) {
    throw createHttpError(400, 'type must be a supported server report event.');
  }
  return { reportId, type };
}

async function createForReportEvent({
  reportId,
  type: rawType,
  report: suppliedReport = null,
  requestId = null,
}) {
  const type = normalizeEventType(rawType);
  if (isBroadcastEventType(type)) {
    // A broadcast is not a report event. Letting it through here would attach a
    // broadcast notification to an unrelated report.
    throw createHttpError(400, 'type must be a supported server report event.');
  }
  const normalizedReportId = String(reportId || suppliedReport?.report_id || '').trim();
  if (!normalizedReportId || normalizedReportId.length > 100) {
    throw createHttpError(400, 'A valid reportId is required.');
  }

  const report = suppliedReport || await reportRepository.findByReportId(normalizedReportId);
  if (!report || report.resident_id == null) {
    throw createHttpError(404, 'Report not found.');
  }
  if (String(report.report_id).toLowerCase() !== normalizedReportId.toLowerCase()) {
    throw createHttpError(404, 'Report not found.');
  }

  const content = eventContent(type, report);
  const notification = await notificationRepository.createNotification({
    residentId: report.resident_id,
    reportId: report.report_id,
    title: content.title,
    message: content.message,
    type,
  });

  let push = { skipped: true, reason: 'NOT_ATTEMPTED' };
  try {
    push = await fcmService.sendResidentReportNotification({
      residentId: report.resident_id,
      notificationId: notification.notification_id,
      reportId: report.report_id,
      type,
      title: content.title,
      message: content.message,
      createdAt: notification.created_at,
    });
  } catch (error) {
    // The durable in-app row is already committed. Push availability must not
    // roll back a report assignment, status, or response update.
    logError(
      requestId,
      'FCM_DELIVERY',
      `Unable to send ${type} notification for report ${report.report_id}: ${error.message}`
    );
    push = { delivered: false, reason: 'SEND_FAILED' };
  }

  return { notification, push };
}

/**
 * Phase 3A — creates the admin-facing notification for a newly submitted report
 * and broadcasts it to every bound administrator device.
 *
 * Deliberately never throws for the push step: the report is already committed,
 * so a notification or FCM failure is logged and reconciled by the Admin app's
 * own REST sync rather than failing the resident's submission.
 */
async function createForAdminReportEvent({
  reportId,
  type: rawType,
  report: suppliedReport = null,
  requestId = null,
}) {
  const type = normalizeEventType(rawType);
  if (!isAdminEventType(type)) {
    throw createHttpError(400, 'type must be an administrator report event.');
  }

  const normalizedReportId = String(reportId || suppliedReport?.report_id || '').trim();
  if (!normalizedReportId || normalizedReportId.length > 100) {
    throw createHttpError(400, 'A valid reportId is required.');
  }

  const report = suppliedReport || await reportRepository.findByReportId(normalizedReportId);
  if (!report) {
    throw createHttpError(404, 'Report not found.');
  }

  const content = eventContent(type, report);
  const adminRecipients = await adminRepository.findAllFcmTokens();
  const results = [];

  for (const recipient of adminRecipients) {
    // The owner column is the account ID, so an administrator reads the same
    // rows back through the shared notification center.
    try {
      const notification = await notificationRepository.createNotification({
        residentId: recipient.adminId,
        reportId: report.report_id,
        title: content.title,
        message: content.message,
        type,
      });
      results.push({ adminId: recipient.adminId, notification });
    } catch (error) {
      logError(
        requestId,
        'NEW_REPORT_NOTIFICATION',
        `Unable to persist ${type} for admin ${recipient.adminId}: ${error.message}`
      );
    }
  }

  const firstNotification = results.find((entry) => entry.notification)?.notification || null;

  let push = { skipped: true, reason: 'NOT_ATTEMPTED' };
  try {
    push = await fcmService.sendAdminNewReportNotification({
      notificationId: firstNotification?.notification_id ?? normalizedReportId,
      reportId: report.report_id,
      type,
      title: content.title,
      message: content.message,
      createdAt: firstNotification?.created_at || new Date().toISOString(),
      requestId,
    });
  } catch (error) {
    logError(
      requestId,
      'FCM_ADMIN_BROADCAST',
      `Unable to broadcast ${type} for report ${report.report_id}: ${error.message}`
    );
    push = { delivered: false, reason: 'SEND_FAILED' };
  }

  logInfo(
    requestId,
    'NEW_REPORT',
    `reportId=${report.report_id} recipients=${results.length} tokenCount=${push.tokenCount ?? adminRecipients.length} delivered=${push.successCount ?? 0} reason=${push.reason || 'SENT'}`
  );

  return {
    type,
    notification: firstNotification,
    recipients: results.map((entry) => entry.adminId),
    push,
  };
}

/**
 * Creates one in-app notification per resident and pushes the announcement to
 * their devices.
 *
 * <p>Each resident gets their own row so the announcement shows up in that
 * resident's own Alerts list and can be marked read independently, which is the
 * same reason the administrator broadcast writes a row per recipient.
 *
 * <p>Never throws for the push step: the announcement is already committed by
 * the time this runs, so an FCM failure is logged and the Resident app's own
 * REST sync reconciles the missing notification. Only a failure to read the
 * resident list is surfaced to the caller, and even that is logged rather than
 * thrown so publishing an announcement can never fail because of notifications.
 */
async function createForResidentAnnouncementEvent({
  announcement,
  requestId = null,
}) {
  const type = NOTIFICATION_TYPES.ANNOUNCEMENT;

  if (!announcement || announcement.announcementId == null) {
    throw createHttpError(400, 'A published announcement is required.');
  }

  const content = announcementContent(announcement);

  let recipients;
  try {
    recipients = await residentRepository.findAllFcmTokens();
  } catch (error) {
    logError(
      requestId,
      'ANNOUNCEMENT_NOTIFICATION',
      `Unable to read resident tokens for announcement ${announcement.announcementId}: ${error.message}`
    );
    return { type, recipients: [], push: { skipped: true, reason: 'TOKEN_LOOKUP_FAILED' } };
  }

  // A resident without a bound device still gets the in-app row, so the
  // announcement still reaches them the next time they open the app.
  const results = [];
  const pushRecipients = [];

  for (const recipient of recipients) {
    try {
      const notification = await notificationRepository.createNotification({
        residentId: recipient.residentId,
        // An announcement is not about a report, so the FK stays null.
        reportId: null,
        title: content.title,
        message: content.message,
        type,
      });
      results.push({ residentId: recipient.residentId, notification });
      pushRecipients.push({
        residentId: recipient.residentId,
        token: recipient.token,
        notificationId: notification.notification_id,
      });
    } catch (error) {
      logError(
        requestId,
        'ANNOUNCEMENT_NOTIFICATION',
        `Unable to persist ${type} for resident ${recipient.residentId}: ${error.message}`
      );
    }
  }

  let push = { skipped: true, reason: 'NOT_ATTEMPTED' };
  try {
    push = await fcmService.sendResidentAnnouncementNotification({
      recipients: pushRecipients,
      announcementId: announcement.announcementId,
      type,
      title: content.title,
      message: content.message,
      createdAt: results[0]?.notification?.created_at || new Date().toISOString(),
      requestId,
    });
  } catch (error) {
    logError(
      requestId,
      'FCM_RESIDENT_BROADCAST',
      `Unable to broadcast ${type} for announcement ${announcement.announcementId}: ${error.message}`
    );
    push = { delivered: false, reason: 'SEND_FAILED' };
  }

  logInfo(
    requestId,
    'ANNOUNCEMENT',
    `announcementId=${announcement.announcementId} recipients=${results.length} `
    + `tokenCount=${push.tokenCount ?? pushRecipients.length} `
    + `delivered=${push.successCount ?? 0} reason=${push.reason || 'SENT'}`
  );

  return {
    type,
    recipients: results.map((entry) => entry.residentId),
    push,
  };
}

module.exports = {
  NOTIFICATION_TYPES,
  ADMIN_EVENT_TYPES,
  BROADCAST_EVENT_TYPES,
  createForReportEvent,
  createForAdminReportEvent,
  createForResidentAnnouncementEvent,
  eventContent,
  announcementContent,
  isAdminEventType,
  isBroadcastEventType,
  normalizeEventType,
  validateCreateEventRequest,
};

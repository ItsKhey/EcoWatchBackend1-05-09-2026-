const notificationRepository = require('../repositories/notificationRepository');
const reportRepository = require('../repositories/reportRepository');
const fcmService = require('./fcmService');
const { createHttpError } = require('../utils/personnelValidation');
const { logError } = require('../utils/logger');

const NOTIFICATION_TYPES = Object.freeze({
  PERSONNEL_ASSIGNED: 'PERSONNEL_ASSIGNED',
  PERSONNEL_UNASSIGNED: 'PERSONNEL_UNASSIGNED',
  CLEANING_STARTED: 'CLEANING_STARTED',
  ADMIN_RESPONSE_UPDATED: 'ADMIN_RESPONSE_UPDATED',
  REPORT_DENIED: 'REPORT_DENIED',
  REPORT_COMPLETED: 'REPORT_COMPLETED',
});

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
    default:
      throw createHttpError(400, 'Unsupported notification event type.');
  }
};

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
  return { reportId, type: normalizeEventType(body.type) };
}

async function createForReportEvent({
  reportId,
  type: rawType,
  report: suppliedReport = null,
  requestId = null,
}) {
  const type = normalizeEventType(rawType);
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

module.exports = {
  NOTIFICATION_TYPES,
  createForReportEvent,
  eventContent,
  normalizeEventType,
  validateCreateEventRequest,
};

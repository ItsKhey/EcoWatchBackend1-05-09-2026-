const personnelNotificationRepository = require('./personnelNotificationRepository');
const fcmService = require('../../shared/fcmService');
const { createHttpError } = require('../../shared/personnelValidation');
const { logError, logInfo } = require('../../shared/logger');

/**
 * Personnel-facing notifications.
 *
 * Mirrors notificationService for the third role: the durable in-app row is
 * written first and a push is attempted afterwards, so a push outage can never
 * roll back an assignment the administrator already committed. The recipient
 * list is always derived from server state (the assignment rows the admin
 * service just wrote), never from the request body.
 */

const PERSONNEL_NOTIFICATION_TYPES = Object.freeze({
  ASSIGNMENT_ASSIGNED: 'ASSIGNMENT_ASSIGNED',
  ASSIGNMENT_UNASSIGNED: 'ASSIGNMENT_UNASSIGNED',
  ASSIGNMENT_APPROVED: 'ASSIGNMENT_APPROVED',
  ASSIGNMENT_REVISION_REQUESTED: 'ASSIGNMENT_REVISION_REQUESTED',
});

const cleanText = (value, maxLength) =>
  String(value || '')
    .trim()
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);

const taskLabel = (report, fallback = 'your assigned report') =>
  cleanText(report?.title, 120) || fallback;

const reportReference = (report) =>
  report?.report_id ? `Report ID: ${report.report_id}` : '';

const contentFor = (type, { report, notes }) => {
  const label = taskLabel(report);
  const reference = reportReference(report);
  const tail = reference ? ` ${reference}` : '';

  switch (type) {
    case PERSONNEL_NOTIFICATION_TYPES.ASSIGNMENT_ASSIGNED:
      return {
        title: 'New Cleaning Task',
        // The administrator's note for the cleaner is personnel-only, so it is
        // safe to quote here: it never reaches the resident who filed the report.
        message: notes
          ? `You have been assigned to '${label}': ${cleanText(notes, 300)}${tail}`
          : `You have been assigned to '${label}'.${tail}`,
      };
    case PERSONNEL_NOTIFICATION_TYPES.ASSIGNMENT_UNASSIGNED:
      return {
        title: 'Task Removed',
        message: `You are no longer assigned to '${label}'.${tail}`,
      };
    case PERSONNEL_NOTIFICATION_TYPES.ASSIGNMENT_APPROVED:
      return {
        title: 'Task Approved',
        message: `Your cleanup for '${label}' was approved.${tail}`,
      };
    case PERSONNEL_NOTIFICATION_TYPES.ASSIGNMENT_REVISION_REQUESTED:
      return {
        title: 'Revision Requested',
        message: notes
          ? `Your cleanup for '${label}' needs revision: ${cleanText(notes, 300)}${tail}`
          : `Your cleanup for '${label}' needs revision.${tail}`,
      };
    default:
      throw createHttpError(400, 'Unsupported personnel notification type.');
  }
};

/**
 * Pushes one already-persisted notification to the device bound to a personnel
 * account. Every failure is reported rather than thrown: the durable row is
 * committed and the in-app list reconciles the missing buzz on its own.
 */
async function pushNotification({ personnelId, notification, type, requestId }) {
  let token = null;

  try {
    token = await personnelNotificationRepository.findFcmToken(personnelId);
  } catch (error) {
    logError(
      requestId,
      'FCM_PERSONNEL',
      `Unable to read the device token for ${personnelId}: ${error.message}`
    );
  }

  if (!token) {
    return { skipped: true, reason: 'NO_TOKEN' };
  }

  try {
    const result = await fcmService.sendPersonnelNotification({
      personnelId,
      token,
      notificationId: notification.notification_id,
      assignmentId: notification.assignment_id,
      reportId: notification.report_id,
      type,
      title: notification.title,
      message: notification.message,
      createdAt: notification.created_at,
    });

    // A token Firebase no longer recognizes is cleared so it is not retried on
    // every future event.
    if (result && result.reason === 'INVALID_TOKEN') {
      try {
        await personnelNotificationRepository.clearFcmToken(personnelId, token);
      } catch (clearError) {
        logError(
          requestId,
          'FCM_PERSONNEL',
          `Unable to clear an invalid token for ${personnelId}: ${clearError.message}`
        );
      }
    }

    return result;
  } catch (error) {
    logError(
      requestId,
      'FCM_PERSONNEL',
      `Unable to send ${type} to ${personnelId}: ${error.message}`
    );
    return { delivered: false, reason: 'SEND_FAILED' };
  }
}

/**
 * Writes one personnel notification row and attempts delivery.
 *
 * Returns the durable row even when the push is skipped, so the caller can
 * report exactly what happened without the row being discarded.
 */
async function createForPersonnel({
  personnelId,
  type,
  assignmentId = null,
  report = null,
  reportId = null,
  notes = null,
  requestId = null,
}) {
  if (typeof personnelId !== 'string' || !personnelId.trim()) {
    throw createHttpError(400, 'A personnel recipient is required.');
  }

  const content = contentFor(type, { report, notes });
  const notification = await personnelNotificationRepository.create({
    personnelId,
    assignmentId,
    reportId: reportId || report?.report_id || null,
    title: content.title,
    message: content.message,
    type,
  });

  const push = await pushNotification({
    personnelId,
    notification,
    type,
    requestId,
  });

  return { notification, push };
}

const notifyAssignmentAssigned = ({
  personnelId,
  report,
  notes = null,
  requestId = null,
}) =>
  createForPersonnel({
    personnelId,
    type: PERSONNEL_NOTIFICATION_TYPES.ASSIGNMENT_ASSIGNED,
    report,
    notes,
    requestId,
  });

const notifyAssignmentUnassigned = ({ personnelId, report, requestId = null }) =>
  createForPersonnel({
    personnelId,
    type: PERSONNEL_NOTIFICATION_TYPES.ASSIGNMENT_UNASSIGNED,
    report,
    requestId,
  });

const notifyAssignmentApproved = ({ personnelId, report, requestId = null }) =>
  createForPersonnel({
    personnelId,
    type: PERSONNEL_NOTIFICATION_TYPES.ASSIGNMENT_APPROVED,
    report,
    requestId,
  });

/**
 * Tells a cleaner that the administrator reviewed their finished work and asked
 * for changes. The administrator's note is embedded in the message so the push
 * carries the reason even before the app fetches the task's adminResponse.
 */
const notifyAssignmentRevisionRequested = ({
  personnelId,
  report,
  notes = null,
  requestId = null,
}) =>
  createForPersonnel({
    personnelId,
    type: PERSONNEL_NOTIFICATION_TYPES.ASSIGNMENT_REVISION_REQUESTED,
    report,
    notes,
    requestId,
  });

/**
 * Registers the device FCM token for the authenticated personnel account. The
 * identity is server-owned: the caller never supplies a personnel id.
 */
async function registerDeviceToken(personnelId, token) {
  const claimed = await personnelNotificationRepository.claimFcmToken(
    personnelId,
    token
  );

  if (!claimed) {
    throw createHttpError(404, 'Personnel account not found.');
  }

  return true;
}

async function clearDeviceToken(personnelId) {
  return personnelNotificationRepository.clearFcmToken(personnelId);
}

module.exports = {
  PERSONNEL_NOTIFICATION_TYPES,
  contentFor,
  createForPersonnel,
  notifyAssignmentAssigned,
  notifyAssignmentUnassigned,
  notifyAssignmentApproved,
  notifyAssignmentRevisionRequested,
  registerDeviceToken,
  clearDeviceToken,
};

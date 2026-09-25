const notificationRepository = require('../repositories/notificationRepository');
const trashNotificationRepository = require('../repositories/trashNotificationRepository');
const residentRepository = require('../repositories/residentRepository');
const notificationService = require('../services/notificationService');
const { createHttpError } = require('../utils/personnelValidation');

const residentIdFromRequest = (req) => {
  const residentId = req.auth?.residentId || req.resident?.resident_id;
  if (!residentId) throw createHttpError(401, 'Resident identity is missing.');
  return residentId;
};

const mapNotification = (row, { trashed = false } = {}) => ({
  notificationId: String(row.notification_id),
  // Compatibility aliases for the existing Resident and Admin Android models.
  id: String(row.notification_id),
  mongoId: String(row.notification_id),
  residentId: row.resident_id,
  reportId: row.report_id || null,
  title: row.title,
  message: row.message,
  type: row.type,
  isRead: row.is_read === true,
  isDeleted: trashed || row.is_deleted === true,
  createdAt: row.created_at,
  deletedAt: trashed ? row.trashed_at || null : row.deleted_at || null,
});

const validateNotificationId = (value) => {
  const notificationId = String(value || '').trim();
  if (!/^\d{1,19}$/.test(notificationId)) {
    throw createHttpError(400, 'Invalid notification ID.');
  }
  return notificationId;
};

const getMyNotifications = async (req, res, next) => {
  try {
    const rows = await notificationRepository.findAllByResidentId(
      residentIdFromRequest(req),
      req.query.limit
    );
    res.set('Cache-Control', 'no-store');
    res.json(rows.map((row) => mapNotification(row)));
  } catch (error) {
    next(error);
  }
};

const getMyTrash = async (req, res, next) => {
  try {
    const rows = await notificationRepository.findTrashByResidentId(
      residentIdFromRequest(req),
      req.query.limit
    );
    res.set('Cache-Control', 'no-store');
    res.json(rows.map((row) => mapNotification(row, { trashed: true })));
  } catch (error) {
    next(error);
  }
};

const getUnreadCount = async (req, res, next) => {
  try {
    const unreadCount = await notificationRepository.countUnreadByResidentId(
      residentIdFromRequest(req)
    );
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, unreadCount });
  } catch (error) {
    next(error);
  }
};

const markAsRead = async (req, res, next) => {
  try {
    const notification = await notificationRepository.markAsRead(
      validateNotificationId(req.params.id),
      residentIdFromRequest(req)
    );
    if (!notification) throw createHttpError(404, 'Notification not found.');
    res.json({ success: true, notification: mapNotification(notification) });
  } catch (error) {
    next(error);
  }
};

const markAllAsRead = async (req, res, next) => {
  try {
    const rows = await notificationRepository.markAllAsRead(
      residentIdFromRequest(req)
    );
    res.json({ success: true, updatedCount: rows.length });
  } catch (error) {
    next(error);
  }
};

const updateFcmToken = async (req, res, next) => {
  try {
    const forbidden = ['residentId', 'resident_id']
      .filter((key) => Object.prototype.hasOwnProperty.call(req.body || {}, key));
    if (forbidden.length) {
      throw createHttpError(
        400,
        'Resident identity is server-owned; remove residentId from the request.'
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

    const claimed = await residentRepository.claimFcmToken(
      residentIdFromRequest(req),
      token
    );
    if (!claimed) throw createHttpError(404, 'Resident account not found.');
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

const clearFcmToken = async (req, res, next) => {
  try {
    await residentRepository.clearFcmToken(residentIdFromRequest(req));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
};

const createReportEvent = async (req, res, next) => {
  try {
    const input = notificationService.validateCreateEventRequest(req.body);
    const result = await notificationService.createForReportEvent({
      ...input,
      requestId: req.requestId,
    });
    res.status(201).json({
      success: true,
      notification: mapNotification(result.notification),
      push: result.push,
    });
  } catch (error) {
    next(error);
  }
};

const moveToTrash = async (req, res, next) => {
  try {
    const notificationId = validateNotificationId(req.params.id);
    const residentId = residentIdFromRequest(req);
    const notification = await notificationRepository.findOwnedById(
      notificationId,
      residentId
    );
    if (!notification) throw createHttpError(404, 'Notification not found.');

    const existingTrash = await trashNotificationRepository.findByNotificationId(
      notificationId,
      residentId
    );
    if (!existingTrash) {
      await trashNotificationRepository.createTrashNotification(
        notificationId,
        residentId
      );
    }
    res.json({ success: true, message: 'Notification moved to trash' });
  } catch (error) {
    next(error);
  }
};

const restoreNotification = async (req, res, next) => {
  try {
    const notificationId = validateNotificationId(req.params.id);
    const residentId = residentIdFromRequest(req);
    const notification = await notificationRepository.findOwnedById(
      notificationId,
      residentId
    );
    if (!notification) throw createHttpError(404, 'Notification not found.');

    await trashNotificationRepository.deleteByNotificationId(
      notificationId,
      residentId
    );
    res.json({ success: true, message: 'Notification restored' });
  } catch (error) {
    next(error);
  }
};

const deleteNotification = async (req, res, next) => {
  try {
    const deleted = await notificationRepository.deleteOwnedById(
      validateNotificationId(req.params.id),
      residentIdFromRequest(req)
    );
    if (!deleted) throw createHttpError(404, 'Notification not found.');
    res.json({ success: true, message: 'Notification permanently deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getMyNotifications,
  getMyTrash,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  updateFcmToken,
  clearFcmToken,
  createReportEvent,
  moveToTrash,
  restoreNotification,
  deleteNotification,
  mapNotification,
};

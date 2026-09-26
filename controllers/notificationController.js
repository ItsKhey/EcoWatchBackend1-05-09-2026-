const notificationRepository = require('../repositories/notificationRepository');
const notificationPreferenceRepository = require('../repositories/notificationPreferenceRepository');
const adminNotificationPreferenceRepository = require('../repositories/adminNotificationPreferenceRepository');
const trashNotificationRepository = require('../repositories/trashNotificationRepository');
const residentRepository = require('../repositories/residentRepository');
const notificationService = require('../services/notificationService');
const { createHttpError } = require('../utils/personnelValidation');

const residentIdFromRequest = (req) => {
  const residentId = req.auth?.residentId || req.resident?.resident_id;
  if (!residentId) throw createHttpError(401, 'Resident identity is missing.');
  return residentId;
};

/**
 * Fields the resident endpoints accept, with their expected type.
 *
 * <p>Explicit allowlist rather than iterating the request body: an unknown key is
 * a client bug, and silently storing it would let a typo'd field look like it
 * had been saved.
 */
const RESIDENT_PREFERENCE_FIELDS = Object.freeze({
  masterEnabled: 'boolean',
  reportStatusUpdates: 'boolean',
  reportCompleted: 'boolean',
  reportDenied: 'boolean',
  cenroAnnouncements: 'boolean',
  securityAlerts: 'boolean',
  soundEnabled: 'boolean',
  vibrationEnabled: 'boolean',
  soundUri: 'string',
});

/**
 * Fields the administrator endpoints accept.
 *
 * <p>A superset of the resident set: the Admin app exposes operations categories
 * the resident app has no equivalent for. Listed explicitly so a resident field
 * cannot be written through the admin endpoint by accident.
 */
const ADMIN_PREFERENCE_FIELDS = Object.freeze({
  masterEnabled: 'boolean',
  reportStatusUpdates: 'boolean',
  reportCompleted: 'boolean',
  reportDenied: 'boolean',
  cenroAnnouncements: 'boolean',
  securityAlerts: 'boolean',
  highPriorityReports: 'boolean',
  personnelAccepted: 'boolean',
  personnelCleaning: 'boolean',
  photoUpdates: 'boolean',
  awaitingApproval: 'boolean',
  archivedReports: 'boolean',
  maintenanceAlerts: 'boolean',
  soundEnabled: 'boolean',
  vibrationEnabled: 'boolean',
  soundUri: 'string',
});

/**
 * Normalises a preference body: accepts either casing, rejects fields the caller
 * is not allowed to set, and checks each value against its declared type.
 *
 * <p>Shared by the resident and administrator endpoints so both enforce the same
 * rules; only the allowed set and the repository differ.
 */
const parsePreferenceBody = (body, aliases, allowed) => {
  if (!body || typeof body !== 'object') {
    throw createHttpError(400, 'A preferences object is required.');
  }

  // Tolerate the snake_case the database uses so either casing round-trips.
  const source = { ...body };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (source[alias] !== undefined && source[canonical] === undefined) {
      source[canonical] = source[alias];
    }
    delete source[alias];
  }

  const unknown = Object.keys(source).filter((key) => !(key in allowed));
  if (unknown.length > 0) {
    throw createHttpError(400, `Unknown preference field(s): ${unknown.join(', ')}.`);
  }

  const provided = Object.keys(source);
  if (provided.length === 0) {
    throw createHttpError(400, 'At least one preference field is required.');
  }

  for (const key of provided) {
    if (allowed[key] === 'string') {
      // soundUri is a nullable text column. An empty string clears it, which is
      // how a resident returns to the device default.
      if (source[key] !== null && typeof source[key] !== 'string') {
        throw createHttpError(400, `Preference field '${key}' must be a string or null.`);
      }
      if (typeof source[key] === 'string') {
        const value = source[key].trim();
        if (value.length > 2048) {
          throw createHttpError(400, `Preference field '${key}' is too long.`);
        }
        source[key] = value.length === 0 ? null : value;
      }
      continue;
    }

    // A non-boolean is rejected rather than coerced: coercing here is how a
    // malformed client would silently turn notifications off.
    if (typeof source[key] !== 'boolean') {
      throw createHttpError(
        400,
        `Preference field(s) must be true or false: ${key}.`
      );
    }
  }

  return source;
};

/**
 * Reads the stored choices for the signed-in resident.
 *
 * <p>Returns the defaults when nothing is stored yet, so the settings screen
 * has something to render on a first run without needing a write first.
 */
const getPreferences = async (req, res, next) => {
  try {
    const preferences = await notificationPreferenceRepository.findByResidentId(
      residentIdFromRequest(req)
    );
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, preferences });
  } catch (error) {
    next(error);
  }
};

/**
 * Replaces the signed-in resident's stored choices.
 *
 * <p>Unspecified fields keep their stored value, so a client that only tracks
 * announcements does not reset the categories it never knew about.
 */
const updatePreferences = async (req, res, next) => {
  try {
    const residentId = residentIdFromRequest(req);
    const provided = parsePreferenceBody(
      req.body,
      notificationPreferenceRepository.CAMEL_TO_SNAKE,
      RESIDENT_PREFERENCE_FIELDS
    );

    const current = await notificationPreferenceRepository.findByResidentId(residentId);
    const preferences = await notificationPreferenceRepository.upsert(residentId, {
      ...current,
      ...provided,
    });
    res.json({ success: true, preferences });
  } catch (error) {
    next(error);
  }
};

/**
 * Reads the signed-in administrator's stored choices.
 *
 * <p>Served from the administrator table rather than the resident one: an
 * admin/notification-preferences row without an admins FK could be created by a
 * resident caller and then read by nobody.
 */
const getAdminPreferences = async (req, res, next) => {
  try {
    const adminId = req.admin?.admin_id;
    if (!adminId) throw createHttpError(401, 'Administrator identity is missing.');

    const preferences = await adminNotificationPreferenceRepository.findByAdminId(adminId);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, preferences });
  } catch (error) {
    next(error);
  }
};

const updateAdminPreferences = async (req, res, next) => {
  try {
    const adminId = req.admin?.admin_id;
    if (!adminId) throw createHttpError(401, 'Administrator identity is missing.');

    const provided = parsePreferenceBody(
      req.body,
      adminNotificationPreferenceRepository.CAMEL_TO_SNAKE,
      ADMIN_PREFERENCE_FIELDS
    );

    const current = await adminNotificationPreferenceRepository.findByAdminId(adminId);
    const preferences = await adminNotificationPreferenceRepository.upsert(adminId, {
      ...current,
      ...provided,
    });
    res.json({ success: true, preferences });
  } catch (error) {
    next(error);
  }
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
  getPreferences,
  updatePreferences,
  getAdminPreferences,
  updateAdminPreferences,
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

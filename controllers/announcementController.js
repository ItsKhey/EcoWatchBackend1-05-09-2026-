const announcementRepository = require('../repositories/announcementRepository');
const residentRepository = require('../repositories/residentRepository');
const {
  createHttpError,
  requireObject,
  normalizeText,
  normalizeMultilineText,
} = require('../utils/personnelValidation');
const { logInfo } = require('../utils/logger');

/**
 * Audiences the client is allowed to ask for.
 *
 * Only ALL_RESIDENTS can be published right now. The other two are accepted and
 * stored so a narrower broadcast can be switched on without a schema change,
 * but they are rejected until the matching selection UI exists - storing an
 * announcement that silently reaches nobody would be worse than refusing it.
 */
const SUPPORTED_AUDIENCES = Object.freeze(['ALL_RESIDENTS', 'BARANGAY', 'SELECTED_RESIDENTS']);
const PUBLISHABLE_AUDIENCES = Object.freeze(['ALL_RESIDENTS']);
const SUPPORTED_PRIORITIES = Object.freeze(['NORMAL', 'IMPORTANT']);

/**
 * Lifetime windows the administrator may pick, in days.
 *
 * <p>An allowlist rather than a free-form number: the composer offers exactly
 * these choices, so a hand-rolled request cannot ask for a window the UI never
 * presented. 0 means the announcement does not expire on a timer.
 */
const SUPPORTED_EXPIRY_DAYS = Object.freeze([0, 1, 3, 7, 14, 30]);

/** Applied when the request omits the field, so existing callers keep the
 * original 7-day behaviour instead of publishing a permanent one by accident. */
const DEFAULT_EXPIRY_DAYS = 7;

/** Accepts the labels the admin UI sends, e.g. "All Residents". */
const AUDIENCE_ALIASES = Object.freeze({
  allresidents: 'ALL_RESIDENTS',
  all: 'ALL_RESIDENTS',
  specificbarangay: 'BARANGAY',
  barangay: 'BARANGAY',
  selectedresidents: 'SELECTED_RESIDENTS',
  selected: 'SELECTED_RESIDENTS',
});

const PRIORITY_ALIASES = Object.freeze({
  normal: 'NORMAL',
  important: 'IMPORTANT',
});

/**
 * Resolves the administrator's chosen lifetime window.
 *
 * <p>Returns a day count, where 0 means "does not expire". An absent or null
 * field falls back to {@link DEFAULT_EXPIRY_DAYS}. Anything outside the
 * allowlist is refused rather than clamped, so a typo surfaces as an error
 * instead of quietly publishing under a deadline nobody chose.
 */
const normalizeExpiryDays = (rawValue) => {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return DEFAULT_EXPIRY_DAYS;
  }

  // Reject before Number.parseInt, which would accept "7days" as 7.
  const normalized = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
  if (!/^\d+$/.test(String(normalized))) {
    throw createHttpError(400, 'Expiry window must be a whole number of days.');
  }

  const days = Number(normalized);
  if (!SUPPORTED_EXPIRY_DAYS.includes(days)) {
    throw createHttpError(
      400,
      `Expiry window must be one of: ${SUPPORTED_EXPIRY_DAYS.join(', ')} days.`
    );
  }

  return days;
};

const normalizeEnum = (rawValue, aliases, fieldName) => {
  const value = String(rawValue ?? '').trim();
  if (!value) {
    throw createHttpError(400, `${fieldName} is required.`);
  }

  const resolved = aliases[value.toLowerCase().replace(/[\s_-]+/g, '')];
  if (!resolved) {
    throw createHttpError(400, `${fieldName} is not supported.`);
  }

  return resolved;
};

/**
 * Validates an announcement payload.
 *
 * The author of an announcement is always the authenticated administrator, so
 * `createdByAdminId` can never be supplied by the client.
 */
const validateAnnouncementPayload = (body) => {
  requireObject(body);

  // `required: true` on both: an announcement with no title or no body is not
  // publishable. normalizeMultilineText defaults to required: false, which
  // would silently store an empty message.
  const title = normalizeText(body.title, 'Announcement title', {
    required: true,
    maxLength: 150,
  });
  const message = normalizeMultilineText(body.message, 'Announcement message', {
    required: true,
    maxLength: 2000,
  });
  const audience = normalizeEnum(body.audience, AUDIENCE_ALIASES, 'Audience');
  const priority = normalizeEnum(body.priority ?? 'NORMAL', PRIORITY_ALIASES, 'Priority');

  if (!PUBLISHABLE_AUDIENCES.includes(audience)) {
    throw createHttpError(
      400,
      'Only the All Residents audience can be published right now. Narrow audiences are not available yet.'
    );
  }

  // Reserved for the future narrowed broadcasts. Rejecting a stray value here
  // keeps the stored row honest about who it was actually meant for.
  if (body.barangay !== undefined && body.barangay !== null && String(body.barangay).trim()) {
    throw createHttpError(400, 'A barangay cannot be set for an All Residents announcement.');
  }

  if (Array.isArray(body.targetResidentIds) && body.targetResidentIds.length > 0) {
    throw createHttpError(400, 'A resident selection cannot be set for an All Residents announcement.');
  }

  return {
    title,
    message,
    audience,
    priority,
    expiresInDays: normalizeExpiryDays(body.expiresInDays),
  };
};

/**
 * @desc    Publish an announcement
 * @route   POST /api/announcements
 * @access  Private/Admin
 */
const createAnnouncement = async (req, res, next) => {
  try {
    const adminId = req.admin?.admin_id;
    if (!adminId) {
      throw createHttpError(403, 'Authenticated administrator identity is missing.');
    }

    const payload = validateAnnouncementPayload(req.body);
    const announcement = await announcementRepository.createAnnouncement({
      ...payload,
      createdByAdminId: adminId,
    });

    logInfo(
      req.requestId,
      'ANNOUNCEMENT',
      `Announcement ${announcement.announcementId} published by admin ${adminId} (${announcement.priority})`
      + (announcement.expiresAt
        ? `, expires ${announcement.expiresAt}`
        : ', no expiry')
    );

    res.status(201).json({ success: true, announcement });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    List published announcements, newest first
 * @route   GET /api/announcements
 * @access  Private/Admin
 */
const listAnnouncements = async (req, res, next) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const requestedOffset = Number.parseInt(req.query.offset, 10);

    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 50;
    const offset = Number.isInteger(requestedOffset) ? Math.max(requestedOffset, 0) : 0;

    const [announcements, total] = await Promise.all([
      announcementRepository.findAll({ limit, offset }),
      announcementRepository.countAll(),
    ]);

    res.set('Cache-Control', 'no-store');
    res.json({ success: true, announcements, total, limit, offset });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Announcements addressed to the authenticated resident
 * @route   GET /api/announcements/my-announcements
 * @access  Private/Resident
 *
 * The audience is evaluated here rather than in the client so a resident can
 * only ever be shown what was actually meant for them. ALL_RESIDENTS is the
 * only audience that reaches a resident today; the narrowed scopes are already
 * stored so switching them on needs no migration.
 */
const getMyAnnouncements = async (req, res, next) => {
  try {
    const residentId = req.resident.residentId || req.resident.resident_id;
    if (!residentId) {
      throw createHttpError(401, 'Authenticated resident identity is missing.');
    }

    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const requestedOffset = Number.parseInt(req.query.offset, 10);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 50)
      : 20;
    const offset = Number.isInteger(requestedOffset) ? Math.max(requestedOffset, 0) : 0;

    const announcements = await announcementRepository.findForResident(
      residentId,
      { limit, offset }
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      announcements,
      total: announcements.length,
      limit,
      offset,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createAnnouncement,
  listAnnouncements,
  getMyAnnouncements,
  validateAnnouncementPayload,
  normalizeExpiryDays,
  SUPPORTED_AUDIENCES,
  PUBLISHABLE_AUDIENCES,
  SUPPORTED_PRIORITIES,
  SUPPORTED_EXPIRY_DAYS,
  DEFAULT_EXPIRY_DAYS,
};

const { pool } = require('../../config/db');

/**
 * Every toggle the Resident app can hold, with the default applied when the
 * resident has no stored row.
 *
 * <p>All default to true. Absence of a row must behave as "everything on": a
 * resident who never opened the settings screen, or whose row was lost, has to
 * keep receiving emergency notices.
 */
const DEFAULT_PREFERENCES = Object.freeze({
  masterEnabled: true,
  reportStatusUpdates: true,
  reportCompleted: true,
  reportDenied: true,
  cenroAnnouncements: true,
  securityAlerts: true,
  soundEnabled: true,
  vibrationEnabled: true,
  soundUri: null,
});

/** Column names, so the allowed set and the query cannot drift apart. */
const COLUMNS = Object.freeze({
  masterEnabled: 'master_enabled',
  reportStatusUpdates: 'report_status_updates',
  reportCompleted: 'report_completed',
  reportDenied: 'report_denied',
  cenroAnnouncements: 'cenro_announcements',
  securityAlerts: 'security_alerts',
  soundEnabled: 'sound_enabled',
  vibrationEnabled: 'vibration_enabled',
  soundUri: 'sound_uri',
});

/** Toggles stored as booleans; soundUri is a string and handled separately. */
const BOOLEAN_COLUMNS = Object.entries(COLUMNS).filter(([key]) => key !== 'soundUri');

const COLUMN_ENTRIES = Object.entries(COLUMNS);

/** camelCase <-> snake_case, so either shape round-trips. */
const CAMEL_TO_SNAKE = Object.freeze({
  master_enabled: 'masterEnabled',
  report_status_updates: 'reportStatusUpdates',
  report_completed: 'reportCompleted',
  report_denied: 'reportDenied',
  cenro_announcements: 'cenroAnnouncements',
  security_alerts: 'securityAlerts',
  sound_enabled: 'soundEnabled',
  vibration_enabled: 'vibrationEnabled',
  sound_uri: 'soundUri',
});

const mapPreferences = (row) => {
  const preferences = { ...DEFAULT_PREFERENCES, updatedAt: null };
  if (!row) return preferences;

  for (const [key, column] of BOOLEAN_COLUMNS) {
    preferences[key] = row[column] !== false;
  }
  preferences.soundUri = row.sound_uri || null;
  preferences.updatedAt = row.updated_at || null;
  return preferences;
};

/**
 * The stored choices, or the defaults when nothing is stored.
 *
 * <p>Never returns null, so a caller cannot accidentally treat "no row" as
 * "everything off".
 */
async function findByResidentId(residentId, queryable = pool) {
  const result = await queryable.query(
    `SELECT * FROM notification_preferences WHERE resident_id = $1 LIMIT 1`,
    [residentId]
  );
  return mapPreferences(result.rows[0]);
}

/**
 * Replaces the stored choices.
 *
 * <p>An upsert rather than a partial update: the whole set is written together
 * so the stored row can never hold a half-applied mix of old and new values.
 */
async function upsert(residentId, preferences, queryable = pool) {
  const assignments = [
    ...BOOLEAN_COLUMNS.map(
      ([, column], index) => `${column} = $${index + 2}`
    ),
    `sound_uri = $${BOOLEAN_COLUMNS.length + 2}`,
  ].join(', ');

  const result = await queryable.query(
    `
    INSERT INTO notification_preferences (resident_id, ${COLUMN_ENTRIES
      .map(([, column]) => column)
      .join(', ')})
    VALUES ($1, ${BOOLEAN_COLUMNS
      .map((_, index) => `$${index + 2}`)
      .join(', ')}, $${BOOLEAN_COLUMNS.length + 2})
    ON CONFLICT (resident_id) DO UPDATE
      SET ${assignments}, updated_at = NOW()
    RETURNING *
    `,
    [
      residentId,
      ...BOOLEAN_COLUMNS.map(([key]) => preferences[key] !== false),
      preferences.soundUri || null,
    ]
  );

  return mapPreferences(result.rows[0]);
}

/**
 * The preference column that governs a given notification type.
 *
 * <p>Kept next to the data so a new event type cannot be added without deciding
 * which toggle it answers to. Returns null for a type no toggle governs, which
 * the caller treats as "do not suppress".
 */
const CATEGORY_BY_TYPE = Object.freeze({
  PERSONNEL_ASSIGNED: 'reportStatusUpdates',
  PERSONNEL_UNASSIGNED: 'reportStatusUpdates',
  CLEANING_STARTED: 'reportStatusUpdates',
  ADMIN_RESPONSE_UPDATED: 'reportStatusUpdates',
  REPORT_DENIED: 'reportDenied',
  REPORT_DUPLICATE: 'reportDenied',
  REPORT_COMPLETED: 'reportCompleted',
  ANNOUNCEMENT: 'cenroAnnouncements',
});

/**
 * Whether this resident's stored choices allow a push of the given type.
 *
 * <p>Fails open: an unknown type, or a resident with no row, is allowed. The
 * master switch overrides every category, and an absent row is treated as fully
 * enabled so a missing record can never silence an emergency notice.
 */
function allowsPush(preferences, type) {
  if (!preferences) return true;
  if (preferences.masterEnabled === false) return false;

  const category = CATEGORY_BY_TYPE[type];
  if (!category) return true;

  return preferences[category] !== false;
}

/**
 * Everyone an announcement should be recorded for, with push eligibility.
 *
 * <p>Returns ALL active residents, not just the ones holding a device token.
 * Scoping this to token holders meant a resident who had not granted the
 * permission, or had not opened the app since installing, never got the
 * in-app notification row at all. The token is optional here: the row is
 * written either way, and a missing token only means there is nothing to push to
 * yet.
 *
 * <p>`pushEnabled` is COALESCEd to true so a resident with no preferences row
 * still receives pushes.
 *
 * <p>Account eligibility is decided by `residents.status` alone. There is no
 * soft-delete column on that table; a removed account is blocked through the
 * same status list the sign-in path uses.
 */
async function findAnnouncementAudience(queryable = pool) {
  const result = await queryable.query(
    `
    SELECT
      r.resident_id,
      r.fcm_token,
      COALESCE(p.master_enabled AND p.cenro_announcements, true) AS push_enabled
    FROM residents r
    LEFT JOIN notification_preferences p ON p.resident_id = r.resident_id
    WHERE lower(trim(COALESCE(r.role, 'RESIDENT'))) = 'resident'
      AND lower(trim(COALESCE(r.status, 'AVAILABLE'))) NOT IN (
        'disabled', 'inactive', 'blocked', 'suspended', 'deleted'
      )
    ORDER BY r.resident_id
    `
  );

  return result.rows.map((row) => {
    const token = typeof row.fcm_token === 'string' && row.fcm_token.trim().length > 0
      ? row.fcm_token.trim()
      : null;
    return {
      residentId: row.resident_id,
      token,
      pushEnabled: row.push_enabled !== false && token !== null,
    };
  });
}

module.exports = {
  DEFAULT_PREFERENCES,
  CAMEL_TO_SNAKE,
  findByResidentId,
  upsert,
  findAnnouncementAudience,
  allowsPush,
};

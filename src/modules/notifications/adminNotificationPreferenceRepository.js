const { pool } = require('../../config/db');

/**
 * The Admin app's notification toggles, with their server-side columns.
 *
 * <p>Mirrors {@link notificationPreferenceRepository} for the administrator side.
 * Every category the Admin app exposes is listed, including ones the backend does
 * not yet produce an event for, so the settings screen can round-trip in full.
 * An unsyncable toggle is the same defect as an unenforced one.
 */
const COLUMNS = Object.freeze({
  masterEnabled: 'master_enabled',
  reportStatusUpdates: 'report_status_updates',
  reportCompleted: 'report_completed',
  reportDenied: 'report_denied',
  cenroAnnouncements: 'cenro_announcements',
  securityAlerts: 'security_alerts',
  highPriorityReports: 'high_priority_reports',
  personnelAccepted: 'personnel_accepted',
  personnelCleaning: 'personnel_cleaning',
  photoUpdates: 'photo_updates',
  awaitingApproval: 'awaiting_approval',
  archivedReports: 'archived_reports',
  maintenanceAlerts: 'maintenance_alerts',
  soundEnabled: 'sound_enabled',
  vibrationEnabled: 'vibration_enabled',
  soundUri: 'sound_uri',
});

/** snake_case aliases, so a client using either casing round-trips. */
const CAMEL_TO_SNAKE = Object.freeze({
  master_enabled: 'masterEnabled',
  report_status_updates: 'reportStatusUpdates',
  report_completed: 'reportCompleted',
  report_denied: 'reportDenied',
  cenro_announcements: 'cenroAnnouncements',
  security_alerts: 'securityAlerts',
  high_priority_reports: 'highPriorityReports',
  personnel_accepted: 'personnelAccepted',
  personnel_cleaning: 'personnelCleaning',
  photo_updates: 'photoUpdates',
  awaiting_approval: 'awaitingApproval',
  archived_reports: 'archivedReports',
  maintenance_alerts: 'maintenanceAlerts',
  sound_enabled: 'soundEnabled',
  vibration_enabled: 'vibrationEnabled',
  sound_uri: 'soundUri',
});

const BOOLEAN_KEYS = Object.keys(COLUMNS).filter((key) => key !== 'soundUri');

const DEFAULT_PREFERENCES = Object.freeze(
  Object.fromEntries(BOOLEAN_KEYS.map((key) => [key, true]).concat([['soundUri', null]]))
);

const mapPreferences = (row) => {
  const preferences = { ...DEFAULT_PREFERENCES, updatedAt: null };
  if (!row) return preferences;

  for (const key of BOOLEAN_KEYS) {
    preferences[key] = row[COLUMNS[key]] !== false;
  }
  preferences.soundUri = row.sound_uri || null;
  preferences.updatedAt = row.updated_at || null;
  return preferences;
};

async function findByAdminId(adminId, queryable = pool) {
  const result = await queryable.query(
    `SELECT * FROM admin_notification_preferences WHERE admin_id = $1 LIMIT 1`,
    [adminId]
  );
  return mapPreferences(result.rows[0]);
}

async function upsert(adminId, preferences, queryable = pool) {
  const columns = Object.values(COLUMNS);
  const assignments = [
    ...BOOLEAN_KEYS.map((key, index) => `${COLUMNS[key]} = $${index + 2}`),
    `sound_uri = $${BOOLEAN_KEYS.length + 2}`,
  ].join(', ');

  const result = await queryable.query(
    `
    INSERT INTO admin_notification_preferences (admin_id, ${columns.join(', ')})
    VALUES ($1, ${BOOLEAN_KEYS
      .map((_, index) => `$${index + 2}`)
      .join(', ')}, $${BOOLEAN_KEYS.length + 2})
    ON CONFLICT (admin_id) DO UPDATE
      SET ${assignments}, updated_at = NOW()
    RETURNING *
    `,
    [
      adminId,
      ...BOOLEAN_KEYS.map((key) => preferences[key] !== false),
      preferences.soundUri || null,
    ]
  );

  return mapPreferences(result.rows[0]);
}

/**
 * The preference column that governs an administrator-facing notification type.
 *
 * <p>Only types the backend actually produces are mapped. An unmapped type
 * returns null, which the caller treats as "do not suppress" so a new event is
 * never silently swallowed by an unrelated toggle.
 */
const CATEGORY_BY_TYPE = Object.freeze({
  NEW_REPORT: 'highPriorityReports',
  PERSONNEL_ACCEPTED: 'personnelAccepted',
  PERSONNEL_COMPLETED: 'personnelCleaning',
  REPORT_DENIED: 'reportDenied',
  REPORT_COMPLETED: 'reportCompleted',
});

function allowsPush(preferences, type) {
  if (!preferences) return true;
  if (preferences.masterEnabled === false) return false;

  const category = CATEGORY_BY_TYPE[type];
  if (!category) return true;

  return preferences[category] !== false;
}

/**
 * Every administrator device that can receive a broadcast, paired with whether
 * its owner still wants it.
 *
 * <p>One statement so the broadcast does not cost a preferences lookup per
 * administrator, and so a missing row fails open through the COALESCE.
 */
async function findBroadcastTargets(queryable = pool) {
  const result = await queryable.query(
    `
    SELECT
      a.admin_id,
      a.fcm_token,
      COALESCE(
        p.master_enabled AND p.high_priority_reports,
        true
      ) AS push_enabled
    FROM admins a
    LEFT JOIN admin_notification_preferences p ON p.admin_id = a.admin_id
    WHERE a.fcm_token IS NOT NULL
      AND btrim(a.fcm_token) <> ''
      AND lower(trim(COALESCE(a.role, 'ADMIN'))) = 'admin'
    ORDER BY a.admin_id
    `
  );

  return result.rows
    .map((row) => ({
      adminId: row.admin_id,
      token: row.fcm_token,
      pushEnabled: row.push_enabled !== false,
    }))
    .filter((row) => typeof row.token === 'string' && row.token.trim().length > 0);
}

module.exports = {
  DEFAULT_PREFERENCES,
  CAMEL_TO_SNAKE,
  findByAdminId,
  upsert,
  findBroadcastTargets,
  allowsPush,
};

/**
 * Verifies the announcements schema and the notification preferences that
 * govern delivery.
 *
 * Run with: npm run verify:announcements
 *
 * Complements verify-phase-2c.js, which covers the original notifications
 * columns. This asserts the tables added since then, so a half-applied
 * migration is caught here rather than by a resident not receiving a notice.
 */

require('dotenv').config();

const { resolveConnectionString } = require('../src/config/database');
const { pool } = require('../src/config/db');

const failures = [];
const notes = [];

const check = (label, condition, detail = '') => {
  if (condition) {
    notes.push(`  ok    ${label}`);
  } else {
    failures.push(`  FAIL  ${label}${detail ? ` (${detail})` : ''}`);
  }
};

const tableExists = async (table) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total FROM information_schema.tables
      WHERE table_name = $1`,
    [table]
  );
  return result.rows[0].total > 0;
};

const columnNames = async (table) => {
  const result = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  return new Set(result.rows.map((row) => row.column_name));
};

const constraintDefinition = async (name) => {
  const result = await pool.query(
    'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1',
    [name]
  );
  return result.rows[0]?.def || null;
};

async function main() {
  if (!resolveConnectionString()) {
    console.error('[VERIFY] DATABASE_URL (local) or SUPABASE_DATABASE_URL (hosted) is required.');
    process.exitCode = 1;
    return;
  }

  // --- announcements -------------------------------------------------------
  if (await tableExists('announcements')) {
    const columns = await columnNames('announcements');
    for (const required of [
      'id', 'title', 'message', 'audience', 'priority',
      'created_by_admin_id', 'created_at', 'expires_at',
    ]) {
      check(`announcements.${required} exists`, columns.has(required));
    }

    const typeCheck = await constraintDefinition('notifications_type_ck');
    check(
      'notifications_type_ck permits ANNOUNCEMENT',
      typeCheck ? /ANNOUNCEMENT/.test(typeCheck) : false,
      'run: npm run migrate:announcement-notifications'
    );
  } else {
    check('announcements table exists', false, 'run: npm run migrate:announcements');
  }

  // --- resident preferences ------------------------------------------------
  if (await tableExists('notification_preferences')) {
    const columns = await columnNames('notification_preferences');
    for (const required of [
      'resident_id', 'master_enabled', 'cenro_announcements',
      'report_status_updates', 'report_completed', 'report_denied',
      'sound_enabled', 'vibration_enabled', 'sound_uri', 'updated_at',
    ]) {
      check(`notification_preferences.${required} exists`, columns.has(required));
    }
  } else {
    check(
      'notification_preferences table exists',
      false,
      'run: npm run migrate:notification-preferences'
    );
  }

  // --- admin preferences ---------------------------------------------------
  if (await tableExists('admin_notification_preferences')) {
    const columns = await columnNames('admin_notification_preferences');
    for (const required of [
      'admin_id', 'master_enabled', 'high_priority_reports',
      'personnel_accepted', 'personnel_cleaning', 'sound_uri', 'updated_at',
    ]) {
      check(`admin_notification_preferences.${required} exists`, columns.has(required));
    }
  } else {
    check(
      'admin_notification_preferences table exists',
      false,
      'run: npm run migrate:notification-preferences-followup'
    );
  }

  // --- fail-open guarantee -------------------------------------------------
  // The single most consequential property here: a resident with no
  // preferences row must still be pushable, or a lost row silences them.
  if (await tableExists('notification_preferences')) {
    const defaults = await pool.query(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'notification_preferences'
          AND column_name IN ('master_enabled', 'cenro_announcements')`
    );
    const byName = new Map(defaults.rows.map((row) => [row.column_name, row.column_default]));
    for (const column of ['master_enabled', 'cenro_announcements']) {
      check(
        `notification_preferences.${column} defaults to true`,
        /true/i.test(byName.get(column) || ''),
        `found: ${byName.get(column)}`
      );
    }
  }

  console.log('[VERIFY] announcements');
  notes.forEach((line) => console.log(line));

  if (failures.length > 0) {
    console.error('[VERIFY] announcements: FAILED');
    failures.forEach((line) => console.error(line));
    process.exitCode = 1;
    return;
  }

  console.log('[VERIFY] announcements: all checks passed.');
}

main()
  .catch((error) => {
    console.error('[VERIFY] announcements: FAILED');
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

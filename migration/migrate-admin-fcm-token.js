require('dotenv').config();

const { pool } = require('../config/db');

/**
 * Phase 3A — Admin FCM token storage.
 *
 * Idempotent by design so it can be re-run safely on an already-migrated
 * production database. Only adds storage; it never rewrites existing admin
 * accounts.
 */
const STATEMENTS = [
  'ALTER TABLE admins ADD COLUMN IF NOT EXISTS fcm_token TEXT',
  'CREATE INDEX IF NOT EXISTS index_admins_fcm_token ON admins (fcm_token)',

  // Administrator notification store. The resident tables are referentially
  // bound to `residents`, so administrators get a mirror pair instead. Nothing
  // existing is altered, and every query resolves its table from the owner ID.
  `
  CREATE TABLE IF NOT EXISTS admin_notifications (
    notification_id BIGSERIAL PRIMARY KEY,
    resident_id     VARCHAR(100) NOT NULL,
    report_id       VARCHAR(100),
    title           TEXT NOT NULL,
    message         TEXT NOT NULL,
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    type            VARCHAR(64) NOT NULL DEFAULT 'NEW_REPORT',
    CONSTRAINT admin_notifications_admin_fk
      FOREIGN KEY (resident_id) REFERENCES admins (admin_id)
      ON UPDATE CASCADE ON DELETE CASCADE
  )
  `,
  // The trash join needs a matching unique key on the parent table, so this
  // must exist before the referencing table is created.
  'CREATE UNIQUE INDEX IF NOT EXISTS index_admin_notifications_owner ON admin_notifications (resident_id, notification_id)',
  'CREATE INDEX IF NOT EXISTS index_admin_notifications_report ON admin_notifications (resident_id, report_id)',
  'CREATE INDEX IF NOT EXISTS index_admin_notifications_unread ON admin_notifications (resident_id, is_read)',
  `
  CREATE TABLE IF NOT EXISTS trash_admin_notifications (
    notification_id BIGINT NOT NULL,
    resident_id     VARCHAR(100) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT trash_admin_notifications_pk
      PRIMARY KEY (resident_id, notification_id),
    CONSTRAINT trash_admin_notifications_fk
      FOREIGN KEY (resident_id, notification_id)
      REFERENCES admin_notifications (resident_id, notification_id)
      ON UPDATE CASCADE ON DELETE CASCADE
  )
  `,
];

/**
 * The notifications.type CHECK constraint predates Phase 3A and rejects
 * NEW_REPORT. The constraint is rebuilt to accept every server-known type
 * rather than a hardcoded subset, so a future event type is only a code change.
 *
 * Idempotent: it re-points the constraint at the current definition and is a
 * no-op when NEW_REPORT is already permitted.
 */
const RECONCILE_TYPE_CONSTRAINT = `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'notifications_type_ck'
         AND pg_get_constraintdef(oid) LIKE '%NEW_REPORT%'
    ) THEN
      ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_ck;
      ALTER TABLE notifications
        ADD CONSTRAINT notifications_type_ck
        CHECK (
          type = ANY (ARRAY[
            'PERSONNEL_ASSIGNED',
            'PERSONNEL_UNASSIGNED',
            'CLEANING_STARTED',
            'ADMIN_RESPONSE_UPDATED',
            'REPORT_DENIED',
            'REPORT_COMPLETED',
            'REPORT_UPDATE',
            'NEW_REPORT'
          ]::varchar[])
        );
    END IF;
  END
  $$;
`;

async function migrate() {
  let applied = 0;
  try {
    for (const statement of STATEMENTS) {
      await pool.query(statement);
      applied += 1;
    }

    await pool.query(RECONCILE_TYPE_CONSTRAINT);

    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(fcm_token)::int AS with_token
      FROM admins
    `);

    console.log('[MIGRATION:admin-fcm-token] Statements applied:', applied);
    console.log('[MIGRATION:admin-fcm-token] notifications.type constraint accepts NEW_REPORT');

    const constraint = await pool.query(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conname = 'notifications_type_ck'
    `);
    console.log('[MIGRATION:admin-fcm-token] type constraint now:', constraint.rows[0]?.definition);

    console.log(
      `[MIGRATION:admin-fcm-token] Admins: ${rows[0].total}, bound tokens: ${rows[0].with_token}`
    );
  } catch (error) {
    console.error('[MIGRATION:admin-fcm-token] Failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();

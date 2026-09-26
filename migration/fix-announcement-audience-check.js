require('dotenv').config();

const { pool } = require('../config/db');

/**
 * One-off cleanup for the first cut of migration 009.
 *
 * The initial announcement table carried a redundant `audience_check` column
 * instead of constraining `audience` itself. The corrected migration is
 * idempotent for fresh databases, but an already-migrated database keeps the
 * old shape because CREATE TABLE IF NOT EXISTS is a no-op. This removes the
 * duplicate column and puts the CHECK on the real column.
 */
const fixAudienceCheck = async () => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'announcements'
          AND column_name = 'audience_check'`
    );

    if (existing.rowCount === 0) {
      await client.query('COMMIT');
      console.log('[MIGRATION] announcements.audience_check is already absent; nothing to do.');
      return;
    }

    // Drop the column before the constraint so the leftover CHECK does not
    // block its own removal.
    await client.query('ALTER TABLE public.announcements DROP COLUMN audience_check');

    await client.query('ALTER TABLE public.announcements DROP CONSTRAINT IF EXISTS announcements_audience_check');
    await client.query(`
      ALTER TABLE public.announcements
        ADD CONSTRAINT announcements_audience_check
        CHECK (audience IN ('ALL_RESIDENTS', 'BARANGAY', 'SELECTED_RESIDENTS'))
    `);

    await client.query('COMMIT');
    console.log('[MIGRATION] announcements.audience_check removed; audience is now constrained.');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(`[MIGRATION] Rollback failed: ${rollbackError.message}`);
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

fixAudienceCheck()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error('[MIGRATION] Announcement audience cleanup failed:');
    console.error(error.message);
    process.exitCode = 1;
  });

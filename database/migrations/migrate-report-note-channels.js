/**
 * Migration runner for the audience-split report note channels.
 * Executes migration/sql/023-report-note-channels.sql against the PostgreSQL
 * database.
 *
 * Usage: node migration/migrate-report-note-channels.js
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const { pool } = require('../../src/config/db');

async function migrate() {
  const client = await pool.connect();

  try {
    const migrationPath = path.join(
      __dirname,
      'sql',
      '023-report-note-channels.sql'
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');

    // Same advisory-lock convention as the other migration runners, so two
    // concurrent starts cannot both apply the column changes.
    const lockId = 15023;
    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock($1) AS acquired',
      [lockId]
    );

    if (!lockResult.rows[0].acquired) {
      console.log('[MIGRATION] Another instance is running this migration. Skipping.');
      return;
    }

    console.log('[MIGRATION] Running 023-report-note-channels.sql...');
    await client.query(sql);
    console.log('[MIGRATION] Successfully applied 023-report-note-channels.sql');

    const columns = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'reports'
            AND column_name = 'personnel_note') AS reports_personnel_note,
        (SELECT COUNT(*)::int FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'archived_reports'
            AND column_name = 'personnel_note') AS archived_reports_personnel_note
    `);
    console.log('[MIGRATION] Columns present (expect 1 / 1):', columns.rows[0]);
  } catch (error) {
    console.error('[MIGRATION] Failed:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(process.exitCode || 0));
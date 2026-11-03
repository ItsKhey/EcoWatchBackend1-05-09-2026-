/**
 * Migration runner for the personnel assignment workflow.
 * Executes migration/sql/022-personnel-assignments.sql against the PostgreSQL
 * database.
 *
 * Usage: node migration/migrate-personnel-assignments.js
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
      '022-personnel-assignments.sql'
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');

    // Same advisory-lock convention as the other migration runners, so two
    // concurrent starts cannot both apply the backfill.
    const lockId = 15022;
    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock($1) AS acquired',
      [lockId]
    );

    if (!lockResult.rows[0].acquired) {
      console.log('[MIGRATION] Another instance is running this migration. Skipping.');
      return;
    }

    console.log('[MIGRATION] Running 022-personnel-assignments.sql...');
    await client.query(sql);
    console.log('[MIGRATION] Successfully applied 022-personnel-assignments.sql');

    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM personnel_assignments) AS assignments,
        (SELECT COUNT(*)::int FROM personnel_evidence) AS evidence,
        (SELECT COUNT(*)::int FROM personnel_notifications) AS notifications
    `);
    console.log('[MIGRATION] Rows:', counts.rows[0]);
  } catch (error) {
    console.error('[MIGRATION] Failed:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(process.exitCode || 0));

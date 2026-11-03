/**
 * Migration runner for report clusters and multi-photo support.
 * Executes migration/sql/014-report-clusters.sql against the Supabase database.
 *
 * Usage: node migration/migrate-report-clusters.js
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const { pool } = require('../../src/config/db');

async function migrate() {
  const client = await pool.connect();

  try {
    const migrationPath = path.join(__dirname, 'sql', '014-report-clusters.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    // Use advisory lock for idempotency
    const lockId = 14014; // unique ID for this migration
    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock($1) AS acquired',
      [lockId]
    );

    if (!lockResult.rows[0].acquired) {
      console.log('[MIGRATION] Another instance is running this migration. Skipping.');
      return;
    }

    console.log('[MIGRATION] Running 014-report-clusters.sql...');
    await client.query(sql);
    console.log('[MIGRATION] Successfully applied 014-report-clusters.sql');
  } catch (error) {
    console.error('[MIGRATION] Failed:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(process.exitCode || 0));

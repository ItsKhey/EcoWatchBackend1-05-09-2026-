/**
 * Migration runner for per-report duplicate review decisions.
 * Executes migration/sql/021-report-duplicate-reviews.sql against the database.
 *
 * Usage: node migration/migrate-report-duplicate-reviews.js
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const { pool } = require('../../src/config/db');

async function migrate() {
  const client = await pool.connect();

  try {
    const migrationPath = path.join(__dirname, 'sql', '021-report-duplicate-reviews.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    const lockId = 21021;
    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock($1) AS acquired',
      [lockId]
    );

    if (!lockResult.rows[0].acquired) {
      console.log('[MIGRATION] Another instance is running this migration. Skipping.');
      return;
    }

    console.log('[MIGRATION] Running 021-report-duplicate-reviews.sql...');
    await client.query(sql);
    console.log('[MIGRATION] Successfully applied 021-report-duplicate-reviews.sql');
  } catch (error) {
    console.error('[MIGRATION] Failed:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(process.exitCode || 0));
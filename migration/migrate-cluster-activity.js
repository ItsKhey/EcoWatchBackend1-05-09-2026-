/**
 * Migration runner for cluster activity tracking.
 * Executes migration/sql/015-cluster-activity-tracking.sql against the Supabase database.
 *
 * Usage: node migration/migrate-cluster-activity.js
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const { pool } = require('../config/db');

async function migrate() {
  const client = await pool.connect();

  try {
    const migrationPath = path.join(__dirname, 'sql', '015-cluster-activity-tracking.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    // Use advisory lock for idempotency
    const lockId = 15015;
    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock($1) AS acquired',
      [lockId]
    );

    if (!lockResult.rows[0].acquired) {
      console.log('[MIGRATION] Another instance is running this migration. Skipping.');
      return;
    }

    console.log('[MIGRATION] Running 015-cluster-activity-tracking.sql...');
    await client.query(sql);
    console.log('[MIGRATION] Successfully applied 015-cluster-activity-tracking.sql');
  } catch (error) {
    console.error('[MIGRATION] Failed:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(process.exitCode || 0));

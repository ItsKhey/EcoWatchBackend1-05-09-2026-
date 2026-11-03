/**
 * Migration runner for the vehicle fleet.
 * Executes migration/sql/025-vehicles.sql against the PostgreSQL database.
 *
 * Usage: node migration/migrate-vehicles.js
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const { pool } = require('../../src/config/db');

async function migrate() {
  const client = await pool.connect();

  try {
    const migrationPath = path.join(__dirname, 'sql', '025-vehicles.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    // Same advisory-lock convention as the other migration runners, so two
    // concurrent starts cannot both try to create the table and its sequence.
    const lockId = 15025;
    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock($1) AS acquired',
      [lockId]
    );

    if (!lockResult.rows[0].acquired) {
      console.log('[MIGRATION] Another instance is running this migration. Skipping.');
      return;
    }

    console.log('[MIGRATION] Running 025-vehicles.sql...');
    await client.query(sql);
    console.log('[MIGRATION] Successfully applied 025-vehicles.sql');

    const tables = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'vehicles') AS vehicles_table,
        -- A sequence is not an information_schema.tables row; pg_class holds both.
        (SELECT COUNT(*)::int FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'vehicle_id_seq'
            AND c.relkind = 'S') AS vehicles_sequence
    `);
    console.log('[MIGRATION] Objects present (expect 1 / 1):', tables.rows[0]);

    if (tables.rows[0].vehicles_table !== 1 || tables.rows[0].vehicles_sequence !== 1) {
      throw new Error('vehicles table or id sequence is missing after migration');
    }
  } catch (error) {
    console.error('[MIGRATION] Failed:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(process.exitCode || 0));

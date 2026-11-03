require('dotenv').config();

const { requireConnectionString } = require('../../src/config/database');

const fs = require('fs/promises');
const path = require('path');
const { pool } = require('../../src/config/db');

const MIGRATION_NAME = '028-waste-scale.sql';

/**
 * Applies the waste scale migration.
 *
 * Waste scale, cleaning teams and collection-vehicle dispatch all land
 * together because none of the three is usable alone: a scale is meaningless
 * without a crew to dispatch and a truck to send, and a crew with nowhere to
 * be dispatched is just a list of names.
 */
async function migrateWasteScale() {
  requireConnectionString('this migration');

  const migrationPath = path.join(__dirname, 'sql', MIGRATION_NAME);
  const sql = await fs.readFile(migrationPath, 'utf8');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log(`[MIGRATION] Applied ${MIGRATION_NAME} successfully.`);
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
}

migrateWasteScale()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error('[MIGRATION] Waste scale migration failed:');
    console.error(error.message);
    process.exitCode = 1;
  });

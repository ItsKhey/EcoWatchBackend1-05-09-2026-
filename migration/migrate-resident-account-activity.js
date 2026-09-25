require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const { pool } = require('../config/db');

const MIGRATION_NAME = '005-resident-account-activity.sql';

async function migrateResidentAccountActivity() {
  if (!process.env.SUPABASE_DATABASE_URL) {
    throw new Error('SUPABASE_DATABASE_URL is required to run this migration.');
  }

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

migrateResidentAccountActivity()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error('[MIGRATION] Resident account activity migration failed:');
    console.error(error.message);
    process.exitCode = 1;
  });

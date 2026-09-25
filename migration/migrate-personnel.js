require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const { pool } = require('../config/db');

const MIGRATION_NAME = '002-personnel-accounts.sql';

async function migratePersonnelAccounts() {
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

    console.log(
      `[MIGRATION] Applied ${MIGRATION_NAME} to Supabase PostgreSQL successfully.`
    );
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[MIGRATION] Rollback failed:', rollbackError.message);
    }

    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migratePersonnelAccounts()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error('[MIGRATION] Personnel migration failed:');
    console.error(error.message);
    process.exitCode = 1;
  });

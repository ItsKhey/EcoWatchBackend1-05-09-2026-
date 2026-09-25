require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const { pool } = require('../config/db');

const MIGRATION_NAME = '003-normalize-admin-identifiers.sql';

async function migrateAdminIdentifiers() {
  if (!process.env.SUPABASE_DATABASE_URL) {
    throw new Error('SUPABASE_DATABASE_URL is required to run this migration.');
  }

  const migrationPath = path.join(__dirname, '..', 'migration', 'sql', MIGRATION_NAME);
  const sql = await fs.readFile(migrationPath, 'utf8');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log(`[MIGRATION] Applied ${MIGRATION_NAME} successfully.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrateAdminIdentifiers()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(`[MIGRATION] ${MIGRATION_NAME} failed:`);
    console.error(error.message);
    process.exitCode = 1;
  });
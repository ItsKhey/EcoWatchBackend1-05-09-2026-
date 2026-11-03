require('dotenv').config();

const { requireConnectionString } = require('../src/config/database');

const fs = require('fs/promises');
const path = require('path');
const { pool } = require('../src/config/db');

const MIGRATION_NAME = '003-normalize-admin-identifiers.sql';

async function migrateAdminIdentifiers() {
  requireConnectionString('this migration');

  const migrationPath = path.join(__dirname, '..', 'database', 'migrations', 'sql', MIGRATION_NAME);
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
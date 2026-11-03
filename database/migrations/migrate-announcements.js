require('dotenv').config();

const { requireConnectionString } = require('../../src/config/database');

const fs = require('fs/promises');
const path = require('path');
const { pool } = require('../../src/config/db');

const MIGRATION_NAME = '009-announcements.sql';

async function migrateAnnouncements() {
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

migrateAnnouncements()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error('[MIGRATION] Announcement migration failed:');
    console.error(error.message);
    process.exitCode = 1;
  });

require('dotenv').config();

const { pool } = require('./config/db');

async function checkTables() {
  try {
    const result = await pool.query(`
      SELECT
        table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND (
          table_name ILIKE '%histor%'
          OR table_name ILIKE '%archive%'
          OR table_name ILIKE '%report%'
        )
      ORDER BY table_name
    `);

    console.table(result.rows);
  } catch (error) {
    console.error('Failed to inspect tables:');
    console.error(error);
  } finally {
    await pool.end();
  }
}

checkTables();

require('dotenv').config();

const { pool } = require('../../src/config/db');

async function checkSchema() {
  try {
    const result = await pool.query(`
      SELECT
        column_name,
        data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'history'
      ORDER BY ordinal_position
    `);

    console.table(result.rows);
  } catch (error) {
    console.error('Failed to inspect history schema:');
    console.error(error);
  } finally {
    await pool.end();
  }
}

checkSchema();

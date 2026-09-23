const { pool } = require('./config/db');

async function checkSchema() {
  try {
    const result = await pool.query(`
      SELECT
        table_name,
        column_name,
        data_type,
        is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);

    console.table(result.rows);
  } catch (error) {
    console.error('❌ Failed to read PostgreSQL schema:');
    console.error(error.message);
  } finally {
    await pool.end();
  }
}

checkSchema();

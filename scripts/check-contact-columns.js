require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  try {
    const result = await pool.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('residents', 'pending_registrations', 'personnel_accounts')
          AND column_name IN ('phone_number', 'messenger_link')
        ORDER BY table_name, column_name`
    );

    console.log('columns found:', JSON.stringify(result.rows));

    const missing = [];
    for (const [table, column] of [
      ['residents', 'messenger_link'],
      ['residents', 'phone_number'],
      ['pending_registrations', 'phone_number'],
      ['personnel_accounts', 'messenger_link'],
      ['personnel_accounts', 'phone_number'],
    ]) {
      const found = result.rows.some(
        (row) => row.table_name === table && row.column_name === column
      );
      if (!found) missing.push(`${table}.${column}`);
    }

    console.log(missing.length ? `MISSING: ${missing.join(', ')}` : 'nothing missing');
  } catch (error) {
    console.log('QUERY FAILED:', error.message);
  } finally {
    await pool.end();
  }
})();

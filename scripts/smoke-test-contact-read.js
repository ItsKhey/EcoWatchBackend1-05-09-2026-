require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/*
 * Exercises the exact query the admin and resident apps depend on, so a missing
 * column surfaces here instead of as a toast on someone's phone.
 */
(async () => {
  try {
    const result = await pool.query(
      `SELECT r.resident_id, r.phone_number, r.messenger_link
         FROM residents r
        ORDER BY r.created_at DESC NULLS LAST
        LIMIT 5`
    );
    console.log('resident read OK:', JSON.stringify(result.rows, null, 1));

    const counted = await pool.query('SELECT COUNT(*)::int AS total FROM residents');
    console.log('residents in table:', counted.rows[0].total);
  } catch (error) {
    console.log('QUERY FAILED:', error.message);
  } finally {
    await pool.end();
  }
})();

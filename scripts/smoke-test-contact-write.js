require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/*
 * Replays the write statements from residentRepository and personnelRepository
 * inside a transaction that is always rolled back.
 *
 * The read smoke test cannot catch a wrong column in an UPDATE or INSERT, and a
 * typo there only shows up as a failed save on a user's phone.
 */
(async () => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const resident = await client.query(
      `SELECT resident_id FROM residents ORDER BY created_at DESC NULLS LAST LIMIT 1`
    );
    const personnel = await client.query(
      `SELECT personnel_id FROM personnel_accounts LIMIT 1`
    );

    if (resident.rows[0]) {
      await client.query(
        `UPDATE residents
            SET phone_number = $1, messenger_link = $2, updated_at = NOW()
          WHERE resident_id = $3
        RETURNING resident_id, phone_number, messenger_link`,
        ['09171234567', 'https://m.me/smoketest', resident.rows[0].resident_id]
      );
      console.log('resident UPDATE statement OK');
    }

    if (personnel.rows[0]) {
      await client.query(
        `UPDATE personnel_accounts
            SET phone_number = $1, messenger_link = $2, updated_at = NOW()
          WHERE personnel_id = $3
        RETURNING personnel_id, phone_number, messenger_link`,
        ['09171234567', 'https://m.me/smoketest', personnel.rows[0].personnel_id]
      );
      console.log('personnel UPDATE statement OK');
    }

    await client.query('ROLLBACK');
    console.log('rolled back; no data was changed');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.log('WRITE FAILED:', error.message);
  } finally {
    client.release();
    await pool.end();
  }
})();

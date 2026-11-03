require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/*
 * Replays the createResident and createPendingRegistration inserts inside a
 * transaction that is always rolled back.
 *
 * The resident insert carries 18 positional parameters across two tables; an
 * off-by-one there would only surface as a failed signup, which is why it is
 * asserted here rather than discovered in the app.
 */
(async () => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const resident = await client.query(
      `INSERT INTO residents (
         resident_id, first_name, last_name, username, email, password_hash,
         address, profile_image, is_verified, role, status, phone_number,
         messenger_link, created_by_id, firebase_uid, email_verified, verified_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16, COALESCE($17, NOW())
       )
       RETURNING resident_id, phone_number, messenger_link`,
      [
        'RES-SMOKETEST', 'Smoke', 'Test', 'smoke.test', 'smoke.test@example.com',
        '$2$10$smoketest', '', '', true, 'RESIDENT', 'AVAILABLE',
        '09171234567', null, 'SYSTEM', null, true, null,
      ]
    );
    console.log('createResident INSERT OK:', JSON.stringify(resident.rows[0]));

    const pending = await client.query(
      `INSERT INTO pending_registrations (
         registration_id, username, email, first_name, last_name, password_hash,
         otp_hash, expires_at, attempts, firebase_uid, verification_flow,
         verification_sent_at, phone_number
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING registration_id, phone_number`,
      [
        'REG-smoketest', 'smoke.test', 'smoke.test@example.com', 'Smoke', 'Test',
        '$2$10$smoketest', null, new Date(Date.now() + 900000), 0, null,
        'EMAIL_LINK', null, '09171234567',
      ]
    );
    console.log('createPendingRegistration INSERT OK:', JSON.stringify(pending.rows[0]));

    await client.query('ROLLBACK');
    console.log('rolled back; no data was changed');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.log('INSERT FAILED:', error.message);
  } finally {
    client.release();
    await pool.end();
  }
})();

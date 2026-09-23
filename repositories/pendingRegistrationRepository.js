const { pool } = require('../config/db');

async function createPendingRegistration({
  registrationId,
  username,
  email,
  firstName,
  lastName,
  passwordHash,
  otpHash,
  expiresAt,
  attempts = 0,
}) {
  const result = await pool.query(
    `
    INSERT INTO pending_registrations (
      registration_id,
      username,
      email,
      first_name,
      last_name,
      password_hash,
      otp_hash,
      expires_at,
      attempts
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
    `,
    [
      registrationId,
      username,
      email,
      firstName,
      lastName,
      passwordHash,
      otpHash,
      expiresAt,
      attempts,
    ]
  );

  return result.rows[0] || null;
}

async function findByRegistrationId(registrationId) {
  const result = await pool.query(
    `
    SELECT *
    FROM pending_registrations
    WHERE registration_id = $1
    LIMIT 1
    `,
    [registrationId]
  );

  return result.rows[0] || null;
}

async function incrementAttempts(registrationId) {
  const result = await pool.query(
    `
    UPDATE pending_registrations
    SET attempts = attempts + 1
    WHERE registration_id = $1
    RETURNING *
    `,
    [registrationId]
  );

  return result.rows[0] || null;
}

async function deleteByRegistrationId(registrationId) {
  const result = await pool.query(
    `
    DELETE FROM pending_registrations
    WHERE registration_id = $1
    RETURNING *
    `,
    [registrationId]
  );

  return result.rows[0] || null;
}

async function deleteExpired() {
  const result = await pool.query(
    `
    DELETE FROM pending_registrations
    WHERE expires_at <= NOW()
    RETURNING *
    `
  );

  return result.rows;
}

module.exports = {
  createPendingRegistration,
  findByRegistrationId,
  incrementAttempts,
  deleteByRegistrationId,
  deleteExpired,
};

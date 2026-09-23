const { pool } = require('../config/db');

async function createResetOTP({
  userId = null,
  otpHash,
  expiresAt,
  email,
  attempts = 0,
}) {
  const result = await pool.query(
    `
    INSERT INTO password_reset_otps (
      user_id,
      otp_hash,
      expires_at,
      email,
      attempts
    )
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
    `,
    [userId, otpHash, expiresAt, email, attempts]
  );

  return result.rows[0] || null;
}

async function findByEmail(email) {
  const result = await pool.query(
    `
    SELECT *
    FROM password_reset_otps
    WHERE email = $1
    LIMIT 1
    `,
    [email]
  );

  return result.rows[0] || null;
}

async function incrementAttempts(email) {
  const result = await pool.query(
    `
    UPDATE password_reset_otps
    SET attempts = attempts + 1
    WHERE email = $1
    RETURNING *
    `,
    [email]
  );

  return result.rows[0] || null;
}

async function deleteByEmail(email) {
  const result = await pool.query(
    `
    DELETE FROM password_reset_otps
    WHERE email = $1
    RETURNING *
    `,
    [email]
  );

  return result.rows[0] || null;
}

async function deleteExpired() {
  const result = await pool.query(
    `
    DELETE FROM password_reset_otps
    WHERE expires_at <= NOW()
    RETURNING *
    `
  );

  return result.rows;
}

module.exports = {
  createResetOTP,
  findByEmail,
  incrementAttempts,
  deleteByEmail,
  deleteExpired,
};

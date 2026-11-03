const { pool } = require('../../config/db');

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

/*
 * ---------------------------------------------------------------------------
 * Reset-link rate limiting
 * ---------------------------------------------------------------------------
 * The table is shared with the legacy OTP flow, which stores a bcrypt hash in
 * otp_hash. The Firebase flow stores no hash at all: its row exists purely to
 * record that a reset link was recently issued, so one address cannot be used
 * to flood an inbox with Firebase mail.
 *
 * The cooldown window is encoded in expires_at rather than in a new column.
 * While expires_at is still in the future the address is in cooldown; once it
 * lapses the row is simply overwritten by the next send. That keeps the ledger
 * to one row per address with no separate sweep job.
 *
 * This works across restarts and across every instance behind Render's load
 * balancer, which an in-process timer would not.
 */

/**
 * Records that a reset link was just issued, starting a fresh cooldown window.
 *
 * Delete-then-insert rather than ON CONFLICT, because the legacy flow does the
 * same dance and that implies no unique index on email is guaranteed to exist.
 * Doing it explicitly keeps this working on an installation that has one and on
 * one that does not.
 */
async function markResetLinkSent({ email, userId = null, sentAt, cooldownSeconds }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM password_reset_otps WHERE email = $1', [email]);

    const result = await client.query(
      `
      INSERT INTO password_reset_otps (user_id, otp_hash, expires_at, email, attempts)
      VALUES ($1, NULL, $2, $3, 0)
      RETURNING *
      `,
      [userId, new Date(sentAt.getTime() + cooldownSeconds * 1000), email]
    );

    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(
        `[PASSWORD_RESET] Rollback failed: ${rollbackError.message}`
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Seconds remaining before another reset link may be issued, or 0 when free. */
async function getCooldownSeconds(email) {
  const result = await pool.query(
    `
    SELECT
      EXTRACT(EPOCH FROM (expires_at - NOW()))::bigint AS remaining_seconds
    FROM password_reset_otps
    WHERE email = $1
      AND expires_at > NOW()
    LIMIT 1
    `,
    [email]
  );

  const remaining = Number(result.rows[0]?.remaining_seconds ?? 0);
  return Number.isFinite(remaining) && remaining > 0 ? remaining : 0;
}

/** Drops the cooldown marker once a reset has actually completed. */
async function clearResetLinkMarker(email) {
  const result = await pool.query(
    `
    DELETE FROM password_reset_otps
    WHERE email = $1
      AND otp_hash IS NULL
    RETURNING *
    `,
    [email]
  );

  return result.rows[0] || null;
}

module.exports = {
  createResetOTP,
  findByEmail,
  incrementAttempts,
  deleteByEmail,
  deleteExpired,
  markResetLinkSent,
  getCooldownSeconds,
  clearResetLinkMarker,
};

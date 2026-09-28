const { pool } = require('../config/db');

/*
 * Staging table for registrations that have not been proven yet.
 *
 * This table is shared by two verification transports:
 *
 *   verification_flow = 'OTP'        the original 4-digit code, still used by the
 *                                    Admin app and any client build predating
 *                                    this feature. Unchanged.
 *   verification_flow = 'EMAIL_LINK' the Firebase email-link flow, where
 *                                    otp_hash is NULL and the Firebase identity
 *                                    is held in firebase_uid.
 *
 * A password_hash always sits in this table rather than in residents, so an
 * unverified signup is never a loginable account. The resident row is only ever
 * created after Firebase reports the address as verified.
 */

async function createPendingRegistration({
  registrationId,
  username,
  email,
  firstName,
  lastName,
  passwordHash,
  otpHash = null,
  expiresAt,
  attempts = 0,
  firebaseUid = null,
  verificationFlow = 'OTP',
  verificationSentAt = null,
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
      attempts,
      firebase_uid,
      verification_flow,
      verification_sent_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
      firebaseUid,
      verificationFlow,
      verificationSentAt,
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

/**
 * Records that a new verification link was just issued.
 *
 * This is also the resend cooldown clock. A single timestamp is enough for
 * both purposes and avoids a second column that could disagree with the first.
 */
async function touchVerificationSent(registrationId, sentAt) {
  const result = await pool.query(
    `
    UPDATE pending_registrations
    SET verification_sent_at = $2
    WHERE registration_id = $1
    RETURNING *
    `,
    [registrationId, sentAt]
  );

  return result.rows[0] || null;
}

/**
 * Records the Firebase identity for a pending registration.
 *
 * Used when registration is retried with an address that already has an
 * unverified Firebase record from an earlier abandoned attempt, so the same
 * identity is reused instead of creating a duplicate Firebase user.
 */
async function attachFirebaseUid(registrationId, firebaseUid) {
  const result = await pool.query(
    `
    UPDATE pending_registrations
    SET firebase_uid = $2
    WHERE registration_id = $1
    RETURNING *
    `,
    [registrationId, firebaseUid]
  );

  return result.rows[0] || null;
}

/**
 * Clears an abandoned signup for one address so a retry is not blocked by a
 * dead row, while leaving any in-flight signup for other addresses alone.
 */
async function deleteUnverifiedByEmail(email) {
  const result = await pool.query(
    `
    DELETE FROM pending_registrations
    WHERE lower(email) = lower($1)
    RETURNING *
    `,
    [email]
  );

  return result.rows;
}

module.exports = {
  createPendingRegistration,
  findByRegistrationId,
  incrementAttempts,
  deleteByRegistrationId,
  deleteExpired,
  touchVerificationSent,
  attachFirebaseUid,
  deleteUnverifiedByEmail,
};

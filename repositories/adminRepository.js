const { pool } = require('../config/db');

async function findByIdentifier(identifier) {
  const result = await pool.query(
    `
    SELECT *
    FROM admins
    WHERE username = $1
       OR email = $1
       OR admin_id = $1
    LIMIT 1
    `,
    [identifier]
  );

  return result.rows[0] || null;
}

async function findByAdminId(adminId) {
  const result = await pool.query(
    `
    SELECT *
    FROM admins
    WHERE admin_id = $1
    LIMIT 1
    `,
    [adminId]
  );

  return result.rows[0] || null;
}

async function findByUsername(username) {
  const result = await pool.query(
    `
    SELECT *
    FROM admins
    WHERE username = $1
    LIMIT 1
    `,
    [username]
  );

  return result.rows[0] || null;
}

async function findByEmail(email) {
  const result = await pool.query(
    `
    SELECT *
    FROM admins
    WHERE email = $1
    LIMIT 1
    `,
    [email]
  );

  return result.rows[0] || null;
}

async function createAdmin({
  adminId,
  firstName,
  lastName,
  username,
  email,
  passwordHash,
  address = '',
  profileImage = '',
  isVerified = true,
  role = 'ADMIN',
  phoneNumber = '',
}) {
  const result = await pool.query(
    `
    INSERT INTO admins (
      admin_id,
      first_name,
      last_name,
      username,
      email,
      password_hash,
      address,
      profile_image,
      is_verified,
      role,
      phone_number
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11
    )
    RETURNING *
    `,
    [
      adminId,
      firstName,
      lastName,
      username,
      email,
      passwordHash,
      address,
      profileImage,
      isVerified,
      role,
      phoneNumber,
    ]
  );

  return result.rows[0];
}

async function updateAdmin(adminId, updates) {
  const allowedFields = {
    firstName: 'first_name',
    lastName: 'last_name',
    username: 'username',
    email: 'email',
    address: 'address',
    profileImage: 'profile_image',
    isVerified: 'is_verified',
    role: 'role',
    phoneNumber: 'phone_number',
  };

  const setParts = [];
  const values = [];
  let parameterIndex = 1;

  for (const [field, value] of Object.entries(updates)) {
    const column = allowedFields[field];

    if (!column) continue;

    setParts.push(`${column} = $${parameterIndex}`);
    values.push(value);
    parameterIndex++;
  }

  if (setParts.length === 0) {
    return findByAdminId(adminId);
  }

  setParts.push(`updated_at = NOW()`);

  values.push(adminId);

  const result = await pool.query(
    `
    UPDATE admins
    SET ${setParts.join(', ')}
    WHERE admin_id = $${parameterIndex}
    RETURNING *
    `,
    values
  );

  return result.rows[0] || null;
}

async function touchLastActive(adminId) {
  const result = await pool.query(
    `
    UPDATE admins
    SET last_active = NOW()
    WHERE admin_id = $1
    RETURNING last_active
    `,
    [adminId]
  );

  return result.rows[0]?.last_active || null;
}

async function updatePassword(adminId, passwordHash) {
  const result = await pool.query(
    `
    UPDATE admins
    SET password_hash = $1,
        updated_at = NOW()
    WHERE admin_id = $2
    RETURNING *
    `,
    [passwordHash, adminId]
  );

  return result.rows[0] || null;
}

/**
 * Phase 3A: binds a device FCM token to an administrator. Mirrors
 * residentRepository.claimFcmToken: an advisory transaction lock guarantees a
 * token can never be bound to two accounts, and account switching on one device
 * moves the token instead of duplicating it.
 */
async function claimFcmToken(adminId, token) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('myecowatch:phase-3a:admin-fcm-token:v1'))"
    );
    await client.query(
      `
      UPDATE admins
      SET fcm_token = NULL
      WHERE fcm_token = $1
        AND admin_id <> $2
      `,
      [token, adminId]
    );
    const result = await client.query(
      `
      UPDATE admins
      SET fcm_token = $2,
          updated_at = NOW()
      WHERE admin_id = $1
        AND lower(trim(COALESCE(role, 'ADMIN'))) = 'admin'
      RETURNING admin_id
      `,
      [adminId, token]
    );
    await client.query('COMMIT');
    return result.rowCount === 1;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(`[ADMIN_FCM_TOKEN] Rollback failed: ${rollbackError.message}`);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function clearFcmToken(adminId, expectedToken = null) {
  const values = expectedToken ? [adminId, expectedToken] : [adminId];
  const predicate = expectedToken ? 'AND fcm_token = $2' : '';
  const result = await pool.query(
    `
    UPDATE admins
    SET fcm_token = NULL
    WHERE admin_id = $1
      ${predicate}
    RETURNING admin_id
    `,
    values
  );
  return result.rowCount === 1;
}

/** Removes a token FCM has already rejected, wherever it is still stored. */
async function clearFcmTokenByValue(token) {
  const result = await pool.query(
    `
    UPDATE admins
    SET fcm_token = NULL
    WHERE fcm_token = $1
    RETURNING admin_id
    `,
    [token]
  );
  return result.rowCount;
}

/** Every administrator device currently eligible to receive a broadcast. */
async function findAllFcmTokens(queryable = pool) {
  const result = await queryable.query(
    `
    SELECT admin_id, fcm_token
    FROM admins
    WHERE fcm_token IS NOT NULL
      AND btrim(fcm_token) <> ''
      AND lower(trim(COALESCE(role, 'ADMIN'))) = 'admin'
    `
  );

  return result.rows
    .map((row) => ({ adminId: row.admin_id, token: row.fcm_token }))
    .filter((row) => typeof row.token === 'string' && row.token.trim().length > 0);
}

module.exports = {
  findByIdentifier,
  findByAdminId,
  findByUsername,
  findByEmail,
  createAdmin,
  updateAdmin,
  touchLastActive,
  updatePassword,
  claimFcmToken,
  clearFcmToken,
  clearFcmTokenByValue,
  findAllFcmTokens,
};

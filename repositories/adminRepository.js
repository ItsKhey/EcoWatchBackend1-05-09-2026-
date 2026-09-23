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

module.exports = {
  findByIdentifier,
  findByAdminId,
  findByUsername,
  findByEmail,
  createAdmin,
  updateAdmin,
  updatePassword,
};

const { pool } = require('../config/db');

async function findByIdentifier(identifier) {
  const result = await pool.query(
    `
    SELECT *
    FROM residents
    WHERE username = $1
       OR email = $1
       OR resident_id = $1
    LIMIT 1
    `,
    [identifier]
  );

  return result.rows[0] || null;
}

async function findByResidentId(residentId) {
  const result = await pool.query(
    `
    SELECT *
    FROM residents
    WHERE resident_id = $1
    LIMIT 1
    `,
    [residentId]
  );

  return result.rows[0] || null;
}

async function findByUsername(username) {
  const result = await pool.query(
    `
    SELECT *
    FROM residents
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
    FROM residents
    WHERE email = $1
    LIMIT 1
    `,
    [email]
  );

  return result.rows[0] || null;
}

async function findByRole(role) {
  const result = await pool.query(
    `
    SELECT *
    FROM residents
    WHERE role = $1
    ORDER BY created_at DESC
    `,
    [role]
  );

  return result.rows;
}

async function createResident({
  residentId,
  firstName,
  lastName,
  username,
  email,
  passwordHash,
  address = '',
  profileImage = '',
  isVerified = true,
  role = 'RESIDENT',
  status = 'AVAILABLE',
  phoneNumber = '',
  createdById = 'SYSTEM',
}) {
  const result = await pool.query(
    `
    INSERT INTO residents (
      resident_id,
      first_name,
      last_name,
      username,
      email,
      password_hash,
      address,
      profile_image,
      is_verified,
      role,
      status,
      phone_number,
      created_by_id
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13
    )
    RETURNING *
    `,
    [
      residentId,
      firstName,
      lastName,
      username,
      email,
      passwordHash,
      address,
      profileImage,
      isVerified,
      role,
      status,
      phoneNumber,
      createdById,
    ]
  );

  return result.rows[0];
}

async function updateResident(residentId, updates) {
  const allowedFields = {
    firstName: 'first_name',
    lastName: 'last_name',
    username: 'username',
    email: 'email',
    address: 'address',
    profileImage: 'profile_image',
    isVerified: 'is_verified',
    role: 'role',
    status: 'status',
    phoneNumber: 'phone_number',
    createdById: 'created_by_id',
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
    return findByResidentId(residentId);
  }

  setParts.push(`updated_at = NOW()`);

  values.push(residentId);

  const result = await pool.query(
    `
    UPDATE residents
    SET ${setParts.join(', ')}
    WHERE resident_id = $${parameterIndex}
    RETURNING *
    `,
    values
  );

  return result.rows[0] || null;
}

async function updatePassword(residentId, passwordHash) {
  const result = await pool.query(
    `
    UPDATE residents
    SET password_hash = $1,
        updated_at = NOW()
    WHERE resident_id = $2
    RETURNING *
    `,
    [passwordHash, residentId]
  );

  return result.rows[0] || null;
}

module.exports = {
  findByIdentifier,
  findByResidentId,
  findByUsername,
  findByEmail,
  findByRole,
  createResident,
  updateResident,
  updatePassword,
};

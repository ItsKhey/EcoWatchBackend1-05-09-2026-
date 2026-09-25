const { pool } = require('../config/db');

const PERSONNEL_SELECT_FIELDS = `
  p.personnel_id,
  p.first_name,
  p.last_name,
  p.address,
  p.email,
  p.username,
  p.role,
  p.status,
  p.last_active,
  p.current_assignment_report_id,
  p.current_assignment_location,
  p.current_assignment_assigned_at,
  p.enabled,
  p.disabled_at,
  p.deleted_at,
  p.phone_number,
  p.created_by_admin_id,
  p.updated_by_admin_id,
  p.disabled_by_admin_id,
  p.deleted_by_admin_id,
  p.created_at,
  p.updated_at,
  r.title AS assignment_title,
  r.category AS assignment_category,
  r.description AS assignment_description,
  r.latitude AS assignment_latitude,
  r.longitude AS assignment_longitude,
  r.status AS assignment_report_status,
  r.priority AS assignment_priority,
  r.is_archived AS assignment_is_archived,
  r.is_deleted AS assignment_is_deleted
`;

const PERSONNEL_FROM = `
  FROM personnel_accounts p
  LEFT JOIN reports r
    ON r.report_id = p.current_assignment_report_id
`;

const PERSONNEL_SELECT = `SELECT ${PERSONNEL_SELECT_FIELDS} ${PERSONNEL_FROM}`;
const withTotalCount = `SELECT ${PERSONNEL_SELECT_FIELDS}, COUNT(*) OVER() AS total_count ${PERSONNEL_FROM}`;

async function findAll(options = {}, queryable = pool) {
  const values = [];
  const conditions = [];

  if (!options.includeInactive) {
    conditions.push('p.enabled = true');
  }

  if (!options.includeDeleted) {
    conditions.push('p.deleted_at IS NULL');
  }

  if (options.status) {
    values.push(options.status);
    conditions.push(`p.status = $${values.length}`);
  }

  if (options.search) {
    values.push(`%${options.search}%`);
    const searchParameter = `$${values.length}`;
    conditions.push(`(
      p.personnel_id ILIKE ${searchParameter}
      OR p.first_name ILIKE ${searchParameter}
      OR p.last_name ILIKE ${searchParameter}
      OR p.username ILIKE ${searchParameter}
      OR p.email ILIKE ${searchParameter}
    )`);
  }

  values.push(options.limit);
  const limitParameter = `$${values.length}`;
  values.push(options.offset);
  const offsetParameter = `$${values.length}`;

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await queryable.query(
    `
    ${withTotalCount}
    ${whereClause}
    ORDER BY
      p.status = 'CLEANING' DESC,
      p.status = 'ONLINE' DESC,
      p.created_at DESC,
      p.personnel_id
    LIMIT ${limitParameter} OFFSET ${offsetParameter}
    `,
    values
  );

  return result.rows;
}

async function findByPersonnelId(personnelId, queryable = pool) {
  const result = await queryable.query(
    `
    ${PERSONNEL_SELECT}
    WHERE p.personnel_id = $1
    LIMIT 1
    `,
    [personnelId]
  );

  return result.rows[0] || null;
}

async function findForLogin(identifier) {
  const result = await pool.query(
    `
    SELECT
      p.*,
      r.title AS assignment_title,
      r.category AS assignment_category,
      r.description AS assignment_description,
      r.latitude AS assignment_latitude,
      r.longitude AS assignment_longitude,
      r.status AS assignment_report_status,
      r.priority AS assignment_priority
    FROM personnel_accounts p
    LEFT JOIN reports r
      ON r.report_id = p.current_assignment_report_id
    WHERE lower(p.username) = lower($1)
       OR lower(p.email) = lower($1)
       OR upper(p.personnel_id) = upper($1)
    LIMIT 1
    `,
    [identifier]
  );

  return result.rows[0] || null;
}

async function findByUsername(username) {
  const result = await pool.query(
    `
    ${PERSONNEL_SELECT}
    WHERE lower(p.username) = lower($1)
    LIMIT 1
    `,
    [username]
  );

  return result.rows[0] || null;
}

async function findByEmail(email) {
  const result = await pool.query(
    `
    ${PERSONNEL_SELECT}
    WHERE lower(p.email) = lower($1)
    LIMIT 1
    `,
    [email]
  );

  return result.rows[0] || null;
}

async function findActiveByIds(personnelIds, { lock = false, queryable = pool } = {}) {
  if (!personnelIds.length) {
    return [];
  }

  const result = await queryable.query(
    `
    SELECT *
    FROM personnel_accounts
    WHERE personnel_id = ANY($1::varchar[])
      AND enabled = true
      AND deleted_at IS NULL
    ORDER BY personnel_id
    ${lock ? 'FOR UPDATE' : ''}
    `,
    [personnelIds]
  );

  return result.rows;
}

async function findCredentialConflict(
  { username, email, excludePersonnelId = null },
  queryable = pool
) {
  const result = await queryable.query(
    `
    SELECT source
    FROM (
      SELECT 'PERSONNEL' AS source
      FROM personnel_accounts
      WHERE lower(username) = lower($1)
        AND ($3::varchar IS NULL OR personnel_id <> $3)

      UNION ALL

      SELECT 'ADMIN' AS source
      FROM admins
      WHERE lower(username) = lower($1)

      UNION ALL

      SELECT 'RESIDENT' AS source
      FROM residents
      WHERE lower(username) = lower($1)

      UNION ALL

      SELECT 'PERSONNEL' AS source
      FROM personnel_accounts
      WHERE lower(email) = lower($2)
        AND ($3::varchar IS NULL OR personnel_id <> $3)

      UNION ALL

      SELECT 'ADMIN' AS source
      FROM admins
      WHERE email IS NOT NULL
        AND lower(email) = lower($2)

      UNION ALL

      SELECT 'RESIDENT' AS source
      FROM residents
      WHERE email IS NOT NULL
        AND lower(email) = lower($2)
    ) conflicts
    LIMIT 1
    `,
    [username, email, excludePersonnelId]
  );

  return result.rows[0]?.source || null;
}

async function createPersonnel(
  {
    firstName,
    lastName,
    address = '',
    email,
    username,
    passwordHash,
    phoneNumber = null,
    createdByAdminId,
  },
  queryable = pool
) {
  if (typeof passwordHash !== 'string' || passwordHash.trim().length === 0) {
    const error = new Error('Personnel password hash is required before insert.');
    error.statusCode = 500;
    throw error;
  }

  const result = await queryable.query(
    `
    INSERT INTO personnel_accounts (
      first_name,
      last_name,
      address,
      email,
      username,
      password_hash,
      phone_number,
      created_by_admin_id,
      updated_by_admin_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
    RETURNING personnel_id
    `,
    [
      firstName,
      lastName,
      address,
      email,
      username,
      passwordHash,
      phoneNumber,
      createdByAdminId,
    ]
  );

  return findByPersonnelId(result.rows[0].personnel_id, queryable);
}

async function updatePersonnel(personnelId, updates, updatedByAdminId, queryable = pool) {
  const allowedFields = {
    firstName: 'first_name',
    lastName: 'last_name',
    address: 'address',
    email: 'email',
    username: 'username',
    phoneNumber: 'phone_number',
  };
  const setParts = [];
  const values = [];

  for (const [field, value] of Object.entries(updates)) {
    const column = allowedFields[field];

    if (!column) {
      continue;
    }

    values.push(value);
    setParts.push(`${column} = $${values.length}`);
  }

  values.push(updatedByAdminId);
  const updatedByParameter = `$${values.length}`;
  values.push(personnelId);
  const personnelParameter = `$${values.length}`;

  const result = await queryable.query(
    `
    UPDATE personnel_accounts
    SET ${setParts.join(', ')},
        updated_by_admin_id = ${updatedByParameter}
    WHERE personnel_id = ${personnelParameter}
      AND deleted_at IS NULL
    RETURNING personnel_id
    `,
    values
  );

  return result.rows[0]
    ? findByPersonnelId(result.rows[0].personnel_id, queryable)
    : null;
}

async function updatePassword(personnelId, passwordHash, updatedByAdminId, queryable = pool) {
  const result = await queryable.query(
    `
    UPDATE personnel_accounts
    SET password_hash = $1,
        updated_by_admin_id = $2
    WHERE personnel_id = $3
      AND deleted_at IS NULL
    RETURNING personnel_id
    `,
    [passwordHash, updatedByAdminId, personnelId]
  );

  return result.rows[0]
    ? findByPersonnelId(result.rows[0].personnel_id, queryable)
    : null;
}

async function updateStatus(personnelId, status, updatedByAdminId, queryable = pool) {
  const result = await queryable.query(
    `
    UPDATE personnel_accounts
    SET status = $1,
        updated_by_admin_id = $2
    WHERE personnel_id = $3
      AND enabled = true
      AND deleted_at IS NULL
    RETURNING personnel_id
    `,
    [status, updatedByAdminId, personnelId]
  );

  return result.rows[0]
    ? findByPersonnelId(result.rows[0].personnel_id, queryable)
    : null;
}

async function updateLastActive(personnelId) {
  const result = await pool.query(
    `
    UPDATE personnel_accounts
    SET last_active = NOW()
    WHERE personnel_id = $1
      AND enabled = true
      AND deleted_at IS NULL
    RETURNING last_active
    `,
    [personnelId]
  );

  return result.rows[0]?.last_active || null;
}

async function disablePersonnel(personnelId, disabledByAdminId, queryable = pool) {
  const result = await queryable.query(
    `
    UPDATE personnel_accounts
    SET enabled = false,
        disabled_at = COALESCE(disabled_at, NOW()),
        disabled_by_admin_id = $1,
        updated_by_admin_id = $1,
        status = 'OFFLINE'
    WHERE personnel_id = $2
      AND deleted_at IS NULL
      AND current_assignment_report_id IS NULL
    RETURNING personnel_id
    `,
    [disabledByAdminId, personnelId]
  );

  return result.rows[0]
    ? findByPersonnelId(result.rows[0].personnel_id, queryable)
    : null;
}

async function enablePersonnel(personnelId, updatedByAdminId, queryable = pool) {
  const result = await queryable.query(
    `
    UPDATE personnel_accounts
    SET enabled = true,
        disabled_at = NULL,
        disabled_by_admin_id = NULL,
        updated_by_admin_id = $1,
        status = 'OFFLINE'
    WHERE personnel_id = $2
      AND deleted_at IS NULL
      AND current_assignment_report_id IS NULL
    RETURNING personnel_id
    `,
    [updatedByAdminId, personnelId]
  );

  return result.rows[0]
    ? findByPersonnelId(result.rows[0].personnel_id, queryable)
    : null;
}

async function deletePersonnel(personnelId, deletedByAdminId, queryable = pool) {
  const result = await queryable.query(
    `
    UPDATE personnel_accounts
    SET enabled = false,
        status = 'OFFLINE',
        disabled_at = COALESCE(disabled_at, NOW()),
        disabled_by_admin_id = COALESCE(disabled_by_admin_id, $1),
        deleted_at = COALESCE(deleted_at, NOW()),
        deleted_by_admin_id = $1,
        updated_by_admin_id = $1
    WHERE personnel_id = $2
      AND deleted_at IS NULL
      AND current_assignment_report_id IS NULL
    RETURNING personnel_id
    `,
    [deletedByAdminId, personnelId]
  );

  return result.rows[0]
    ? findByPersonnelId(result.rows[0].personnel_id, queryable)
    : null;
}

async function restorePersonnel(personnelId, updatedByAdminId, queryable = pool) {
  const result = await queryable.query(
    `
    UPDATE personnel_accounts
    SET enabled = true,
        disabled_at = NULL,
        disabled_by_admin_id = NULL,
        deleted_at = NULL,
        deleted_by_admin_id = NULL,
        updated_by_admin_id = $1,
        status = 'OFFLINE'
    WHERE personnel_id = $2
      AND current_assignment_report_id IS NULL
    RETURNING personnel_id
    `,
    [updatedByAdminId, personnelId]
  );

  return result.rows[0]
    ? findByPersonnelId(result.rows[0].personnel_id, queryable)
    : null;
}

async function syncReportAssignments(
  {
    reportId,
    location = null,
    previousPersonnelIds = [],
    nextPersonnelIds = [],
    updatedByAdminId,
  },
  queryable = pool
) {
  const previousIds = [...new Set(previousPersonnelIds)].filter(Boolean);
  const nextIds = [...new Set(nextPersonnelIds)].filter(Boolean);
  const idsToClear = previousIds.filter((personnelId) => !nextIds.includes(personnelId));

  if (idsToClear.length) {
    await queryable.query(
      `
      UPDATE personnel_accounts
      SET current_assignment_report_id = NULL,
          current_assignment_location = NULL,
          current_assignment_assigned_at = NULL,
          status = CASE
            WHEN status = 'CLEANING' THEN 'OFFLINE'
            ELSE status
          END,
          updated_by_admin_id = $1
      WHERE personnel_id = ANY($2::varchar[])
        AND current_assignment_report_id = $3
      `,
      [updatedByAdminId, idsToClear, reportId]
    );
  }

  if (nextIds.length) {
    await queryable.query(
      `
      UPDATE personnel_accounts
      SET current_assignment_report_id = $1,
          current_assignment_location = $2::jsonb,
          current_assignment_assigned_at = NOW(),
          status = 'CLEANING',
          updated_by_admin_id = $3
      WHERE personnel_id = ANY($4::varchar[])
        AND enabled = true
        AND deleted_at IS NULL
      `,
      [
        reportId,
        location ? JSON.stringify(location) : null,
        updatedByAdminId,
        nextIds,
      ]
    );
  }
}

async function clearCurrentAssignmentsForReport(
  reportId,
  updatedByAdminId,
  queryable = pool
) {
  const result = await queryable.query(
    `
    UPDATE personnel_accounts
    SET current_assignment_report_id = NULL,
        current_assignment_location = NULL,
        current_assignment_assigned_at = NULL,
        status = CASE
          WHEN status = 'CLEANING' THEN 'OFFLINE'
          ELSE status
        END,
        updated_by_admin_id = $1
    WHERE current_assignment_report_id = $2
    RETURNING personnel_id
    `,
    [updatedByAdminId, reportId]
  );

  return result.rows.map((row) => row.personnel_id);
}

module.exports = {
  findAll,
  findByPersonnelId,
  findForLogin,
  findByUsername,
  findByEmail,
  findActiveByIds,
  findCredentialConflict,
  createPersonnel,
  updatePersonnel,
  updatePassword,
  updateStatus,
  updateLastActive,
  disablePersonnel,
  enablePersonnel,
  deletePersonnel,
  restorePersonnel,
  syncReportAssignments,
  clearCurrentAssignmentsForReport,
};

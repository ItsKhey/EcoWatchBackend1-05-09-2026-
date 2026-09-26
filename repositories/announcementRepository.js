const { pool } = require('../config/db');

const mapAnnouncement = (row) => {
  if (!row) return null;

  return {
    id: row.id,
    announcementId: row.id === null || row.id === undefined ? null : String(row.id),
    title: row.title,
    message: row.message,
    audience: row.audience,
    barangay: row.barangay || null,
    targetResidentIds: Array.isArray(row.target_resident_ids)
      ? row.target_resident_ids
      : [],
    priority: row.priority,
    createdByAdminId: row.created_by_admin_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
  };
};

async function createAnnouncement(
  {
    title,
    message,
    audience,
    barangay = null,
    targetResidentIds = [],
    priority,
    createdByAdminId = null,
  },
  queryable = pool
) {
  const result = await queryable.query(
    `
    INSERT INTO announcements (
      title,
      message,
      audience,
      barangay,
      target_resident_ids,
      priority,
      created_by_admin_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
    `,
    [
      title,
      message,
      audience,
      barangay,
      targetResidentIds,
      priority,
      createdByAdminId,
    ]
  );

  return mapAnnouncement(result.rows[0]);
}

async function findAll({ limit = 50, offset = 0 } = {}, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT *
    FROM announcements
    ORDER BY created_at DESC, id DESC
    LIMIT $1 OFFSET $2
    `,
    [limit, offset]
  );

  return result.rows.map(mapAnnouncement);
}

async function countAll(queryable = pool) {
  const result = await queryable.query(
    'SELECT COUNT(*)::int AS total FROM announcements'
  );

  return Number(result.rows[0]?.total || 0);
}

/**
 * Announcements this resident is allowed to see, newest first.
 *
 * ALL_RESIDENTS is the only audience that resolves to content today. The
 * narrowed scopes are already stored, so their branches are written out and
 * simply match nothing until the backend starts publishing them: this keeps
 * the visibility rule in one place instead of splitting it across the query
 * and the controller.
 */
async function findForResident(
  residentId,
  { limit = 20, offset = 0 } = {},
  queryable = pool
) {
  const result = await queryable.query(
    `
    SELECT *
    FROM announcements
    WHERE audience = 'ALL_RESIDENTS'
       OR (audience = 'SELECTED_RESIDENTS' AND $1 = ANY(target_resident_ids))
       OR (audience = 'BARANGAY' AND barangay IS NOT NULL AND EXISTS (
              SELECT 1
              FROM residents r
              WHERE r.resident_id = $1
                AND r.address ILIKE '%' || announcements.barangay || '%'
            ))
    ORDER BY created_at DESC, id DESC
    LIMIT $2 OFFSET $3
    `,
    [residentId, limit, offset]
  );

  return result.rows.map(mapAnnouncement);
}

async function findById(announcementId, queryable = pool) {
  const result = await queryable.query(
    'SELECT * FROM announcements WHERE id = $1 LIMIT 1',
    [announcementId]
  );

  return mapAnnouncement(result.rows[0]);
}

module.exports = {
  createAnnouncement,
  findAll,
  findForResident,
  findById,
  countAll,
  mapAnnouncement,
};

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
    // NULL when the administrator chose a window that does not expire on a
    // timer, which is not the same as an announcement that has already expired.
    expiresAt: row.expires_at === undefined ? null : row.expires_at || null,
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
    expiresInDays = null,
  },
  queryable = pool
) {
  // The deadline is derived here rather than accepted from the client so the
  // database clock is the authority. NOW() is evaluated inside the INSERT, which
  // is the same instant the row's created_at default is stamped.
  //
  // 0 means "never expires" and is stored as NULL. It must be special-cased
  // here: treating it as an offset would compute NOW() + 0 days, which is an
  // announcement that lapses the instant it is published.
  const result = await queryable.query(
    `
    INSERT INTO announcements (
      title,
      message,
      audience,
      barangay,
      target_resident_ids,
      priority,
      created_by_admin_id,
      expires_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      CASE
        WHEN $8::int IS NULL OR $8::int = 0 THEN NULL
        ELSE NOW() + ($8::int * INTERVAL '1 day')
      END
    )
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
      expiresInDays,
    ]
  );

  return mapAnnouncement(result.rows[0]);
}

/**
 * The condition every read shares: an announcement is visible until its
 * deadline passes.
 *
 * <p>Filtering on read is what makes the deadline exact. Relying on the nightly
 * cleanup alone would keep an expired announcement readable for up to a day
 * after it lapsed, and would hide a just-published row if the job happened to
 * run between validation and delivery. NULL means "no timer", which stays
 * visible.
 */
const NOT_EXPIRED = '(expires_at IS NULL OR expires_at > NOW())';

async function findAll({ limit = 50, offset = 0 } = {}, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT *
    FROM announcements
    WHERE ${NOT_EXPIRED}
    ORDER BY created_at DESC, id DESC
    LIMIT $1 OFFSET $2
    `,
    [limit, offset]
  );

  return result.rows.map(mapAnnouncement);
}

/**
 * Expired announcements, oldest deadline first.
 *
 * <p>Used by the cleanup job. RETURNING the title keeps the job's log useful
 * without a second round trip.
 */
async function findExpired({ limit = 500 } = {}, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT id, title, expires_at
    FROM announcements
    WHERE expires_at IS NOT NULL AND expires_at <= NOW()
    ORDER BY expires_at ASC
    LIMIT $1
    `,
    [limit]
  );

  return result.rows;
}

/**
 * Permanently deletes announcements whose deadline has passed and returns how
 * many rows went away.
 *
 * <p>Announcements are a broadcast record with no trash or archive table, so
 * this is a real DELETE rather than a soft delete: once a deadline passes the
 * row is gone for everyone, including the administrator's own list.
 */
async function deleteExpired(queryable = pool) {
  const result = await queryable.query(
    `
    DELETE FROM announcements
    WHERE expires_at IS NOT NULL AND expires_at <= NOW()
    `
  );

  return result.rowCount || 0;
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
 *
 * Expired announcements are filtered out here, not only by the cleanup job, so
 * a lapsed deadline takes effect the moment it passes.
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
    WHERE ${NOT_EXPIRED}
       AND (
            audience = 'ALL_RESIDENTS'
         OR (audience = 'SELECTED_RESIDENTS' AND $1 = ANY(target_resident_ids))
         OR (audience = 'BARANGAY' AND barangay IS NOT NULL AND EXISTS (
               SELECT 1
               FROM residents r
               WHERE r.resident_id = $1
                 AND r.address ILIKE '%' || announcements.barangay || '%'
             ))
       )
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
  findExpired,
  findForResident,
  findById,
  countAll,
  deleteExpired,
  mapAnnouncement,
  NOT_EXPIRED,
};

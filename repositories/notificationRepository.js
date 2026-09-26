const { pool } = require('../config/db');
const { tablesFor } = require('../utils/notificationTables');

/**
 * Notification store for the account that owns the rows.
 *
 * Resident and administrator accounts are stored in separate table pairs that
 * mirror each other, because the resident tables are referentially bound to
 * the residents table. The SQL is otherwise identical for both, so every
 * caller keeps one code path: list, read, unread count, trash, and delete all
 * resolve their tables from the owner ID.
 */

const activeNotificationSelect = (tables) => `
  SELECT n.*
  FROM ${tables.notifications} n
  WHERE n.resident_id = $1
    AND NOT EXISTS (
      SELECT 1
      FROM ${tables.trash} t
      WHERE t.notification_id = n.notification_id
        AND t.resident_id = n.resident_id
    )
`;

async function findAllByResidentId(residentId, limit = 200, queryable = pool) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 200));
  const result = await queryable.query(
    `
    ${activeNotificationSelect(tablesFor(residentId))}
    ORDER BY n.created_at DESC, n.notification_id DESC
    LIMIT $2
    `,
    [residentId, safeLimit]
  );

  return result.rows;
}

async function findTrashByResidentId(residentId, limit = 200, queryable = pool) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 200));
  const tables = tablesFor(residentId);
  const result = await queryable.query(
    `
    SELECT n.*, t.deleted_at AS trashed_at
    FROM ${tables.trash} t
    JOIN ${tables.notifications} n
      ON n.notification_id = t.notification_id
     AND n.resident_id = t.resident_id
    WHERE t.resident_id = $1
    ORDER BY t.deleted_at DESC, n.notification_id DESC
    LIMIT $2
    `,
    [residentId, safeLimit]
  );

  return result.rows;
}

async function findById(notificationId, queryable = pool) {
  // Unscoped lookup is only used for diagnostics; it reads the resident table
  // so it can never leak an administrator's notification.
  const result = await queryable.query(
    `
    SELECT *
    FROM notifications
    WHERE notification_id = $1
    LIMIT 1
    `,
    [notificationId]
  );

  return result.rows[0] || null;
}

async function findOwnedById(notificationId, residentId, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT *
    FROM ${tablesFor(residentId).notifications}
    WHERE notification_id = $1
      AND resident_id = $2
    LIMIT 1
    `,
    [notificationId, residentId]
  );

  return result.rows[0] || null;
}

async function createNotification({
  residentId,
  reportId = null,
  title,
  message,
  type,
  isRead = false,
}, queryable = pool) {
  const result = await queryable.query(
    `
    INSERT INTO ${tablesFor(residentId).notifications} (
      resident_id,
      report_id,
      title,
      message,
      type,
      is_read
    )
    VALUES (
      $1, $2, $3, $4, $5, $6
    )
    RETURNING *
    `,
    [
      residentId,
      reportId,
      title,
      message,
      type,
      isRead,
    ]
  );

  return result.rows[0];
}

async function markAsRead(notificationId, residentId) {
  const result = await pool.query(
    `
    UPDATE ${tablesFor(residentId).notifications}
    SET is_read = true
    WHERE notification_id = $1
      AND resident_id = $2
    RETURNING *
    `,
    [notificationId, residentId]
  );

  return result.rows[0] || null;
}

async function markAllAsRead(residentId) {
  const tables = tablesFor(residentId);
  const result = await pool.query(
    `
    UPDATE ${tables.notifications} AS n
    SET is_read = true
    WHERE n.resident_id = $1
      AND n.is_read = false
      AND NOT EXISTS (
        SELECT 1
        FROM ${tables.trash} AS t
        WHERE t.notification_id = n.notification_id
          AND t.resident_id = n.resident_id
      )
    RETURNING n.notification_id
    `,
    [residentId]
  );

  return result.rows;
}

async function countUnreadByResidentId(residentId) {
  const tables = tablesFor(residentId);
  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS unread_count
    FROM ${tables.notifications} AS n
    WHERE n.resident_id = $1
      AND n.is_read = false
      AND NOT EXISTS (
        SELECT 1
        FROM ${tables.trash} AS t
        WHERE t.notification_id = n.notification_id
          AND t.resident_id = n.resident_id
      )
    `,
    [residentId]
  );

  return Number(result.rows[0]?.unread_count || 0);
}

async function deleteOwnedById(notificationId, residentId) {
  const result = await pool.query(
    `
    DELETE FROM ${tablesFor(residentId).notifications}
    WHERE notification_id = $1
      AND resident_id = $2
    RETURNING *
    `,
    [notificationId, residentId]
  );

  return result.rows[0] || null;
}

module.exports = {
  findAllByResidentId,
  findTrashByResidentId,
  findById,
  findOwnedById,
  createNotification,
  markAsRead,
  markAllAsRead,
  countUnreadByResidentId,
  deleteOwnedById,
};

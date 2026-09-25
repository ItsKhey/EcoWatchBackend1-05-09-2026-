const { pool } = require('../config/db');

const ACTIVE_NOTIFICATION_SELECT = `
  SELECT n.*
  FROM notifications n
  WHERE n.resident_id = $1
    AND NOT EXISTS (
      SELECT 1
      FROM trash_notifications t
      WHERE t.notification_id = n.notification_id
        AND t.resident_id = n.resident_id
    )
`;

async function findAllByResidentId(residentId, limit = 200, queryable = pool) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 200));
  const result = await queryable.query(
    `
    ${ACTIVE_NOTIFICATION_SELECT}
    ORDER BY n.created_at DESC, n.notification_id DESC
    LIMIT $2
    `,
    [residentId, safeLimit]
  );

  return result.rows;
}

async function findTrashByResidentId(residentId, limit = 200, queryable = pool) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 200));
  const result = await queryable.query(
    `
    SELECT n.*, t.deleted_at AS trashed_at
    FROM trash_notifications t
    JOIN notifications n
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
    FROM notifications
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
    INSERT INTO notifications (
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
    UPDATE notifications
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
  const result = await pool.query(
    `
    UPDATE notifications AS n
    SET is_read = true
    WHERE n.resident_id = $1
      AND n.is_read = false
      AND NOT EXISTS (
        SELECT 1
        FROM trash_notifications AS t
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
  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS unread_count
    FROM notifications AS n
    WHERE n.resident_id = $1
      AND n.is_read = false
      AND NOT EXISTS (
        SELECT 1
        FROM trash_notifications AS t
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
    DELETE FROM notifications
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

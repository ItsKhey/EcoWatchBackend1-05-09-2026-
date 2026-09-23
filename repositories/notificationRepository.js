const { pool } = require('../config/db');

async function findAllByResidentId(residentId) {
  const result = await pool.query(
    `
    SELECT n.*
    FROM notifications n
    WHERE n.resident_id = $1
      AND NOT EXISTS (
        SELECT 1
        FROM trash_notifications t
        WHERE t.notification_id = n.id
          AND t.resident_id = n.resident_id
      )
    ORDER BY n.created_at DESC
    `,
    [residentId]
  );

  return result.rows;
}

async function findById(id) {
  const result = await pool.query(
    `
    SELECT *
    FROM notifications
    WHERE id = $1
    LIMIT 1
    `,
    [id]
  );

  return result.rows[0] || null;
}

async function createNotification({
  residentId,
  reportId = null,
  title,
  message,
  isRead = false,
}) {
  const result = await pool.query(
    `
    INSERT INTO notifications (
      resident_id,
      report_id,
      title,
      message,
      is_read
    )
    VALUES (
      $1, $2, $3, $4, $5
    )
    RETURNING *
    `,
    [
      residentId,
      reportId,
      title,
      message,
      isRead,
    ]
  );

  return result.rows[0];
}

async function markAsRead(id) {
  const result = await pool.query(
    `
    UPDATE notifications
    SET is_read = true
    WHERE id = $1
    RETURNING *
    `,
    [id]
  );

  return result.rows[0] || null;
}

async function markAllAsRead(residentId) {
  const result = await pool.query(
    `
    UPDATE notifications
    SET is_read = true
    WHERE resident_id = $1
      AND is_read = false
    RETURNING *
    `,
    [residentId]
  );

  return result.rows;
}

async function deleteById(id) {
  const result = await pool.query(
    `
    DELETE FROM notifications
    WHERE id = $1
    RETURNING *
    `,
    [id]
  );

  return result.rows[0] || null;
}

module.exports = {
  findAllByResidentId,
  findById,
  createNotification,
  markAsRead,
  markAllAsRead,
  deleteById,
};

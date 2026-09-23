const { pool } = require('../config/db');

async function findByNotificationId(notificationId, residentId) {
  const result = await pool.query(
    `
    SELECT *
    FROM trash_notifications
    WHERE notification_id = $1
      AND resident_id = $2
    LIMIT 1
    `,
    [notificationId, residentId]
  );

  return result.rows[0] || null;
}

async function createTrashNotification(notificationId, residentId) {
  const result = await pool.query(
    `
    INSERT INTO trash_notifications (
      notification_id,
      resident_id,
      deleted_at
    )
    VALUES ($1, $2, NOW())
    RETURNING *
    `,
    [notificationId, residentId]
  );

  return result.rows[0];
}

async function deleteByNotificationId(notificationId, residentId) {
  const result = await pool.query(
    `
    DELETE FROM trash_notifications
    WHERE notification_id = $1
      AND resident_id = $2
    RETURNING *
    `,
    [notificationId, residentId]
  );

  return result.rows[0] || null;
}

async function findAllByResidentId(residentId) {
  const result = await pool.query(
    `
    SELECT *
    FROM trash_notifications
    WHERE resident_id = $1
    ORDER BY created_at DESC
    `,
    [residentId]
  );

  return result.rows;
}

module.exports = {
  findByNotificationId,
  createTrashNotification,
  deleteByNotificationId,
  findAllByResidentId,
};

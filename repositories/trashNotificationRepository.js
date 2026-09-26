const { pool } = require('../config/db');
const { tablesFor } = require('../utils/notificationTables');

/**
 * Trash store for the account that owns the rows. Mirrors
 * trashNotificationRepository and resolves its table from the owner ID so the
 * resident and administrator trash collections stay independent.
 */

async function findByNotificationId(notificationId, residentId) {
  const result = await pool.query(
    `
    SELECT *
    FROM ${tablesFor(residentId).trash}
    WHERE notification_id = $1
      AND resident_id = $2
    LIMIT 1
    `,
    [notificationId, residentId]
  );

  return result.rows[0] || null;
}

async function createTrashNotification(notificationId, residentId) {
  const table = tablesFor(residentId).trash;
  const result = await pool.query(
    `
    INSERT INTO ${table} (
      notification_id,
      resident_id,
      deleted_at
    )
    VALUES ($1, $2, NOW())
    ON CONFLICT (resident_id, notification_id) DO UPDATE
      SET deleted_at = ${table}.deleted_at
    RETURNING *
    `,
    [notificationId, residentId]
  );

  return result.rows[0];
}

async function deleteByNotificationId(notificationId, residentId) {
  const result = await pool.query(
    `
    DELETE FROM ${tablesFor(residentId).trash}
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
    FROM ${tablesFor(residentId).trash}
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

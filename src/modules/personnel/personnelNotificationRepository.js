const { pool } = require('../../config/db');

/**
 * Personnel notification store.
 *
 * Extends the established per-role pattern (notifications for residents,
 * admin_notifications for administrators) to the personnel role rather than
 * starting a parallel system, so the same in-app list and unread mechanics
 * apply.
 */

const asQueryable = (queryable) => queryable || pool;

async function create(
  {
    personnelId,
    assignmentId = null,
    reportId = null,
    title,
    message,
    type,
  },
  queryable
) {
  const result = await asQueryable(queryable).query(
    `
    INSERT INTO personnel_notifications (
      personnel_id,
      assignment_id,
      report_id,
      title,
      message,
      type
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING notification_id, personnel_id, assignment_id, report_id, title, message, type, is_read, created_at
    `,
    [
      String(personnelId).toUpperCase(),
      assignmentId,
      reportId,
      title,
      message,
      type,
    ]
  );

  return result.rows[0] || null;
}

async function listForPersonnel(
  personnelId,
  { limit = 50, offset = 0 } = {},
  queryable
) {
  const result = await asQueryable(queryable).query(
    `
    SELECT notification_id, personnel_id, assignment_id, report_id, title, message, type, is_read, created_at
    FROM personnel_notifications
    WHERE personnel_id = $1
    ORDER BY created_at DESC, notification_id DESC
    LIMIT $2 OFFSET $3
    `,
    [String(personnelId).toUpperCase(), limit, offset]
  );

  return result.rows;
}

async function unreadCount(personnelId, queryable) {
  const result = await asQueryable(queryable).query(
    `
    SELECT COUNT(*)::int AS total
    FROM personnel_notifications
    WHERE personnel_id = $1
      AND is_read = FALSE
    `,
    [String(personnelId).toUpperCase()]
  );

  return Number(result.rows[0]?.total || 0);
}

async function markAsRead(personnelId, notificationId, queryable) {
  const result = await asQueryable(queryable).query(
    `
    UPDATE personnel_notifications
       SET is_read = TRUE
     WHERE personnel_id = $1
       AND notification_id = $2
    RETURNING notification_id
    `,
    [String(personnelId).toUpperCase(), notificationId]
  );

  return result.rows[0] || null;
}

async function markAllAsRead(personnelId, queryable) {
  const result = await asQueryable(queryable).query(
    `
    UPDATE personnel_notifications
       SET is_read = TRUE
     WHERE personnel_id = $1
       AND is_read = FALSE
    RETURNING notification_id
    `,
    [String(personnelId).toUpperCase()]
  );

  return result.rowCount || 0;
}

async function findFcmToken(personnelId, queryable) {
  const result = await asQueryable(queryable).query(
    `SELECT fcm_token FROM personnel_accounts WHERE personnel_id = $1 LIMIT 1`,
    [String(personnelId).toUpperCase()]
  );

  return result.rows[0]?.fcm_token || null;
}

async function claimFcmToken(personnelId, token, queryable) {
  const result = await asQueryable(queryable).query(
    `
    UPDATE personnel_accounts
       SET fcm_token = $2,
           updated_at = NOW()
     WHERE personnel_id = $1
    RETURNING personnel_id
    `,
    [String(personnelId).toUpperCase(), token]
  );

  return result.rows[0] || null;
}

async function clearFcmToken(personnelId, token = null, queryable) {
  const values = [String(personnelId).toUpperCase()];
  let tokenClause = '';
  if (token) {
    values.push(token);
    tokenClause = `AND fcm_token = $${values.length}`;
  }

  const result = await asQueryable(queryable).query(
    `
    UPDATE personnel_accounts
       SET fcm_token = NULL,
           updated_at = NOW()
     WHERE personnel_id = $1
       ${tokenClause}
    RETURNING personnel_id
    `,
    values
  );

  return result.rowCount || 0;
}

module.exports = {
  create,
  listForPersonnel,
  unreadCount,
  markAsRead,
  markAllAsRead,
  findFcmToken,
  claimFcmToken,
  clearFcmToken,
};

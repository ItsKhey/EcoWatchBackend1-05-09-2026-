const { pool } = require('../config/db');

async function findAll() {
  const result = await pool.query(`
    SELECT *
    FROM report_histories
    ORDER BY timestamp DESC
  `);

  return result.rows;
}

async function findByReportId(reportId) {
  const result = await pool.query(
    `
    SELECT *
    FROM report_histories
    WHERE report_id = $1
    ORDER BY timestamp DESC
    `,
    [reportId]
  );

  return result.rows;
}

async function findByResidentId(residentId) {
  const result = await pool.query(
    `
    SELECT *
    FROM report_histories
    WHERE resident_id = $1
    ORDER BY timestamp DESC
    `,
    [residentId]
  );

  return result.rows;
}

async function createHistory({
  residentId,
  reportId,
  action,
  oldStatus = null,
  newStatus = null,
  description = '',
  isDeleted = false,
  deletedAt = null,
  timestamp = null,
}, queryable = pool) {
  const result = await queryable.query(
    `
    INSERT INTO report_histories (
      resident_id,
      report_id,
      action,
      old_status,
      new_status,
      description,
      is_deleted,
      deleted_at,
      timestamp
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, COALESCE($9, NOW())
    )
    RETURNING *
    `,
    [
      residentId,
      reportId,
      action,
      oldStatus,
      newStatus,
      description,
      isDeleted,
      deletedAt,
      timestamp,
    ]
  );

  return result.rows[0];
}

async function softDelete(historyId) {
  const result = await pool.query(
    `
    UPDATE report_histories
    SET
      is_deleted = true,
      deleted_at = NOW(),
      updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [historyId]
  );

  return result.rows[0] || null;
}

async function restore(historyId) {
  const result = await pool.query(
    `
    UPDATE report_histories
    SET
      is_deleted = false,
      deleted_at = NULL,
      updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [historyId]
  );

  return result.rows[0] || null;
}

async function softDeleteForResident(historyId, residentId) {
  const result = await pool.query(
    `
    UPDATE report_histories
    SET
      is_deleted = true,
      deleted_at = NOW(),
      updated_at = NOW()
    WHERE id = $1
      AND resident_id = $2
    RETURNING *
    `,
    [historyId, residentId]
  );

  return result.rows[0] || null;
}

async function restoreForResident(historyId, residentId) {
  const result = await pool.query(
    `
    UPDATE report_histories
    SET
      is_deleted = false,
      deleted_at = NULL,
      updated_at = NOW()
    WHERE id = $1
      AND resident_id = $2
    RETURNING *
    `,
    [historyId, residentId]
  );

  return result.rows[0] || null;
}

async function deleteByIdForResident(historyId, residentId) {
  const result = await pool.query(
    `
    DELETE FROM report_histories
    WHERE id = $1
      AND resident_id = $2
    RETURNING *
    `,
    [historyId, residentId]
  );

  return result.rows[0] || null;
}

module.exports = {
  findAll,
  findByReportId,
  findByResidentId,
  createHistory,
  softDelete,
  restore,
  softDeleteForResident,
  restoreForResident,
  deleteByIdForResident,
};

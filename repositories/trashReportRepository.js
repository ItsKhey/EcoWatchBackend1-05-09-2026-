const { pool } = require('../config/db');

async function findByReportId(reportId) {
  const result = await pool.query(
    `
    SELECT *
    FROM trash_reports
    WHERE report_id = $1
    LIMIT 1
    `,
    [reportId]
  );

  return result.rows[0] || null;
}

async function findByResidentId(residentId) {
  const result = await pool.query(
    `
    SELECT
      tr.id,
      tr.report_id,
      tr.resident_id,
      tr.deleted_at,
      tr.created_at,
      r.title,
      r.category,
      r.description,
      r.latitude,
      r.longitude,
      r.image_url,
      r.status,
      r.admin_response,
      r.assigned_personnel_ids,
      r.assigned_personnel_id,
      r.assigned_by_admin_id,
      r.assigned_at,
      r.priority,
      r.is_deleted,
      r.is_archived,
      r.is_restored,
      r.created_at AS report_created_at,
      r.updated_at AS report_updated_at,
      r.handled_by_id,
      r.resolution_image_url,
      r.resolved_at
    FROM trash_reports tr
    INNER JOIN reports r
      ON r.report_id = tr.report_id
    WHERE tr.resident_id = $1
    ORDER BY tr.created_at DESC
    `,
    [residentId]
  );

  return result.rows;
}

async function createTrashRecord({
  reportId,
  residentId,
  deletedAt = null,
}) {
  const result = await pool.query(
    `
    INSERT INTO trash_reports (
      report_id,
      resident_id,
      deleted_at
    )
    VALUES (
      $1, $2, COALESCE($3, NOW())
    )
    RETURNING *
    `,
    [
      reportId,
      residentId,
      deletedAt,
    ]
  );

  return result.rows[0];
}

async function deleteByReportId(reportId) {
  const result = await pool.query(
    `
    DELETE FROM trash_reports
    WHERE report_id = $1
    RETURNING *
    `,
    [reportId]
  );

  return result.rows[0] || null;
}

async function deleteExpired(expirationDate) {
  const result = await pool.query(
    `
    DELETE FROM trash_reports
    WHERE deleted_at < $1
    RETURNING *
    `,
    [expirationDate]
  );

  return result.rows;
}

module.exports = {
  findByReportId,
  findByResidentId,
  createTrashRecord,
  deleteByReportId,
  deleteExpired,
};

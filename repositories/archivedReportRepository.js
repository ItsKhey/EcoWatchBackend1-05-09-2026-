const { pool } = require('../config/db');

async function findByReportId(reportId) {
  const result = await pool.query(
    `
    SELECT *
    FROM archived_reports
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
    SELECT *
    FROM archived_reports
    WHERE resident_id = $1
    ORDER BY created_at DESC
    `,
    [residentId]
  );

  return result.rows;
}

async function createArchivedReport({
  reportId,
  residentId,
  title,
  category,
  description,
  latitude = null,
  longitude = null,
  imageUrl = null,
  status = 'Pending',
  adminResponse = '',
  assignedPersonnelIds = [],
  assignedPersonnelId = null,
  assignedByAdminId = null,
  assignedAt = null,
  priority = 'Normal',
  deletedAt = null,
  restoredAt = null,
}) {
  const result = await pool.query(
    `
    INSERT INTO archived_reports (
      report_id,
      resident_id,
      title,
      category,
      description,
      latitude,
      longitude,
      image_url,
      status,
      admin_response,
      assigned_personnel_ids,
      assigned_personnel_id,
      assigned_by_admin_id,
      assigned_at,
      priority,
      deleted_at,
      restored_at
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15,
      $16, $17
    )
    RETURNING *
    `,
    [
      reportId,
      residentId,
      title,
      category,
      description,
      latitude,
      longitude,
      imageUrl,
      status,
      adminResponse,
      assignedPersonnelIds,
      assignedPersonnelId,
      assignedByAdminId,
      assignedAt,
      priority,
      deletedAt,
      restoredAt,
    ]
  );

  return result.rows[0];
}

async function deleteByReportId(reportId) {
  const result = await pool.query(
    `
    DELETE FROM archived_reports
    WHERE report_id = $1
    RETURNING *
    `,
    [reportId]
  );

  return result.rows[0] || null;
}

module.exports = {
  findByReportId,
  findByResidentId,
  createArchivedReport,
  deleteByReportId,
};

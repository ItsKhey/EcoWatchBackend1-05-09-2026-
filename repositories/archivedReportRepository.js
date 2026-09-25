const { pool } = require('../config/db');

async function findByReportId(reportId, queryable = pool) {
  const result = await queryable.query(
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

async function findByReportIdForUpdate(reportId, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT *
    FROM archived_reports
    WHERE report_id = $1
    LIMIT 1
    FOR UPDATE
    `,
    [reportId]
  );

  return result.rows[0] || null;
}

async function findByResidentId(residentId, queryable = pool) {
  const result = await queryable.query(
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

async function createArchivedReport(
  {
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
  },
  queryable = pool
) {
  const result = await queryable.query(
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

async function updateByReportId(reportId, updates, queryable = pool) {
  const allowedFields = {
    status: 'status',
    adminResponse: 'admin_response',
    assignedPersonnelIds: 'assigned_personnel_ids',
    assignedPersonnelId: 'assigned_personnel_id',
    assignedByAdminId: 'assigned_by_admin_id',
    assignedAt: 'assigned_at',
    priority: 'priority',
    deletedAt: 'deleted_at',
    restoredAt: 'restored_at',
  };
  const setParts = [];
  const values = [];

  for (const [field, value] of Object.entries(updates)) {
    const column = allowedFields[field];
    if (!column) continue;
    values.push(value);
    setParts.push(`${column} = $${values.length}`);
  }

  if (setParts.length === 0) {
    return findByReportId(reportId, queryable);
  }

  setParts.push('updated_at = NOW()');
  values.push(reportId);
  const result = await queryable.query(
    `
    UPDATE archived_reports
    SET ${setParts.join(', ')}
    WHERE report_id = $${values.length}
    RETURNING *
    `,
    values
  );

  return result.rows[0] || null;
}

async function deleteByReportId(reportId, queryable = pool) {
  const result = await queryable.query(
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
  findByReportIdForUpdate,
  findByResidentId,
  createArchivedReport,
  updateByReportId,
  deleteByReportId,
};

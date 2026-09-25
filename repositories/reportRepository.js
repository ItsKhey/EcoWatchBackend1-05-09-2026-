const { pool } = require('../config/db');

async function findAll() {
  const result = await pool.query(`
    SELECT *
    FROM reports
    ORDER BY created_at DESC
  `);

  return result.rows;
}

async function findByReportId(reportId) {
  const result = await pool.query(
    `
    SELECT *
    FROM reports
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
    FROM reports
    WHERE resident_id = $1
    ORDER BY created_at DESC
    `,
    [residentId]
  );

  return result.rows;
}

async function findActiveByResidentId(residentId) {
  const result = await pool.query(
    `
    SELECT *
    FROM reports
    WHERE resident_id = $1
      AND is_deleted = false
      AND is_archived = false
    ORDER BY created_at DESC
    `,
    [residentId]
  );

  return result.rows;
}

async function createReport({
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
  priority = 'Normal',
  isDeleted = false,
  deletedAt = null,
  isArchived = false,
  isRestored = false,
  handledById = null,
  resolutionImageUrl = null,
  resolvedAt = null,
}) {
  const result = await pool.query(
    `
    INSERT INTO reports (
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
      priority,
      is_deleted,
      deleted_at,
      is_archived,
      is_restored,
      handled_by_id,
      resolution_image_url,
      resolved_at
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15,
      $16, $17, $18, $19
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
      priority,
      isDeleted,
      deletedAt,
      isArchived,
      isRestored,
      handledById,
      resolutionImageUrl,
      resolvedAt,
    ]
  );

  return result.rows[0];
}

async function updateReport(reportId, updates, queryable = pool) {
  const allowedFields = {
    title: 'title',
    category: 'category',
    description: 'description',
    latitude: 'latitude',
    longitude: 'longitude',
    imageUrl: 'image_url',
    status: 'status',
    adminResponse: 'admin_response',
    assignedPersonnelIds: 'assigned_personnel_ids',
    priority: 'priority',
    isDeleted: 'is_deleted',
    deletedAt: 'deleted_at',
    isArchived: 'is_archived',
    isRestored: 'is_restored',
    handledById: 'handled_by_id',
    resolutionImageUrl: 'resolution_image_url',
    resolvedAt: 'resolved_at',
  };

  const setParts = [];
  const values = [];
  let parameterIndex = 1;

  for (const [field, value] of Object.entries(updates)) {
    const column = allowedFields[field];

    if (!column) continue;

    setParts.push(`${column} = $${parameterIndex}`);
    values.push(value);
    parameterIndex++;
  }

  if (setParts.length === 0) {
    return findByReportId(reportId);
  }

  setParts.push(`updated_at = NOW()`);

  values.push(reportId);

  const result = await queryable.query(
    `
    UPDATE reports
    SET ${setParts.join(', ')}
    WHERE report_id = $${parameterIndex}
    RETURNING *
    `,
    values
  );

  return result.rows[0] || null;
}

async function softDelete(reportId) {
  const result = await pool.query(
    `
    UPDATE reports
    SET
      is_deleted = true,
      deleted_at = NOW(),
      updated_at = NOW()
    WHERE report_id = $1
    RETURNING *
    `,
    [reportId]
  );

  return result.rows[0] || null;
}

async function restoreReport(reportId) {
  const result = await pool.query(
    `
    UPDATE reports
    SET
      is_deleted = false,
      deleted_at = NULL,
      is_restored = true,
      updated_at = NOW()
    WHERE report_id = $1
    RETURNING *
    `,
    [reportId]
  );

  return result.rows[0] || null;
}

async function deleteByReportId(reportId) {
  const result = await pool.query(
    `
    DELETE FROM reports
    WHERE report_id = $1
    RETURNING *
    `,
    [reportId]
  );

  return result.rows[0] || null;
}

module.exports = {
  findAll,
  findByReportId,
  findByResidentId,
  findActiveByResidentId,
  createReport,
  updateReport,
  softDelete,
  restoreReport,
  deleteByReportId,
};

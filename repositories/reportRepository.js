const { pool } = require('../config/db');

async function findAll(queryable = pool) {
  const result = await queryable.query(`
    SELECT
      r.*,
      p.first_name AS assigned_personnel_first_name,
      p.last_name AS assigned_personnel_last_name,
      p.username AS assigned_personnel_username,
      p.email AS assigned_personnel_email,
      p.profile_image AS assigned_personnel_profile_image,
      p.status AS assigned_personnel_status,
      p.enabled AS assigned_personnel_enabled,
      p.deleted_at AS assigned_personnel_deleted_at,
      p.current_assignment_location AS assigned_personnel_location,
      p.current_assignment_assigned_at AS personnel_assignment_assigned_at
    FROM reports r
    LEFT JOIN personnel_accounts p
      ON p.personnel_id = r.assigned_personnel_id
    ORDER BY r.created_at DESC
  `);

  return result.rows;
}

/**
 * Returns the authoritative admin view across the active, archive, and trash
 * tables. The active row wins when a legacy dataset temporarily contains a
 * report in more than one collection; the trash marker is also honored so a
 * stale is_deleted flag cannot make a trashed report appear active.
 */
async function findAllForAdmin(options = {}, queryable = pool) {
  const values = [];
  const conditions = [];
  const view = String(options.view || 'all').trim().toLowerCase();

  if (view === 'active' || view === 'inbox') {
    conditions.push('d.is_deleted = false AND d.is_archived = false');
  } else if (view === 'archive' || view === 'archived') {
    conditions.push('d.is_archived = true AND d.is_deleted = false');
  } else if (view === 'trash' || view === 'trashed') {
    conditions.push('d.is_deleted = true');
  } else if (view !== 'all') {
    const error = new Error('Invalid report view. Use all, active, archive, or trash.');
    error.statusCode = 400;
    throw error;
  }

  if (options.search) {
    values.push(`%${String(options.search).trim()}%`);
    const searchParameter = `$${values.length}`;
    conditions.push(`(
      d.report_id ILIKE ${searchParameter}
      OR d.resident_id ILIKE ${searchParameter}
      OR d.title ILIKE ${searchParameter}
      OR d.category ILIKE ${searchParameter}
      OR d.status ILIKE ${searchParameter}
      OR concat_ws(' ', d.title, d.description, d.report_id) ILIKE ${searchParameter}
    )`);
  }

  let pagination = '';
  if (Number.isInteger(options.limit) && options.limit > 0) {
    values.push(options.limit);
    const limitParameter = `$${values.length}`;
    values.push(Math.max(0, Number(options.offset) || 0));
    const offsetParameter = `$${values.length}`;
    pagination = `LIMIT ${limitParameter} OFFSET ${offsetParameter}`;
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  const result = await queryable.query(
    `
    ${ADMIN_REPORT_UNION}
    SELECT
      d.*,
      p.first_name AS assigned_personnel_first_name,
      p.last_name AS assigned_personnel_last_name,
      p.username AS assigned_personnel_username,
      p.email AS assigned_personnel_email,
      p.profile_image AS assigned_personnel_profile_image,
      p.status AS assigned_personnel_status,
      p.enabled AS assigned_personnel_enabled,
      p.deleted_at AS assigned_personnel_deleted_at,
      p.current_assignment_location AS assigned_personnel_location,
      p.current_assignment_assigned_at AS personnel_assignment_assigned_at
    FROM deduplicated_reports d
    LEFT JOIN personnel_accounts p
      ON p.personnel_id = d.assigned_personnel_id
    ${whereClause}
    ORDER BY d.created_at DESC NULLS LAST, d.report_id DESC
    ${pagination}
    `,
    values
  );

  return result.rows;
}

async function findByReportId(reportId, queryable = pool) {
  const result = await queryable.query(
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

/**
 * Loads the report row under a row lock. Assignment mutations must use this
 * method rather than a preflight read so two administrators cannot overwrite
 * one another between validation and commit.
 */
async function findByReportIdForUpdate(reportId, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT *
    FROM reports
    WHERE report_id = $1
    LIMIT 1
    FOR UPDATE
    `,
    [reportId]
  );

  return result.rows[0] || null;
}

async function findAssignmentByReportId(reportId, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT
      r.*,
      p.first_name AS assigned_personnel_first_name,
      p.last_name AS assigned_personnel_last_name,
      p.username AS assigned_personnel_username,
      p.email AS assigned_personnel_email,
      p.profile_image AS assigned_personnel_profile_image,
      p.status AS assigned_personnel_status,
      p.enabled AS assigned_personnel_enabled,
      p.deleted_at AS assigned_personnel_deleted_at,
      p.current_assignment_location AS assigned_personnel_location,
      p.current_assignment_assigned_at AS personnel_assignment_assigned_at
    FROM reports r
    LEFT JOIN personnel_accounts p
      ON p.personnel_id = r.assigned_personnel_id
    WHERE r.report_id = $1
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

const ADMIN_REPORT_UNION = `
  WITH report_rows AS (
    SELECT
      r.report_id,
      r.resident_id,
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
      (COALESCE(r.is_deleted, false) OR EXISTS (
        SELECT 1
        FROM trash_reports trash_marker
        WHERE trash_marker.report_id = r.report_id
      )) AS is_deleted,
      COALESCE(
        r.deleted_at,
        (
          SELECT trash_marker.deleted_at
          FROM trash_reports trash_marker
          WHERE trash_marker.report_id = r.report_id
          LIMIT 1
        )
      ) AS deleted_at,
      COALESCE(r.is_archived, false) AS is_archived,
      COALESCE(r.is_restored, false) AS is_restored,
      r.created_at,
      r.updated_at,
      r.handled_by_id,
      r.resolution_image_url,
      r.resolved_at,
      'reports'::text AS source_collection,
      0 AS source_priority
    FROM reports r

    UNION ALL

    SELECT
      a.report_id,
      a.resident_id,
      a.title,
      a.category,
      a.description,
      a.latitude,
      a.longitude,
      a.image_url,
      a.status,
      a.admin_response,
      a.assigned_personnel_ids,
      a.assigned_personnel_id,
      a.assigned_by_admin_id,
      a.assigned_at,
      a.priority,
      (a.deleted_at IS NOT NULL) AS is_deleted,
      a.deleted_at,
      TRUE AS is_archived,
      (a.restored_at IS NOT NULL) AS is_restored,
      a.created_at,
      a.updated_at,
      NULL::varchar AS handled_by_id,
      NULL::text AS resolution_image_url,
      NULL::timestamptz AS resolved_at,
      'archived_reports'::text AS source_collection,
      1 AS source_priority
    FROM archived_reports a
  ), deduplicated_reports AS (
    SELECT DISTINCT ON (report_id)
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
      is_deleted,
      deleted_at,
      is_archived,
      is_restored,
      created_at,
      updated_at,
      handled_by_id,
      resolution_image_url,
      resolved_at,
      source_collection
    FROM report_rows
    ORDER BY report_id, source_priority
  )
`;

const RESIDENT_REPORT_UNION = `
  WITH resident_report_rows AS (
    SELECT
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
      (COALESCE(is_deleted, false) OR EXISTS (
        SELECT 1
        FROM trash_reports trash_marker
        WHERE trash_marker.report_id = reports.report_id
      )) AS is_deleted,
      COALESCE(
        deleted_at,
        (
          SELECT trash_marker.deleted_at
          FROM trash_reports trash_marker
          WHERE trash_marker.report_id = reports.report_id
          LIMIT 1
        )
      ) AS deleted_at,
      is_archived,
      is_restored,
      created_at,
      updated_at,
      handled_by_id,
      resolution_image_url,
      resolved_at,
      0 AS source_priority
    FROM reports
    WHERE resident_id = $1

    UNION ALL

    SELECT
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
      (deleted_at IS NOT NULL) AS is_deleted,
      deleted_at,
      TRUE AS is_archived,
      FALSE AS is_restored,
      created_at,
      updated_at,
      NULL::varchar AS handled_by_id,
      NULL::text AS resolution_image_url,
      NULL::timestamptz AS resolved_at,
      1 AS source_priority
    FROM archived_reports
    WHERE resident_id = $1
  ), deduplicated_reports AS (
    SELECT DISTINCT ON (report_id)
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
      is_deleted,
      deleted_at,
      is_archived,
      is_restored,
      created_at,
      updated_at,
      handled_by_id,
      resolution_image_url,
      resolved_at
    FROM resident_report_rows
    ORDER BY report_id, source_priority
  )
`;

/**
 * Returns every report submitted by one resident, including reports that have
 * been archived or moved to trash.  The active row wins if a legacy data set
 * temporarily contains the same report in both tables.
 */
async function findAllForResident(residentId, queryable = pool) {
  const result = await queryable.query(
    `
    ${RESIDENT_REPORT_UNION}
    SELECT
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
      is_deleted,
      deleted_at,
      is_archived,
      is_restored,
      created_at,
      updated_at,
      handled_by_id,
      resolution_image_url,
      resolved_at
    FROM deduplicated_reports
    ORDER BY created_at DESC NULLS LAST, report_id DESC
    `,
    [residentId]
  );

  return result.rows;
}

async function findPageForResident(
  residentId,
  { limit = 50, offset = 0 } = {},
  queryable = pool
) {
  const [rowsResult, countResult] = await Promise.all([
    queryable.query(
      `
      ${RESIDENT_REPORT_UNION}
      SELECT
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
        is_deleted,
        deleted_at,
        is_archived,
        is_restored,
        created_at,
        updated_at,
        handled_by_id,
        resolution_image_url,
        resolved_at
      FROM deduplicated_reports
      ORDER BY created_at DESC NULLS LAST, report_id DESC
      LIMIT $2 OFFSET $3
      `,
      [residentId, limit, offset]
    ),
    queryable.query(
      `
      ${RESIDENT_REPORT_UNION}
      SELECT COUNT(*)::int AS total
      FROM deduplicated_reports
      `,
      [residentId]
    ),
  ]);

  return {
    reports: rowsResult.rows,
    total: Number(countResult.rows[0]?.total || 0),
  };
}

/**
 * Returns server-owned report aggregates for one resident.  Status matching is
 * case-insensitive and tolerant of the snake/space variants used by older
 * clients.  Counts are intentionally calculated in PostgreSQL rather than in
 * the Android client, and use the same union as the history endpoint.
 */
async function getReportCountsByResidentId(residentId, queryable = pool) {
  const result = await queryable.query(
    `
    ${RESIDENT_REPORT_UNION}
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE lower(trim(status)) IN ('pending', 'submitted')
      )::int AS pending,
      COUNT(*) FILTER (
        WHERE lower(trim(status)) IN ('in progress', 'in_progress', 'in-progress')
      )::int AS in_progress,
      COUNT(*) FILTER (
        WHERE lower(trim(status)) = 'completed'
      )::int AS completed,
      COUNT(*) FILTER (
        WHERE lower(trim(status)) = 'denied'
      )::int AS denied
    FROM deduplicated_reports
    `,
    [residentId]
  );

  return result.rows[0] || {
    total: 0,
    pending: 0,
    in_progress: 0,
    completed: 0,
    denied: 0,
  };
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
  assignedPersonnelId = null,
  assignedByAdminId = null,
  assignedAt = null,
  priority = 'Normal',
  isDeleted = false,
  deletedAt = null,
  isArchived = false,
  isRestored = false,
  handledById = null,
  resolutionImageUrl = null,
  resolvedAt = null,
}, queryable = pool) {
  const result = await queryable.query(
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
      assigned_personnel_id,
      assigned_by_admin_id,
      assigned_at,
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
      $16, $17, $18, $19,
      $20, $21, $22
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
    assignedPersonnelId: 'assigned_personnel_id',
    assignedByAdminId: 'assigned_by_admin_id',
    assignedAt: 'assigned_at',
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
    return findByReportId(reportId, queryable);
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
  findAllForAdmin,
  findByReportId,
  findByReportIdForUpdate,
  findAssignmentByReportId,
  findByResidentId,
  findActiveByResidentId,
  findAllForResident,
  findPageForResident,
  getReportCountsByResidentId,
  createReport,
  updateReport,
  softDelete,
  restoreReport,
  deleteByReportId,
};

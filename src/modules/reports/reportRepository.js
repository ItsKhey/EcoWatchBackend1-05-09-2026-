const { pool } = require('../../config/db');
const { destroyImage } = require('../../shared/cloudinaryService');

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
      p.current_assignment_assigned_at AS personnel_assignment_assigned_at,
      t.team_name AS assigned_team_name,
      v.plate_number AS assigned_vehicle_plate_number,
      v.vehicle_type AS assigned_vehicle_type,
      ${ADMIN_REPORT_RESIDENT_FIELDS}
    FROM deduplicated_reports d
    LEFT JOIN personnel_accounts p
      ON p.personnel_id = d.assigned_personnel_id
    LEFT JOIN residents res
      ON res.resident_id = d.resident_id
    LEFT JOIN cleaning_teams t
      ON t.team_id = d.assigned_team_id
    LEFT JOIN vehicles v
      ON v.vehicle_id = d.assigned_vehicle_id
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
 * Every live report belonging to one cluster, newest first.
 *
 * This exists because "the reports in this cluster" is a relationship, not a
 * search term. The cluster detail screen used to ask findAllForAdmin for
 * `search: clusterId`, which matched the cluster ID against report text fields
 * and therefore returned nothing: no report title or description contains
 * "CL-123456". Matching on cluster_id is the only way to answer the question.
 *
 * Deleted and archived reports are excluded so the list matches the count
 * reported as the cluster's spotCount, which counts the same set.
 */
async function findByClusterIdForAdmin(clusterId, queryable = pool) {
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
      p.current_assignment_assigned_at AS personnel_assignment_assigned_at,
      ${ADMIN_REPORT_RESIDENT_FIELDS}
    FROM deduplicated_reports d
    LEFT JOIN personnel_accounts p
      ON p.personnel_id = d.assigned_personnel_id
    LEFT JOIN residents res
      ON res.resident_id = d.resident_id
    WHERE d.cluster_id = $1
      AND d.is_deleted = false
      AND d.is_archived = false
    ORDER BY d.created_at DESC NULLS LAST, d.report_id DESC
    `,
    [clusterId]
  );

  return result.rows;
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

/**
 * Who filed a report, joined onto the admin report feed.
 *
 * A report row only stores resident_id, so without this the admin app could
 * show an ID and nothing else: the cluster detail screen could not name the
 * resident behind each report. Joining here means the name arrives with the
 * report the screen already has, rather than costing one extra request per
 * report to look it up afterwards.
 *
 * NULL when the resident row is gone (account deleted) or the report predates
 * the residents table. Callers must render a fallback rather than assume it is
 * present.
 */
const ADMIN_REPORT_RESIDENT_FIELDS = `
      NULLIF(TRIM(COALESCE(res.first_name, '') || ' ' || COALESCE(res.last_name, '')), '')
        AS resident_name,
      res.username AS resident_username,
      res.email AS resident_email,
      res.profile_image AS resident_profile_image
`;

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
      r.cluster_id,
      r.status,
      r.admin_response,
      r.personnel_note,
      r.assigned_personnel_ids,
      r.assigned_personnel_id,
      r.assigned_by_admin_id,
      r.assigned_at,
      r.priority,
      r.waste_scale,
      r.assigned_team_id,
      r.assigned_vehicle_id,
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
      a.cluster_id,
      a.status,
      a.admin_response,
      a.personnel_note,
      a.assigned_personnel_ids,
      a.assigned_personnel_id,
      a.assigned_by_admin_id,
      a.assigned_at,
      a.priority,
      a.waste_scale,
      a.assigned_team_id,
      a.assigned_vehicle_id,
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
      cluster_id,
      status,
      admin_response,
      personnel_note,
      assigned_personnel_ids,
      assigned_personnel_id,
      assigned_by_admin_id,
      assigned_at,
      priority,
      waste_scale,
      assigned_team_id,
      assigned_vehicle_id,
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
      cluster_id,
      status,
      admin_response,
      assigned_personnel_ids,
      assigned_personnel_id,
      assigned_by_admin_id,
      assigned_at,
      priority,
      waste_scale,
      assigned_team_id,
      assigned_vehicle_id,
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
      cluster_id,
      status,
      admin_response,
      assigned_personnel_ids,
      assigned_personnel_id,
      assigned_by_admin_id,
      assigned_at,
      priority,
      waste_scale,
      assigned_team_id,
      assigned_vehicle_id,
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
      cluster_id,
      status,
      admin_response,
      assigned_personnel_ids,
      assigned_personnel_id,
      assigned_by_admin_id,
      assigned_at,
      priority,
      waste_scale,
      assigned_team_id,
      assigned_vehicle_id,
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
      waste_scale,
      assigned_team_id,
      assigned_vehicle_id,
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
        waste_scale,
        assigned_team_id,
        assigned_vehicle_id,
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

/**
 * Same shape as RESIDENT_REPORT_UNION but scoped to reports a personnel member
 * is or has been assigned to. Assignment rows preserve this link after work is
 * completed and the live report assignment is released.
 *
 * A report counts as assigned when the legacy single-assignee column matches or
 * when the ID appears anywhere in the text[] of assignees. Both are kept because
 * 006-report-assignments.sql backfills assigned_personnel_id from the array but
 * later multi-personnel assignments only append to the array.
 */
const PERSONNEL_REPORT_UNION = `
  WITH personnel_report_rows AS (
    SELECT
      report_id,
      resident_id,
      title,
      category,
      description,
      latitude,
      longitude,
      image_url,
      cluster_id,
      status,
      admin_response,
      personnel_note,
      assigned_personnel_ids,
      assigned_personnel_id,
      assigned_by_admin_id,
      assigned_at,
      priority,
      waste_scale,
      assigned_team_id,
      assigned_vehicle_id,
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
    WHERE assigned_personnel_id = $1
       OR $1 = ANY(assigned_personnel_ids)
       OR EXISTS (
         SELECT 1
         FROM personnel_assignments pa
         WHERE pa.report_id = reports.report_id
           AND pa.personnel_id = $1
       )

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
      cluster_id,
      status,
      admin_response,
      personnel_note,
      assigned_personnel_ids,
      assigned_personnel_id,
      assigned_by_admin_id,
      assigned_at,
      priority,
      waste_scale,
      assigned_team_id,
      assigned_vehicle_id,
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
    WHERE assigned_personnel_id = $1
       OR $1 = ANY(assigned_personnel_ids)
       OR EXISTS (
         SELECT 1
         FROM personnel_assignments pa
         WHERE pa.report_id = archived_reports.report_id
           AND pa.personnel_id = $1
       )
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
      cluster_id,
      status,
      admin_response,
      personnel_note,
      assigned_personnel_ids,
      assigned_personnel_id,
      assigned_by_admin_id,
      assigned_at,
      priority,
      waste_scale,
      assigned_team_id,
      assigned_vehicle_id,
      is_deleted,
      deleted_at,
      is_archived,
      is_restored,
      created_at,
      updated_at,
      handled_by_id,
      resolution_image_url,
      resolved_at
    FROM personnel_report_rows
    ORDER BY report_id, source_priority
  )
`;

async function findPageForPersonnel(
  personnelId,
  { limit = 50, offset = 0 } = {},
  queryable = pool
) {
  const [rowsResult, countResult] = await Promise.all([
    queryable.query(
      `
      ${PERSONNEL_REPORT_UNION}
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
        personnel_note,
        assigned_personnel_ids,
        assigned_personnel_id,
        assigned_by_admin_id,
        assigned_at,
        priority,
        waste_scale,
        assigned_team_id,
        assigned_vehicle_id,
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
      [personnelId, limit, offset]
    ),
    queryable.query(
      `
      ${PERSONNEL_REPORT_UNION}
      SELECT COUNT(*)::int AS total
      FROM deduplicated_reports
      `,
      [personnelId]
    ),
  ]);

  return {
    reports: rowsResult.rows,
    total: Number(countResult.rows[0]?.total || 0),
  };
}

/**
 * Report aggregates for the tasks assigned to one personnel member. Mirrors
 * getReportCountsByResidentId so both detail screens render the same stat
 * cards, and reuses the same status normalisation for the same reasons.
 */
async function getReportCountsByPersonnelId(personnelId, queryable = pool) {
  const result = await queryable.query(
    `
    ${PERSONNEL_REPORT_UNION}
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
    [personnelId]
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
  clusterId = null,
  status = 'Pending',
  adminResponse = '',
  personnelResponse = null,
  assignedPersonnelIds = [],
  assignedPersonnelId = null,
  assignedByAdminId = null,
  assignedAt = null,
  priority = 'Normal',
  wasteScale = null,
  assignedTeamId = null,
  assignedVehicleId = null,
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
      cluster_id,
      status,
      admin_response,
      personnel_note,
      assigned_personnel_ids,
      assigned_personnel_id,
      assigned_by_admin_id,
      assigned_at,
      priority,
      waste_scale,
      assigned_team_id,
      assigned_vehicle_id,
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
      $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25,
      $26, $27
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
      clusterId,
      status,
      adminResponse,
      personnelResponse,
      assignedPersonnelIds,
      assignedPersonnelId,
      assignedByAdminId,
      assignedAt,
      priority,
      wasteScale,
      assignedTeamId,
      assignedVehicleId,
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
    // Personnel-only channel. Deliberately NOT part of any resident-facing
    // SELECT list in this file: the assignment/revision commands write here so
    // internal instructions never reach reports.admin_response.
    personnelResponse: 'personnel_note',
    assignedPersonnelIds: 'assigned_personnel_ids',
    assignedPersonnelId: 'assigned_personnel_id',
    assignedByAdminId: 'assigned_by_admin_id',
    assignedAt: 'assigned_at',
    priority: 'priority',
    wasteScale: 'waste_scale',
    assignedTeamId: 'assigned_team_id',
    assignedVehicleId: 'assigned_vehicle_id',
    isDeleted: 'is_deleted',
    deletedAt: 'deleted_at',
    isArchived: 'is_archived',
    isRestored: 'is_restored',
    handledById: 'handled_by_id',
    resolutionImageUrl: 'resolution_image_url',
    resolvedAt: 'resolved_at',
    clusterId: 'cluster_id',
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

/**
 * Removes the active report row without releasing its image.
 *
 * <p>Accepts the caller's connection so a lifecycle move can run inside its own
 * transaction. The archive and restore moves lock this row with FOR UPDATE and
 * then delete it, so issuing the DELETE on a separate pooled connection would
 * block on the lock the transaction itself is holding until the statement
 * timeout. Callers outside a transaction can omit `queryable` and get the pool.
 *
 * <p>Lifecycle moves re-create the row elsewhere still referencing the same
 * asset, so this deliberately keeps the photo. A permanent delete wants the
 * opposite and must use {@link permanentlyDeleteByReportId}.
 */
async function deleteByReportId(reportId, queryable = pool) {
  const result = await queryable.query(
    `
    DELETE FROM reports
    WHERE report_id = $1
    RETURNING *
    `,
    [reportId]
  );

  return result.rows[0] || null;
}

/**
 * Resolves the Cloudinary asset a report currently owns.
 *
 * <p>A report lives in exactly one of the two tables: archiving moves the row
 * out of `reports` and re-inserts it into `archived_reports` carrying the same
 * `image_url`, so the owner has to be resolved before any permanent delete or
 * the archived branch would orphan the photo.
 *
 * <p>Trash is only a marker table and keeps the row in `reports`, so it needs no
 * lookup of its own.
 */
async function findOwnedImageUrl(reportId, queryable = pool) {
  const active = await queryable.query(
    `
    SELECT image_url
    FROM reports
    WHERE report_id = $1
    `,
    [reportId]
  );
  if (active.rows[0]) return active.rows[0].image_url || null;

  const archived = await queryable.query(
    `
    SELECT image_url
    FROM archived_reports
    WHERE report_id = $1
    `,
    [reportId]
  );
  return archived.rows[0] ? archived.rows[0].image_url || null : null;
}

/**
 * Releases the Cloudinary asset a report owns.
 *
 * <p>This is the single source of truth for report image cleanup: the resident
 * delete, the bulk delete, the admin trash-bin delete, the archived-report
 * delete, the expiration cleanup job and resident account deletion all funnel
 * through here, so no path can orphan an asset in Cloudinary.
 *
 * <p>It runs before the row is removed so an interruption can only ever leave a
 * report whose photo 404s, never a live Cloudinary file that nothing points at.
 * `destroyImage` resolves even when the asset is already gone and never
 * rejects, and it ignores any URL that is not a Cloudinary delivery URL, so the
 * cleanup is idempotent and a Cloudinary outage can never strand the report row
 * in PostgreSQL.
 */
async function releaseReportImage(reportId, queryable = pool) {
  const imageUrl = await findOwnedImageUrl(reportId, queryable);
  if (!imageUrl) return null;

  return destroyImage(imageUrl);
}

/**
 * Permanently removes the active report row and the asset it owns.
 *
 * <p>Lifecycle moves that delete the active row but immediately re-create it
 * (archive, restore) must keep using {@link deleteByReportId}: the re-created
 * row still references the same asset, so the photo must survive.
 */
async function permanentlyDeleteByReportId(reportId, queryable = pool) {
  await releaseReportImage(reportId, queryable);

  const result = await queryable.query(
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
  findByClusterIdForAdmin,
  findByReportIdForUpdate,
  findAssignmentByReportId,
  findByResidentId,
  findActiveByResidentId,
  findAllForResident,
  findPageForResident,
  getReportCountsByResidentId,
  findPageForPersonnel,
  getReportCountsByPersonnelId,
  createReport,
  updateReport,
  softDelete,
  restoreReport,
  deleteByReportId,
  findOwnedImageUrl,
  releaseReportImage,
  permanentlyDeleteByReportId,
};

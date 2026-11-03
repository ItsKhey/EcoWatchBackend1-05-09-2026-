const { pool } = require('../../config/db');

/**
 * The fleet rows, with the collection they are currently on joined in.
 *
 * <p>A vehicle card has to answer "what is it doing right now", and answering
 * that from the report id alone would make the list screen issue a second round
 * trip per vehicle. The report's own columns come along so the card can show the
 * title and whether the collection is still open.
 */
const VEHICLE_SELECT_FIELDS = `
  v.vehicle_id,
  v.plate_number,
  v.vehicle_type,
  v.rated_load_capacity,
  v.status,
  v.current_report_id,
  v.current_cluster_id,
  v.assigned_at,
  v.last_service_at,
  v.last_activity_at,
  v.notes,
  v.is_deleted,
  v.deleted_at,
  v.created_at,
  v.updated_at,
  r.title AS current_report_title,
  r.category AS current_report_category,
  r.status AS current_report_status,
  r.latitude AS current_report_latitude,
  r.longitude AS current_report_longitude,
  r.cluster_id AS current_report_cluster_id
`;

const VEHICLE_FROM = `
  FROM vehicles v
  LEFT JOIN reports r
    ON r.report_id = v.current_report_id
`;

const toVehicle = (row) => {
  if (!row) return null;

  const report = row.current_report_id
    ? {
      reportId: row.current_report_id,
      title: row.current_report_title || null,
      category: row.current_report_category || null,
      status: row.current_report_status || null,
      latitude: row.current_report_latitude ?? null,
      longitude: row.current_report_longitude ?? null,
      clusterId: row.current_report_cluster_id || null,
    }
    : null;

  return {
    vehicleId: row.vehicle_id,
    plateNumber: row.plate_number,
    vehicleType: row.vehicle_type || '',
    ratedLoadCapacity: row.rated_load_capacity || null,
    status: row.status,
    currentReportId: row.current_report_id || null,
    currentClusterId: row.current_cluster_id || null,
    assignedAt: row.assigned_at || null,
    lastServiceAt: row.last_service_at || null,
    lastActivityAt: row.last_activity_at || null,
    notes: row.notes || null,
    // Surfaced rather than filtered out: assigning a deleted truck to a driver
    // has to be refused with a reason, and a caller holding only this object
    // cannot tell "removed" from "never existed" without it.
    isDeleted: row.is_deleted === true,
    deletedAt: row.deleted_at || null,
    currentReport: report,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
};

/**
 * Lists the fleet, newest activity first.
 *
 * <p>Deleted vehicles are excluded unless asked for, because the Admin screen
 * lists live fleet and a removed vehicle should not reappear on the next pull.
 *
 * @param {object} [options]
 * @param {string|null} [options.status] filter to one status; null for all.
 * @param {boolean} [options.includeDeleted]
 * @param {object} [queryable]
 */
async function findAll(options = {}, queryable = pool) {
  const values = [];
  const conditions = [];

  if (!options.includeDeleted) {
    conditions.push('v.is_deleted = false');
  }
  if (options.status) {
    values.push(options.status);
    conditions.push(`v.status = $${values.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await queryable.query(
    `SELECT ${VEHICLE_SELECT_FIELDS} ${VEHICLE_FROM} ${where}
     ORDER BY v.last_activity_at DESC NULLS LAST, v.vehicle_id ASC`,
    values
  );

  return result.rows.map(toVehicle);
}

/**
 * The fleet in one grouped pass.
 *
 * <p>The summary cards need Total, Available and Assigned, and computing those
 * with three separate COUNT queries meant three round trips and three chances to
 * disagree with each other. One grouped scan cannot: every count comes from the
 * same set of rows at the same instant.
 */
async function findStatusCounts(queryable = pool) {
  const result = await queryable.query(
    `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'Available')::int AS available,
      COUNT(*) FILTER (WHERE status = 'Assigned')::int AS assigned,
      COUNT(*) FILTER (WHERE status = 'Maintenance')::int AS maintenance
    FROM vehicles
    WHERE is_deleted = false
    `
  );

  const row = result.rows[0] || {};
  return {
    total: row.total || 0,
    available: row.available || 0,
    assigned: row.assigned || 0,
    maintenance: row.maintenance || 0,
  };
};

async function findByVehicleId(vehicleId, queryable = pool) {
  const result = await queryable.query(
    `SELECT ${VEHICLE_SELECT_FIELDS} ${VEHICLE_FROM} WHERE v.vehicle_id = $1`,
    [vehicleId]
  );

  return toVehicle(result.rows[0]);
}

/** Assignment-derived work totals for one vehicle across its history. */
async function getTaskCountsByVehicleId(vehicleId, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT
      COUNT(DISTINCT report_id)::int AS total_assigned,
      COUNT(DISTINCT report_id) FILTER (
        WHERE status IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS')
      )::int AS on_hand,
      COUNT(DISTINCT report_id) FILTER (WHERE status = 'IN_PROGRESS')::int AS in_progress,
      COUNT(DISTINCT report_id) FILTER (WHERE status = 'COMPLETED')::int AS completed
    FROM personnel_assignments
    WHERE assigned_vehicle_id = $1
    `,
    [vehicleId]
  );

  const row = result.rows[0] || {};
  return {
    totalAssigned: row.total_assigned || 0,
    onHand: row.on_hand || 0,
    inProgress: row.in_progress || 0,
    completed: row.completed || 0,
  };
}

/** Completed or revision-requested reports worked on with this vehicle. */
async function findTaskHistoryByVehicleId(vehicleId, { limit = 30, offset = 0 } = {}, queryable = pool) {
  const historyCte = `
    WITH vehicle_report_rows AS (
      SELECT
        r.report_id, r.resident_id, r.title, r.category, r.description,
        r.latitude, r.longitude, r.image_url, r.status, r.admin_response,
        r.personnel_note, r.assigned_personnel_ids, r.assigned_personnel_id,
        r.assigned_by_admin_id, r.assigned_at, r.priority, r.waste_scale,
        r.assigned_team_id, r.assigned_vehicle_id,
        COALESCE(r.is_deleted, false) AS is_deleted, r.deleted_at,
        COALESCE(r.is_archived, false) AS is_archived,
        COALESCE(r.is_restored, false) AS is_restored, r.created_at, r.updated_at,
        r.handled_by_id, r.resolution_image_url, r.resolved_at, 0 AS source_priority
      FROM reports r
      JOIN personnel_assignments pa ON pa.report_id = r.report_id
      WHERE pa.assigned_vehicle_id = $1

      UNION ALL

      SELECT
        ar.report_id, ar.resident_id, ar.title, ar.category, ar.description,
        ar.latitude, ar.longitude, ar.image_url, ar.status, ar.admin_response,
        NULL::text AS personnel_note, ar.assigned_personnel_ids,
        ar.assigned_personnel_id, ar.assigned_by_admin_id, ar.assigned_at,
        ar.priority, ar.waste_scale, ar.assigned_team_id, ar.assigned_vehicle_id,
        (ar.deleted_at IS NOT NULL) AS is_deleted, ar.deleted_at,
        TRUE AS is_archived, FALSE AS is_restored, ar.created_at, ar.updated_at,
        NULL::varchar AS handled_by_id, NULL::text AS resolution_image_url,
        NULL::timestamptz AS resolved_at, 1 AS source_priority
      FROM archived_reports ar
      JOIN personnel_assignments pa ON pa.report_id = ar.report_id
      WHERE pa.assigned_vehicle_id = $1
    ), deduplicated_reports AS (
      SELECT DISTINCT ON (report_id) *
      FROM vehicle_report_rows
      ORDER BY report_id, source_priority
    ), historical_reports AS (
      SELECT * FROM deduplicated_reports
      WHERE lower(trim(status)) = 'completed'
        OR (
          lower(trim(status)) IN ('in progress', 'in_progress', 'in-progress')
          AND NULLIF(TRIM(personnel_note), '') IS NOT NULL
        )
    )
  `;
  const [rowsResult, countResult] = await Promise.all([
    queryable.query(
      `
      ${historyCte}
      SELECT * FROM historical_reports
      ORDER BY created_at DESC NULLS LAST, report_id DESC
      LIMIT $2 OFFSET $3
      `,
      [vehicleId, limit, offset]
    ),
    queryable.query(
      `
      ${historyCte}
      SELECT COUNT(*)::int AS total FROM historical_reports
      `,
      [vehicleId]
    ),
  ]);

  return { reports: rowsResult.rows, total: Number(countResult.rows[0]?.total || 0) };
}

/** Every vehicle dispatched to one report, used when a collection is scheduled. */
async function findByCurrentReport(reportId, queryable = pool) {
  const result = await queryable.query(
    `SELECT ${VEHICLE_SELECT_FIELDS} ${VEHICLE_FROM}
     WHERE v.current_report_id = $1 AND v.is_deleted = false`,
    [reportId]
  );

  return result.rows.map(toVehicle);
}

/** True when a live vehicle already holds this plate. Excludes the given id. */
async function isPlateTaken(plateNumber, excludeVehicleId = null, queryable = pool) {
  const result = await queryable.query(
    `SELECT 1 FROM vehicles
     WHERE plate_number = $1
       AND is_deleted = false
       AND ($2::text IS NULL OR vehicle_id <> $2)
     LIMIT 1`,
    [plateNumber, excludeVehicleId]
  );

  return result.rows.length > 0;
}

/**
 * Adds a vehicle to the fleet.
 *
 * <p>The id comes from the database sequence rather than being generated here,
 * so two concurrent registrations cannot be handed the same VEH-0001.
 */
async function createVehicle(payload, adminId = null, queryable = pool) {
  const result = await queryable.query(
    `
    INSERT INTO vehicles (
      plate_number,
      vehicle_type,
      rated_load_capacity,
      status,
      notes,
      last_activity_at,
      created_by_admin_id,
      updated_by_admin_id
    )
    VALUES ($1, $2, $3, $4, $5, NOW(), $6, $6)
    RETURNING vehicle_id
    `,
    [
      payload.plateNumber,
      payload.vehicleType,
      payload.ratedLoadCapacity,
      payload.status,
      payload.notes,
      adminId,
    ]
  );

  return result.rows[0]?.vehicle_id || null;
}

const COLUMN_BY_FIELD = Object.freeze({
  plateNumber: 'plate_number',
  vehicleType: 'vehicle_type',
  ratedLoadCapacity: 'rated_load_capacity',
  notes: 'notes',
  status: 'status',
  currentReportId: 'current_report_id',
});

/**
 * Applies a partial update.
 *
 * <p>Writing `updated_at` and `last_activity_at` here is what makes the list
 * reorder itself: the screen sorts by recent activity, so saving a change has to
 * count as activity.
 */
async function updateVehicle(vehicleId, updates, adminId = null, queryable = pool) {
  const assignments = [];
  const values = [vehicleId];

  for (const [field, value] of Object.entries(updates)) {
    const column = COLUMN_BY_FIELD[field];
    if (!column) continue;

    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }

  // A status change without an explicit report means the vehicle is being freed:
  // Available and Maintenance are both states with nothing to collect, so the
  // collection columns are cleared rather than left pointing at finished work.
  if (updates.status && updates.status !== 'Assigned' && updates.currentReportId === undefined) {
    assignments.push('current_report_id = NULL', 'current_cluster_id = NULL', 'assigned_at = NULL');
  }

  if (adminId) {
    values.push(adminId);
    assignments.push(`updated_by_admin_id = $${values.length}`);
  }

  assignments.push('updated_at = NOW()', 'last_activity_at = NOW()');

  const result = await queryable.query(
    `UPDATE vehicles SET ${assignments.join(', ')}
     WHERE vehicle_id = $1 AND is_deleted = false
     RETURNING vehicle_id`,
    values
  );

  return result.rows[0]?.vehicle_id || null;
}

/**
 * Stamps the last service date, which the details screen shows as "last service".
 *
 * <p>Separate from the generic update because it is the one field an
 * administrator records from the maintenance screen, and because a service date
 * on its own should still count as fleet activity.
 */
async function recordService(vehicleId, servicedAt, adminId = null, queryable = pool) {
  const result = await queryable.query(
    `
    UPDATE vehicles
    SET last_service_at = COALESCE($2, NOW()),
        updated_at = NOW(),
        last_activity_at = NOW(),
        updated_by_admin_id = COALESCE($3, updated_by_admin_id)
    WHERE vehicle_id = $1 AND is_deleted = false
    RETURNING vehicle_id
    `,
    [vehicleId, servicedAt || null, adminId]
  );

  return result.rows[0]?.vehicle_id || null;
}

/**
 * Removes a vehicle from the fleet.
 *
 * <p>Soft, like every other record in this schema, so the row and its history
 * survive. This is also what frees the plate: the unique index only covers live
 * rows, so a removed vehicle's number plate can be registered again.
 */
async function softDeleteVehicle(vehicleId, adminId = null, queryable = pool) {
  const result = await queryable.query(
    `
    UPDATE vehicles
    SET is_deleted = true,
        deleted_at = NOW(),
        updated_at = NOW(),
        updated_by_admin_id = COALESCE($2, updated_by_admin_id)
    WHERE vehicle_id = $1 AND is_deleted = false
    RETURNING vehicle_id
    `,
    [vehicleId, adminId]
  );

  return result.rows[0]?.vehicle_id || null;
}

/**
 * Puts a vehicle on a collection.
 *
 * Separate from the generic update because dispatching is not an edit: the
 * truck's status, the report it is collecting and the moment it left the depot
 * all move together, and the report it is collecting is what the Admin screen
 * reads to show "on a collection right now".
 */
async function assignToReport(
  vehicleId,
  { reportId, clusterId = null, adminId = null },
  queryable = pool
) {
  const values = [vehicleId, reportId, clusterId, adminId];

  const result = await queryable.query(
    `
    UPDATE vehicles
       SET status = 'Assigned',
           current_report_id = $2,
           current_cluster_id = $3,
           assigned_at = NOW(),
           last_activity_at = NOW(),
           updated_by_admin_id = COALESCE($4, updated_by_admin_id),
           updated_at = NOW()
     WHERE vehicle_id = $1
       AND is_deleted = false
    RETURNING vehicle_id
    `,
    values
  );

  return result.rows[0]?.vehicle_id || null;
}

/**
 * Takes a vehicle off a collection.
 *
 * The truck goes back to Available rather than to whatever it was before: a
 * collection vehicle that was in Maintenance when it was dispatched cannot be
 * put back into Maintenance from here, because the dispatch was refused in the
 * first place.
 */
async function releaseFromReport(vehicleId, adminId = null, queryable = pool) {
  const result = await queryable.query(
    `
    UPDATE vehicles
       SET status = 'Available',
           current_report_id = NULL,
           current_cluster_id = NULL,
           assigned_at = NULL,
           last_activity_at = NOW(),
           updated_by_admin_id = COALESCE($2, updated_by_admin_id),
           updated_at = NOW()
     WHERE vehicle_id = $1
       AND is_deleted = false
       AND current_report_id IS NOT NULL
    RETURNING vehicle_id
    `,
    [vehicleId, adminId]
  );

  return result.rows[0]?.vehicle_id || null;
}

module.exports = {
  findAll,
  findByCurrentReport,
  findByVehicleId,
  getTaskCountsByVehicleId,
  findTaskHistoryByVehicleId,
  findStatusCounts,
  isPlateTaken,
  createVehicle,
  updateVehicle,
  recordService,
  softDeleteVehicle,
  assignToReport,
  releaseFromReport,
  toVehicle,
};

const { pool } = require('../../config/db');

/**
 * Persistence for the personnel assignment lifecycle.
 *
 * Every function accepts an optional queryable (a pool or a checked-out
 * transaction client) so the assignment mutations can run inside the same
 * transaction as the admin-side report update that created them.
 *
 * Rows are returned raw and snake_case; the controller owns the wire shape.
 */

const ACTIVE_STATUSES = ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'];

const ASSIGNMENT_COLUMNS = `
  pa.assignment_id,
  pa.report_id,
  pa.personnel_id,
  pa.cluster_id,
  pa.status,
  pa.assigned_by_admin_id,
  pa.assigned_at,
  pa.accepted_at,
  pa.started_at,
  pa.completed_at,
  pa.completion_notes,
  pa.assigned_team_id,
  (SELECT leader_personnel_id FROM cleaning_teams WHERE team_id = pa.assigned_team_id)
    AS assigned_team_leader_personnel_id,
  pa.assigned_vehicle_id,
  pa.waste_scale,
  pa.created_at,
  pa.updated_at
`;

// Report columns a cleaner is allowed to see about the assigned location.
const REPORT_COLUMNS = `
  r.title AS report_title,
  r.category AS report_category,
  r.description AS report_description,
  r.latitude AS report_latitude,
  r.longitude AS report_longitude,
  r.image_url AS report_image_url,
  r.status AS report_status,
  r.priority AS report_priority,
  r.admin_response AS report_admin_response,
  r.personnel_note AS report_personnel_note,
  r.cluster_id AS report_cluster_id,
  r.created_at AS report_created_at,
  r.resolved_at AS report_resolved_at,
  r.waste_scale AS report_waste_scale
`;

// The crew and the truck, resolved to their human-readable names so the
// cleaner app can show "Purok 1 Team" and "ABC 123" without a second call.
const TEAM_AND_VEHICLE_COLUMNS = `
  t.team_name AS assigned_team_name,
  v.plate_number AS assigned_vehicle_plate_number,
  v.vehicle_type AS assigned_vehicle_type
`;

const ASSIGNMENT_SELECT = `
  SELECT ${ASSIGNMENT_COLUMNS}, ${REPORT_COLUMNS}, ${TEAM_AND_VEHICLE_COLUMNS}
  FROM personnel_assignments pa
  LEFT JOIN reports r ON r.report_id = pa.report_id
  LEFT JOIN cleaning_teams t ON t.team_id = pa.assigned_team_id
  LEFT JOIN vehicles v ON v.vehicle_id = pa.assigned_vehicle_id
`;

const asQueryable = (queryable) => queryable || pool;

/**
 * Creates or refreshes the active assignment rows for one report.
 *
 * Called from the admin assignment transaction. Personnel who are no longer in
 * the new set are cancelled rather than deleted, so the cleaner keeps the
 * history entry. Personnel already active on this report are left untouched,
 * which is what makes a repeated admin save idempotent.
 */
async function syncReportAssignments(
  {
    reportId,
    personnelIds = [],
    clusterId = null,
    assignedByAdminId = null,
    assignedAt = new Date(),
    assignedTeamId = null,
    assignedVehicleId = null,
    wasteScale = null,
  },
  queryable
) {
  const db = asQueryable(queryable);
  const next = [
    ...new Set(personnelIds.filter(Boolean).map((id) => String(id).toUpperCase())),
  ];

  // Cancel any active record for this report that is not in the new set. This
  // covers reassignment and unassignment without touching completed history.
  const cancelledResult = await db.query(
    `
    UPDATE personnel_assignments
       SET status = 'CANCELLED',
           updated_at = NOW()
     WHERE report_id = $1
       AND status = ANY($2::text[])
       AND NOT (personnel_id = ANY($3::text[]))
    RETURNING personnel_id
    `,
    [reportId, ACTIVE_STATUSES, next]
  );
  const cancelled = cancelledResult.rows.map((row) => row.personnel_id);

  // Only rows that were actually inserted count as newly assigned. A repeated
  // admin save for the same cleaner leaves the existing active row untouched
  // and must not re-notify them.
  const created = [];
  for (const personnelId of next) {
    const inserted = await db.query(
      `
      INSERT INTO personnel_assignments (
        report_id,
        personnel_id,
        cluster_id,
        status,
        assigned_by_admin_id,
        assigned_at,
        assigned_team_id,
        assigned_vehicle_id,
        waste_scale
      )
      SELECT $1, $2, $3, 'ASSIGNED', $4, $5, $6, $7, $8
      WHERE NOT EXISTS (
        SELECT 1
        FROM personnel_assignments
        WHERE report_id = $1
          AND personnel_id = $2
          AND status = ANY($9::text[])
      )
      RETURNING personnel_id
      `,
      [
        reportId,
        personnelId,
        clusterId,
        assignedByAdminId,
        assignedAt,
        assignedTeamId || null,
        assignedVehicleId || null,
        wasteScale || null,
        ACTIVE_STATUSES,
      ]
    );

    if (inserted.rows[0]) {
      created.push(inserted.rows[0].personnel_id);
    }
  }

  return { created, cancelled };
}

async function findById(assignmentId, queryable) {
  const result = await asQueryable(queryable).query(
    `${ASSIGNMENT_SELECT} WHERE pa.assignment_id = $1 LIMIT 1`,
    [assignmentId]
  );
  return result.rows[0] || null;
}

/** Row-locked read for a status transition. */
async function findByIdForUpdate(assignmentId, queryable) {
  const result = await asQueryable(queryable).query(
    `
    SELECT ${ASSIGNMENT_COLUMNS}
    FROM personnel_assignments pa
    WHERE pa.assignment_id = $1
    LIMIT 1
    FOR UPDATE
    `,
    [assignmentId]
  );
  return result.rows[0] || null;
}

/**
 * The single live assignment for a cleaner, if any.
 *
 * The existing reports_active_assigned_personnel_uidx index means a cleaner
 * holds at most one live report, so this is a LIMIT 1 rather than a page.
 */
async function findActiveByPersonnelId(personnelId, queryable) {
  const result = await asQueryable(queryable).query(
    `
    ${ASSIGNMENT_SELECT}
    WHERE pa.personnel_id = $1
      AND pa.status = ANY($2::text[])
    ORDER BY pa.assigned_at DESC
    LIMIT 1
    `,
    [String(personnelId).toUpperCase(), ACTIVE_STATUSES]
  );
  return result.rows[0] || null;
}

async function listForPersonnel(
  personnelId,
  { status = null, limit = 50, offset = 0 } = {},
  queryable
) {
  const values = [String(personnelId).toUpperCase()];
  const conditions = ['pa.personnel_id = $1'];

  if (status) {
    values.push(status);
    conditions.push(`pa.status = $${values.length}`);
  }

  values.push(limit);
  const limitParameter = `$${values.length}`;
  values.push(offset);
  const offsetParameter = `$${values.length}`;

  const result = await asQueryable(queryable).query(
    `
    SELECT ${ASSIGNMENT_COLUMNS}, ${REPORT_COLUMNS}, ${TEAM_AND_VEHICLE_COLUMNS},
           COUNT(*) OVER() AS total_count
    FROM personnel_assignments pa
    LEFT JOIN reports r ON r.report_id = pa.report_id
    LEFT JOIN cleaning_teams t ON t.team_id = pa.assigned_team_id
    LEFT JOIN vehicles v ON v.vehicle_id = pa.assigned_vehicle_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY pa.created_at DESC, pa.assignment_id DESC
    LIMIT ${limitParameter} OFFSET ${offsetParameter}
    `,
    values
  );

  return result.rows;
}

/**
 * Every assignment row for one cleaner, counted by status.
 *
 * `total` is the whole history rather than a derived sum, so it stays correct if
 * a status is ever added: it counts exactly the tasks this cleaner was ever
 * given, which is what the "Total Assigned Tasks" card asks for.
 */
async function countsByPersonnelId(personnelId, queryable) {
  const result = await asQueryable(queryable).query(
    `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'ASSIGNED')::int AS assigned,
      COUNT(*) FILTER (WHERE status = 'ACCEPTED')::int AS accepted,
      COUNT(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS in_progress,
      COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled
    FROM personnel_assignments
    WHERE personnel_id = $1
    `,
    [String(personnelId).toUpperCase()]
  );

  return result.rows[0] || {
    total: 0,
    assigned: 0,
    accepted: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  };
}

async function updateStatus(assignmentId, fields = {}, queryable) {
  const assignments = [];
  const values = [];

  const set = (column, value) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };

  if (fields.status) set('status', fields.status);
  if (fields.acceptedAt !== undefined) set('accepted_at', fields.acceptedAt);
  if (fields.startedAt !== undefined) set('started_at', fields.startedAt);
  if (fields.completedAt !== undefined) set('completed_at', fields.completedAt);
  if (fields.completionNotes !== undefined) set('completion_notes', fields.completionNotes);

  if (assignments.length === 0) {
    return findById(assignmentId, queryable);
  }

  assignments.push('updated_at = NOW()');
  values.push(assignmentId);

  const result = await asQueryable(queryable).query(
    `
    UPDATE personnel_assignments
       SET ${assignments.join(', ')}
     WHERE assignment_id = $${values.length}
    RETURNING assignment_id
    `,
    values
  );

  if (!result.rows[0]) return null;
  return findById(assignmentId, queryable);
}

/** Accepts every personnel row dispatched as the same saved team task. */
async function acceptTeamAssignments(reportId, teamId, acceptedAt, queryable) {
  await asQueryable(queryable).query(
    `
    UPDATE personnel_assignments
       SET status = 'ACCEPTED',
           accepted_at = $3,
           updated_at = NOW()
     WHERE report_id = $1
       AND assigned_team_id = $2
       AND status = 'ASSIGNED'
    `,
    [reportId, teamId, acceptedAt]
  );
}

/**
 * The people who were actually dispatched to each of the given reports.
 *
 * <p>The cleaner app names the crew they are working with, so the ids on the
 * assignment rows are resolved to names here rather than left for the client.
 * A cancelled row is someone who was pulled off the report, so it is excluded;
 * a completed row is still part of the crew that turned out and is kept.
 *
 * <p>One report can hold several rows for the same person when a completed
 * assignment was later re-issued, so `DISTINCT ON` returns one row per person,
 * preferring the one that identifies them as the team leader.
 */
async function listCrewByReportIds(reportIds, queryable) {
  const ids = [
    ...new Set(
      (Array.isArray(reportIds) ? reportIds : [])
        .filter(Boolean)
        .map((id) => String(id).trim())
        .filter(Boolean)
    ),
  ];

  if (!ids.length) return [];

  const result = await asQueryable(queryable).query(
    `
    SELECT DISTINCT ON (pa.report_id, pa.personnel_id)
      pa.report_id,
      pa.personnel_id,
      p.first_name,
      p.last_name,
      p.profile_image,
      v.plate_number AS assigned_vehicle_plate_number,
      (t.leader_personnel_id IS NOT NULL
        AND t.leader_personnel_id = pa.personnel_id) AS is_leader
    FROM personnel_assignments pa
    INNER JOIN personnel_accounts p ON p.personnel_id = pa.personnel_id
    LEFT JOIN cleaning_teams t ON t.team_id = pa.assigned_team_id
    LEFT JOIN vehicles v ON v.vehicle_id = p.assigned_vehicle_id
    WHERE pa.report_id = ANY($1::text[])
      AND COALESCE(pa.status, '') <> 'CANCELLED'
      AND p.deleted_at IS NULL
    ORDER BY pa.report_id ASC,
             pa.personnel_id ASC,
             (t.leader_personnel_id = pa.personnel_id) DESC NULLS LAST,
             p.last_name ASC,
             p.first_name ASC
    `,
    [ids]
  );

  return result.rows;
}

/** Cancels every active assignment that points at a report (admin unassign). */
async function cancelActiveForReport(reportId, queryable) {
  const result = await asQueryable(queryable).query(
    `
    UPDATE personnel_assignments
       SET status = 'CANCELLED',
           updated_at = NOW()
     WHERE report_id = $1
       AND status = ANY($2::text[])
    RETURNING personnel_id
    `,
    [reportId, ACTIVE_STATUSES]
  );

  return result.rows.map((row) => row.personnel_id);
}

/** Marks the live assignment completed once the admin approves the report. */
async function completeActiveForReport(reportId, queryable) {
  const result = await asQueryable(queryable).query(
    `
    UPDATE personnel_assignments
       SET status = 'COMPLETED',
           completed_at = COALESCE(completed_at, NOW()),
           updated_at = NOW()
     WHERE report_id = $1
       AND status = ANY($2::text[])
    RETURNING personnel_id
    `,
    [reportId, ACTIVE_STATUSES]
  );

  return result.rows.map((row) => row.personnel_id);
}

/**
 * Reopens the completed assignment for a report after an administrator requests
 * a revision. The task returns to IN_PROGRESS so the cleaner can upload fresh
 * AFTER evidence and resubmit; the previous completion timestamp and notes are
 * cleared so an old submission cannot masquerade as the current one.
 *
 * Only a COMPLETED row is reopened. An assignment that is already live is left
 * alone, which keeps a repeated admin request idempotent.
 */
async function reopenCompletedForReport(reportId, queryable) {
  const result = await asQueryable(queryable).query(
    `
    UPDATE personnel_assignments
       SET status = 'IN_PROGRESS',
           completed_at = NULL,
           completion_notes = NULL,
           updated_at = NOW()
     WHERE report_id = $1
       AND status = 'COMPLETED'
    RETURNING personnel_id, assignment_id
    `,
    [reportId]
  );

  return result.rows;
}

/**
 * The newest completion note for each of the given reports.
 *
 * The resident is the reporter, so telling them what the cleaner actually did is
 * reassurance they are entitled to; the administrator's internal instructions
 * are not. Those live in `reports.personnel_note` and never appear here.
 *
 * DISTINCT ON keeps one note per report (the most recently completed one) so the
 * caller gets a plain map rather than a list it has to disambiguate, and the
 * whole lookup is a single round trip for a page of reports. Reports with no
 * completed assignment are simply absent from the result.
 */
async function findLatestCompletionNotesByReportIds(reportIds, queryable) {
  const ids = [
    ...new Set(
      (Array.isArray(reportIds) ? reportIds : [])
        .filter(Boolean)
        .map((id) => String(id).trim())
        .filter(Boolean)
    ),
  ];

  if (ids.length === 0) return new Map();

  const result = await asQueryable(queryable).query(
    `
    SELECT DISTINCT ON (report_id) report_id, completion_notes
    FROM personnel_assignments
    WHERE report_id = ANY($1::text[])
      AND completion_notes IS NOT NULL
      AND NULLIF(TRIM(completion_notes), '') IS NOT NULL
    ORDER BY report_id, completed_at DESC NULLS LAST, assignment_id DESC
    `,
    [ids]
  );

  return new Map(result.rows.map((row) => [row.report_id, row.completion_notes]));
}

/**
 * The newest completed assignment for each of the given reports, including who
 * finished the work.
 *
 * The administrator needs two different things from a finished report: the note
 * the cleaner wrote, and the cleaner who wrote it. Neither is on the report row
 * — approving a report releases the assignment pointer — so both are read from
 * `personnel_assignments` here.
 *
 * Unlike {@link findLatestCompletionNotesByReportIds}, a completed assignment
 * with a blank note still counts: the admin has to see who did the work even
 * when they wrote nothing down. The cleaner is joined in rather than filtered
 * out, because a deleted personnel account must still be credited with the
 * cleanup they performed.
 *
 * DISTINCT ON keeps one row per report (the most recently completed one) and the
 * whole lookup is a single round trip for a page of reports. Reports with no
 * completed assignment are simply absent from the result.
 */
async function findLatestCompletionsByReportIds(reportIds, queryable) {
  const ids = [
    ...new Set(
      (Array.isArray(reportIds) ? reportIds : [])
        .filter(Boolean)
        .map((id) => String(id).trim())
        .filter(Boolean)
    ),
  ];

  if (ids.length === 0) return new Map();

  const result = await asQueryable(queryable).query(
    `
    SELECT DISTINCT ON (pa.report_id)
      pa.report_id,
      pa.personnel_id,
      pa.completion_notes,
      pa.completed_at,
      CASE WHEN pa.assigned_team_id IS NOT NULL THEN (
        SELECT leader_assignment.completion_notes
        FROM personnel_assignments leader_assignment
        INNER JOIN cleaning_teams assigned_team
          ON assigned_team.team_id = leader_assignment.assigned_team_id
         AND assigned_team.leader_personnel_id = leader_assignment.personnel_id
        WHERE leader_assignment.report_id = pa.report_id
          AND leader_assignment.assigned_team_id = pa.assigned_team_id
          AND leader_assignment.status = 'COMPLETED'
        ORDER BY leader_assignment.completed_at DESC NULLS LAST,
                 leader_assignment.assignment_id DESC
        LIMIT 1
      ) ELSE NULL END AS team_leader_completion_notes,
      p.first_name,
      p.last_name,
      p.profile_image
    FROM personnel_assignments pa
    LEFT JOIN personnel_accounts p
      ON p.personnel_id = pa.personnel_id
    WHERE pa.report_id = ANY($1::text[])
      AND pa.status = 'COMPLETED'
    ORDER BY pa.report_id, pa.completed_at DESC NULLS LAST, pa.assignment_id DESC
    `,
    [ids]
  );

  const completions = new Map();
  for (const row of result.rows) {
    const name = `${row.first_name || ''} ${row.last_name || ''}`.trim();
    completions.set(row.report_id, {
      personnelId: row.personnel_id || null,
      personnelName: name || null,
      personnelAvatar: row.profile_image || null,
      completionNotes:
        row.completion_notes && row.completion_notes.trim()
          ? row.completion_notes.trim()
          : null,
      teamLeaderCompletionNotes:
        row.team_leader_completion_notes
        && row.team_leader_completion_notes.trim()
          ? row.team_leader_completion_notes.trim()
          : null,
      completedAt: row.completed_at || null,
    });
  }

  return completions;
}

module.exports = {
  ACTIVE_STATUSES,
  syncReportAssignments,
  findById,
  findByIdForUpdate,
  findActiveByPersonnelId,
  listForPersonnel,
  listCrewByReportIds,
  countsByPersonnelId,
  updateStatus,
  acceptTeamAssignments,
  cancelActiveForReport,
  completeActiveForReport,
  reopenCompletedForReport,
  findLatestCompletionNotesByReportIds,
  findLatestCompletionsByReportIds,
};

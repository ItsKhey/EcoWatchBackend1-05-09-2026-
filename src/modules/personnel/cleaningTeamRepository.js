const { pool } = require('../../config/db');

/**
 * Persistence for cleaning teams.
 *
 * A team is a reusable crew the administrator maintains once and then
 * dispatches as a unit. Keeping the membership in its own table (rather than
 * a text[] column) means the team can be edited after it was created, and
 * that the "who is on this crew" question has one answer.
 *
 * Rows are returned raw and snake_case; the service owns the wire shape.
 */

const TEAM_COLUMNS = `
  t.team_id,
  t.team_name,
  t.description,
  t.parent_team_id,
  t.leader_personnel_id,
  t.is_deleted,
  t.deleted_at,
  t.created_by_admin_id,
  t.updated_by_admin_id,
  t.created_at,
  t.updated_at
`;

const asQueryable = (queryable) => queryable || pool;

const mapMemberRow = (row) => ({
  personnelId: row.personnel_id,
  leader: row.is_leader === true,
  firstName: row.first_name || '',
  lastName: row.last_name || '',
  fullName: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
  username: row.username || '',
  occupation: row.occupation || 'Regular',
  status: row.status || null,
  enabled: row.enabled === true,
  profileImage: row.profile_image || null,
  assignedVehicleId: row.assigned_vehicle_id || null,
  assignedVehiclePlateNumber: row.assigned_vehicle_plate_number || null,
  addedAt: row.added_at || null,
});

/** Every team, with its member count and its own name resolved. */
async function listTeams({ includeDeleted = false } = {}, queryable) {
  const db = asQueryable(queryable);
  const result = await db.query(
    `
    SELECT
      ${TEAM_COLUMNS},
      parent.team_name AS parent_team_name,
      leader.first_name AS leader_first_name,
      leader.last_name AS leader_last_name,
      COALESCE(member_counts.member_count, 0) AS member_count
    FROM cleaning_teams t
    LEFT JOIN cleaning_teams parent ON parent.team_id = t.parent_team_id
    LEFT JOIN personnel_accounts leader ON leader.personnel_id = t.leader_personnel_id
    LEFT JOIN (
      SELECT
        ctm.team_id,
        COUNT(*)::int AS member_count
      FROM cleaning_team_members ctm
      INNER JOIN personnel_accounts p ON p.personnel_id = ctm.personnel_id
      WHERE p.deleted_at IS NULL
      GROUP BY ctm.team_id
    ) AS member_counts ON member_counts.team_id = t.team_id
    WHERE ($1::boolean = true OR COALESCE(t.is_deleted, false) = false)
    ORDER BY t.team_name ASC
    `,
    [includeDeleted]
  );

  return result.rows;
}

/** Completed and revision-requested reports historically worked by this crew. */
async function findTaskHistoryByTeamId(teamId, { limit = 30, offset = 0 } = {}, queryable) {
  const db = asQueryable(queryable);
  const historyCte = `
    WITH team_report_rows AS (
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
      WHERE pa.assigned_team_id = $1

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
      WHERE pa.assigned_team_id = $1
    ), deduplicated_reports AS (
      SELECT DISTINCT ON (report_id) *
      FROM team_report_rows
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
    db.query(
      `${historyCte}
       SELECT * FROM historical_reports
       ORDER BY created_at DESC NULLS LAST, report_id DESC
       LIMIT $2 OFFSET $3`,
      [teamId, limit, offset]
    ),
    db.query(
      `${historyCte}
       SELECT COUNT(*)::int AS total FROM historical_reports`,
      [teamId]
    ),
  ]);
  return {
    reports: rowsResult.rows,
    total: Number(countResult.rows[0]?.total || 0),
  };
}

/** One team, or null when it does not exist or has been removed. */
async function findTeamById(teamId, queryable) {
  const db = asQueryable(queryable);
  const result = await db.query(
    `
    SELECT
      ${TEAM_COLUMNS},
      parent.team_name AS parent_team_name,
      leader.first_name AS leader_first_name,
      leader.last_name AS leader_last_name,
      COALESCE(member_counts.member_count, 0) AS member_count
    FROM cleaning_teams t
    LEFT JOIN cleaning_teams parent ON parent.team_id = t.parent_team_id
    LEFT JOIN personnel_accounts leader ON leader.personnel_id = t.leader_personnel_id
    LEFT JOIN (
      SELECT
        ctm.team_id,
        COUNT(*)::int AS member_count
      FROM cleaning_team_members ctm
      INNER JOIN personnel_accounts p ON p.personnel_id = ctm.personnel_id
      WHERE p.deleted_at IS NULL
      GROUP BY ctm.team_id
    ) AS member_counts ON member_counts.team_id = t.team_id
    WHERE t.team_id = $1
    LIMIT 1
    `,
    [teamId]
  );

  return result.rows[0] || null;
}

/** The people on one team. */
async function listTeamMembers(teamId, queryable) {
  const db = asQueryable(queryable);
  const result = await db.query(
    `
    SELECT
      ctm.personnel_id,
      ctm.added_by_admin_id,
      ctm.added_at,
      (t.leader_personnel_id IS NOT NULL
        AND t.leader_personnel_id = ctm.personnel_id) AS is_leader,
      p.first_name,
      p.last_name,
      p.username,
      p.occupation,
      p.status,
      p.enabled,
      p.profile_image,
      p.assigned_vehicle_id,
      v.plate_number AS assigned_vehicle_plate_number
    FROM cleaning_team_members ctm
    INNER JOIN cleaning_teams t ON t.team_id = ctm.team_id
    INNER JOIN personnel_accounts p ON p.personnel_id = ctm.personnel_id
    LEFT JOIN vehicles v ON v.vehicle_id = p.assigned_vehicle_id
    WHERE ctm.team_id = $1
      AND p.deleted_at IS NULL
    ORDER BY (t.leader_personnel_id = ctm.personnel_id) DESC,
             p.last_name ASC,
             p.first_name ASC
    `,
    [teamId]
  );

  return result.rows.map(mapMemberRow);
}

/**
 * The member ids of one team.
 *
 * Used by the assignment transaction, which has to check that the crew it is
 * dispatching is actually on the team it claims to be sending.
 */
async function listTeamMemberIds(teamId, queryable) {
  const db = asQueryable(queryable);
  const result = await db.query(
    `
    SELECT ctm.personnel_id
    FROM cleaning_team_members ctm
    INNER JOIN personnel_accounts p ON p.personnel_id = ctm.personnel_id
    WHERE ctm.team_id = $1
      AND p.deleted_at IS NULL
      AND COALESCE(p.enabled, true) = true
    `,
    [teamId]
  );

  return result.rows.map((row) => String(row.personnel_id).toUpperCase());
}

/** The teams one personnel account belongs to. */
async function listTeamsForPersonnel(personnelId, queryable) {
  const db = asQueryable(queryable);
  const result = await db.query(
    `
    SELECT
      t.team_id,
      t.team_name,
      t.description,
      t.parent_team_id,
      t.leader_personnel_id,
      t.created_at,
      t.updated_at,
      ctm.added_at
    FROM cleaning_team_members ctm
    INNER JOIN cleaning_teams t ON t.team_id = ctm.team_id
    WHERE ctm.personnel_id = $1
      AND COALESCE(t.is_deleted, false) = false
    ORDER BY t.team_name ASC
    `,
    [personnelId]
  );

  return result.rows;
}

async function createTeam(
  {
    teamName,
    description = null,
    parentTeamId = null,
    leaderPersonnelId = null,
    createdByAdminId = null,
  },
  queryable
) {
  const db = asQueryable(queryable);
  const result = await db.query(
    `
    INSERT INTO cleaning_teams (
      team_name,
      description,
      parent_team_id,
      leader_personnel_id,
      created_by_admin_id,
      updated_by_admin_id
    )
    VALUES ($1, $2, $3, $4, $5, $5)
    RETURNING *
    `,
    [teamName, description, parentTeamId, leaderPersonnelId, createdByAdminId]
  );

  return result.rows[0] || null;
}

async function updateTeam(
  teamId,
  {
    teamName,
    description = undefined,
    parentTeamId = undefined,
    leaderPersonnelId = undefined,
    updatedByAdminId = null,
  },
  queryable
) {
  const db = asQueryable(queryable);
  const result = await db.query(
    `
    UPDATE cleaning_teams
       SET team_name = COALESCE($2, team_name),
           description = CASE WHEN $3::boolean THEN $4 ELSE description END,
           parent_team_id = CASE WHEN $5::boolean THEN $6 ELSE parent_team_id END,
           leader_personnel_id =
             CASE WHEN $7::boolean THEN $8 ELSE leader_personnel_id END,
           updated_by_admin_id = $9,
           updated_at = NOW()
     WHERE team_id = $1
       AND COALESCE(is_deleted, false) = false
    RETURNING *
    `,
    [
      teamId,
      teamName || null,
      description !== undefined,
      description === undefined ? null : description,
      parentTeamId !== undefined,
      parentTeamId === undefined ? null : parentTeamId,
      leaderPersonnelId !== undefined,
      leaderPersonnelId === undefined ? null : leaderPersonnelId,
      updatedByAdminId,
    ]
  );

  return result.rows[0] || null;
}

/** Soft delete, so a team that was dispatched stays readable on old reports. */
async function softDeleteTeam(teamId, updatedByAdminId = null, queryable) {
  const db = asQueryable(queryable);
  const result = await db.query(
    `
    UPDATE cleaning_teams
       SET is_deleted = true,
           deleted_at = NOW(),
           updated_by_admin_id = $2,
           updated_at = NOW()
     WHERE team_id = $1
       AND COALESCE(is_deleted, false) = false
    RETURNING *
    `,
    [teamId, updatedByAdminId]
  );

  return result.rows[0] || null;
}

/**
 * Replaces the membership of a team.
 *
 * The list is the whole truth: whatever is passed in is what the team is
 * made of afterwards. Members who are dropped keep their own history, they
 * simply stop being part of this crew.
 */
async function replaceTeamMembers(teamId, personnelIds = [], addedByAdminId = null, queryable) {
  const db = asQueryable(queryable);
  const unique = [
    ...new Set(personnelIds.filter(Boolean).map((id) => String(id).trim().toUpperCase())),
  ];

  await db.query('DELETE FROM cleaning_team_members WHERE team_id = $1', [teamId]);

  for (const personnelId of unique) {
    await db.query(
      `
      INSERT INTO cleaning_team_members (team_id, personnel_id, added_by_admin_id)
      SELECT $1, $2, $3
      WHERE EXISTS (SELECT 1 FROM personnel_accounts WHERE personnel_id = $2)
      ON CONFLICT (team_id, personnel_id) DO NOTHING
      `,
      [teamId, personnelId, addedByAdminId]
    );
  }

  // A leader who is no longer on the crew cannot lead it. The service keeps the
  // leader in the list it sends, so this only fires for a membership write that
  // bypassed that rule; nulling is the honest answer rather than naming somebody
  // who is not there.
  await db.query(
    `
    UPDATE cleaning_teams
       SET leader_personnel_id = NULL
     WHERE team_id = $1
       AND leader_personnel_id IS NOT NULL
       AND NOT (leader_personnel_id = ANY($2::text[]))
    `,
    [teamId, unique]
  );

  return listTeamMembers(teamId, db);
}

/** Adds one person to a team without touching the rest of it. */
async function addTeamMember(teamId, personnelId, addedByAdminId = null, queryable) {
  const db = asQueryable(queryable);
  await db.query(
    `
    INSERT INTO cleaning_team_members (team_id, personnel_id, added_by_admin_id)
    SELECT $1, $2, $3
    WHERE EXISTS (SELECT 1 FROM personnel_accounts WHERE personnel_id = $2)
    ON CONFLICT (team_id, personnel_id) DO NOTHING
    `,
    [teamId, String(personnelId).trim().toUpperCase(), addedByAdminId]
  );

  return listTeamMembers(teamId, db);
}

/** Removes one person from a team. */
async function removeTeamMember(teamId, personnelId, queryable) {
  const db = asQueryable(queryable);
  const normalizedId = String(personnelId).trim().toUpperCase();

  await db.query(
    'DELETE FROM cleaning_team_members WHERE team_id = $1 AND personnel_id = $2',
    [teamId, normalizedId]
  );

  // Removing the leader leaves the team without one, which the Teams screen
  // reports as needing attention until another leader is chosen. Keeping the id
  // would point at somebody who is no longer on the crew.
  await db.query(
    `
    UPDATE cleaning_teams
       SET leader_personnel_id = NULL
     WHERE team_id = $1
       AND leader_personnel_id = $2
    `,
    [teamId, normalizedId]
  );

  return listTeamMembers(teamId, db);
}

/**
 * The teams and vehicles behind a set of reports, resolved in one query.
 *
 * The admin report list and the report detail dialog both need the team name
 * and the vehicle plate next to the report, and resolving them per report
 * would be a query per row. This joins them once.
 *
 * @param {{ teamIds?: string[], vehicleIds?: string[] }} ids
 */
async function resolveTeamAndVehicle({ teamIds = [], vehicleIds = [] } = {}, queryable) {
  const teams = [...new Set(teamIds.filter(Boolean))];
  const vehicles = [...new Set(vehicleIds.filter(Boolean))];

  if (!teams.length && !vehicles.length) {
    return { teams: new Map(), vehicles: new Map() };
  }

  const db = asQueryable(queryable);
  const [teamResult, vehicleResult] = await Promise.all([
    teams.length
      ? db.query(
        `
        SELECT t.team_id, t.team_name, t.description
        FROM cleaning_teams t
        WHERE t.team_id = ANY($1::text[])
        `,
        [teams]
      )
      : { rows: [] },
    vehicles.length
      ? db.query(
        `
        SELECT v.vehicle_id, v.plate_number, v.vehicle_type, v.status
        FROM vehicles v
        WHERE v.vehicle_id = ANY($1::varchar[])
        `,
        [vehicles]
      )
      : { rows: [] },
  ]);

  return {
    teams: new Map(teamResult.rows.map((row) => [row.team_id, row])),
    vehicles: new Map(vehicleResult.rows.map((row) => [row.vehicle_id, row])),
  };
}

/**
 * The people behind a set of reports, resolved in one query.
 *
 * A resident is entitled to know who turned out, so the dispatch details need
 * names rather than identifiers. Resolving them per report would be a query
 * per row, so the whole list is resolved at once.
 *
 * Both ways a crew can exist are covered. The personnel ids the report carries
 * are authoritative -- they are the people who actually went out, whether they
 * came from a saved team or were picked ad hoc. The saved team's own
 * membership is the fallback for a report whose ids were never filled in.
 *
 * The rows come back in the repository's usual shape. What a resident is
 * allowed to see of them is decided by the caller, not here.
 *
 * @param {{ personnelIds?: string[], teamIds?: string[] }} ids
 */
async function resolveDispatchCrews({ personnelIds = [], teamIds = [] } = {}, queryable) {
  // Personnel ids are upper case everywhere in the system (PERS-0001), so the
  // ids are folded before they are queried: a report row that stored the id in
  // another case still finds the person it named.
  const people = [
    ...new Set(personnelIds.filter(Boolean).map((id) => String(id).trim().toUpperCase())),
  ];
  const teams = [...new Set(teamIds.filter(Boolean))];

  if (!people.length && !teams.length) {
    return { membersByPersonnelId: new Map(), membersByTeamId: new Map() };
  }

  const db = asQueryable(queryable);
  const [personnelResult, teamResult] = await Promise.all([
    people.length
      ? db.query(
        `
        SELECT
          p.personnel_id,
          p.first_name,
          p.last_name,
          p.profile_image,
          p.assigned_vehicle_id,
          v.plate_number AS assigned_vehicle_plate_number
        FROM personnel_accounts p
        LEFT JOIN vehicles v ON v.vehicle_id = p.assigned_vehicle_id
        WHERE p.personnel_id = ANY($1::text[])
          AND p.deleted_at IS NULL
        `,
        [people]
      )
      : { rows: [] },
    teams.length
      ? db.query(
        `
        SELECT
          ctm.team_id,
          ctm.personnel_id,
          (t.leader_personnel_id IS NOT NULL
            AND t.leader_personnel_id = ctm.personnel_id) AS is_leader,
          p.first_name,
          p.last_name,
          p.profile_image,
          p.assigned_vehicle_id,
          v.plate_number AS assigned_vehicle_plate_number
        FROM cleaning_team_members ctm
        INNER JOIN cleaning_teams t ON t.team_id = ctm.team_id
        INNER JOIN personnel_accounts p ON p.personnel_id = ctm.personnel_id
        LEFT JOIN vehicles v ON v.vehicle_id = p.assigned_vehicle_id
        WHERE ctm.team_id = ANY($1::text[])
          AND p.deleted_at IS NULL
        ORDER BY ctm.team_id ASC,
                 (t.leader_personnel_id = ctm.personnel_id) DESC,
                 p.last_name ASC,
                 p.first_name ASC
        `,
        [teams]
      )
      : { rows: [] },
  ]);

  // Personnel ids are kept upper case everywhere in the system, so the lookup
  // key is folded the same way: a report row that stored the id in another
  // case still finds the person it named.
  const membersByPersonnelId = new Map(
    personnelResult.rows.map((row) => [
      String(row.personnel_id).trim().toUpperCase(),
      mapMemberRow(row),
    ])
  );

  const membersByTeamId = new Map();
  for (const row of teamResult.rows) {
    const members = membersByTeamId.get(row.team_id) || [];
    members.push(mapMemberRow(row));
    membersByTeamId.set(row.team_id, members);
  }

  return { membersByPersonnelId, membersByTeamId };
}

module.exports = {
  listTeams,
  findTaskHistoryByTeamId,
  findTeamById,
  listTeamMembers,
  listTeamMemberIds,
  listTeamsForPersonnel,
  createTeam,
  updateTeam,
  softDeleteTeam,
  replaceTeamMembers,
  addTeamMember,
  removeTeamMember,
  resolveTeamAndVehicle,
  resolveDispatchCrews,
};

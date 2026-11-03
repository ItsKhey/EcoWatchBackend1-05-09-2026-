const { pool } = require('../../config/db');

/**
 * Persistence for before/after cleaning evidence.
 *
 * Evidence is owned by the assignment, not by the report, so a photo can never
 * be attached to a cleaner's task by someone else: every read and delete is
 * scoped by assignment_id and personnel_id together.
 */

const asQueryable = (queryable) => queryable || pool;

async function addEvidence(
  { assignmentId, reportId, personnelId, phase, imageUrl },
  queryable
) {
  const result = await asQueryable(queryable).query(
    `
    INSERT INTO personnel_evidence (
      assignment_id,
      report_id,
      personnel_id,
      phase,
      image_url
    )
    VALUES ($1, $2, $3, $4, $5)
    RETURNING evidence_id, assignment_id, report_id, personnel_id, phase, image_url, uploaded_at
    `,
    [assignmentId, reportId, String(personnelId).toUpperCase(), phase, imageUrl]
  );

  return result.rows[0] || null;
}

async function listForAssignment(assignmentId, queryable) {
  const result = await asQueryable(queryable).query(
    `
    SELECT evidence_id, assignment_id, report_id, personnel_id, phase, image_url, uploaded_at
    FROM personnel_evidence
    WHERE assignment_id = $1
    ORDER BY uploaded_at ASC, evidence_id ASC
    `,
    [assignmentId]
  );

  return result.rows;
}

/** One query for the evidence of many assignments, used by the task list. */
async function listForAssignments(assignmentIds, queryable) {
  if (!Array.isArray(assignmentIds) || assignmentIds.length === 0) {
    return [];
  }

  const result = await asQueryable(queryable).query(
    `
    SELECT evidence_id, assignment_id, report_id, personnel_id, phase, image_url, uploaded_at
    FROM personnel_evidence
    WHERE assignment_id = ANY($1::text[])
    ORDER BY uploaded_at ASC, evidence_id ASC
    `,
    [assignmentIds]
  );

  return result.rows;
}

async function countByPhase(assignmentId, queryable) {
  const result = await asQueryable(queryable).query(
    `
    SELECT phase, COUNT(*)::int AS total
    FROM personnel_evidence
    WHERE assignment_id = $1
    GROUP BY phase
    `,
    [assignmentId]
  );

  const counts = { BEFORE: 0, AFTER: 0 };
  for (const row of result.rows) {
    counts[row.phase] = Number(row.total || 0);
  }
  return counts;
}

/**
 * Every evidence row attached to a report, for the admin review screen.
 *
 * Evidence is normally read by assignment, but the administrator reviews a
 * report and only holds the report id. The report may have had more than one
 * assignment over its lifetime, so this returns them all ordered by upload so
 * the reviewer sees the earliest BEFORE photo and the latest AFTER photos.
 */
async function listForReport(reportId, queryable) {
  const result = await asQueryable(queryable).query(
    `
    SELECT evidence_id, assignment_id, report_id, personnel_id, phase, image_url, uploaded_at
    FROM personnel_evidence
    WHERE report_id = $1
    ORDER BY uploaded_at ASC, evidence_id ASC
    `,
    [reportId]
  );

  return result.rows;
}

/** One query for the evidence of many reports, used by the admin report list. */
async function listForReports(reportIds, queryable) {
  if (!Array.isArray(reportIds) || reportIds.length === 0) {
    return [];
  }

  const result = await asQueryable(queryable).query(
    `
    SELECT evidence_id, assignment_id, report_id, personnel_id, phase, image_url, uploaded_at
    FROM personnel_evidence
    WHERE report_id = ANY($1::text[])
    ORDER BY uploaded_at ASC, evidence_id ASC
    `,
    [reportIds]
  );

  return result.rows;
}

/**
 * Removes the AFTER evidence for one assignment, returning the deleted rows so
 * the caller can release the stored assets. Used when an administrator asks for
 * a revision: the old finished-work photos must not linger, since the cleaner
 * is about to submit a fresh set.
 *
 * BEFORE evidence is intentionally kept, so the cleaner keeps their proof of the
 * original condition and does not have to re-photograph it.
 */
async function deleteAfterForAssignment(assignmentId, queryable) {
  const result = await asQueryable(queryable).query(
    `
    DELETE FROM personnel_evidence
    WHERE assignment_id = $1
      AND phase = 'AFTER'
    RETURNING evidence_id, assignment_id, report_id, personnel_id, phase, image_url
    `,
    [assignmentId]
  );

  return result.rows;
}

async function findOwned(
  { assignmentId, evidenceId, personnelId },
  queryable
) {
  const result = await asQueryable(queryable).query(
    `
    SELECT evidence_id, assignment_id, report_id, personnel_id, phase, image_url, uploaded_at
    FROM personnel_evidence
    WHERE evidence_id = $1
      AND assignment_id = $2
      AND personnel_id = $3
    LIMIT 1
    `,
    [evidenceId, assignmentId, String(personnelId).toUpperCase()]
  );

  return result.rows[0] || null;
}

async function deleteOwned({ assignmentId, evidenceId, personnelId }, queryable) {
  const result = await asQueryable(queryable).query(
    `
    DELETE FROM personnel_evidence
    WHERE evidence_id = $1
      AND assignment_id = $2
      AND personnel_id = $3
    RETURNING evidence_id, image_url
    `,
    [evidenceId, assignmentId, String(personnelId).toUpperCase()]
  );

  return result.rows[0] || null;
}

module.exports = {
  addEvidence,
  listForAssignment,
  listForAssignments,
  listForReport,
  listForReports,
  countByPhase,
  deleteAfterForAssignment,
  findOwned,
  deleteOwned,
};

const { pool } = require('../../config/db');
const { categoryFor } = require('../../shared/historyActions');

async function findAll() {
  const result = await pool.query(`
    SELECT *
    FROM report_histories
    ORDER BY timestamp DESC
  `);

  return result.rows;
}

async function findByReportId(reportId) {
  const result = await pool.query(
    `
    SELECT *
    FROM report_histories
    WHERE report_id = $1
    ORDER BY timestamp DESC
    `,
    [reportId]
  );

  return result.rows;
}

async function findByResidentId(residentId) {
  const result = await pool.query(
    `
    SELECT *
    FROM report_histories
    WHERE resident_id = $1
    ORDER BY timestamp DESC
    `,
    [residentId]
  );

  return result.rows;
}

/**
 * The reports whose current assignment cycle includes a revision request.
 *
 * `reports.personnel_note` cannot answer this on its own: the same column holds
 * ordinary assignment instructions and the administrator's revision feedback, so
 * a non-empty note on an in-progress report is not proof that anybody asked for
 * a redo. The audit trail is the authority. A revision only counts while it is
 * newer than the last assignment for that report, which is what makes the flag
 * mean "this assignment was sent back for revision" rather than "this report was
 * revised at some point in its life".
 *
 * Ordering uses `timestamp`, the column every writer populates. The companion
 * `created_at` column is null on existing rows because history inserts predate
 * it, so comparing against it would hide every real revision.
 */
async function findRevisionRequestedReportIds(reportIds, queryable = pool) {
  const ids = [...new Set(
    (Array.isArray(reportIds) ? reportIds : [])
      .filter(Boolean)
      .map((id) => String(id).trim())
      .filter(Boolean)
  )];
  if (ids.length === 0) return new Set();

  const result = await queryable.query(
    `
    SELECT DISTINCT revision.report_id
    FROM report_histories revision
    WHERE revision.report_id = ANY($1::text[])
      AND revision.action = 'REVISION_REQUESTED'
      AND revision.timestamp > COALESCE(
        (
          SELECT MAX(assignment.timestamp)
          FROM report_histories assignment
          WHERE assignment.report_id = revision.report_id
            AND assignment.action IN ('ASSIGNED', 'REASSIGNED')
        ),
        '-infinity'::timestamptz
      )
    `,
    [ids]
  );

  return new Set(result.rows.map((row) => row.report_id));
}

/**
 * The cleaning events that make up one task's timeline, grouped by report.
 *
 * Only the phases a cleaner and the reviewing administrator actually pass
 * through are returned. Assignment churn and report-status bookkeeping are left
 * out: they are audit entries, not steps of the work, and would bury the four or
 * five rows that describe what happened on site. Denials are never timeline
 * events either, which is why `DENIED` is absent rather than filtered by callers.
 *
 * `COMPLETED` here is the administrator's approval. The cleaner's own finish is
 * `CLEANING_COMPLETED`; the two share a word but not an author.
 *
 * Ordering uses `timestamp` for the same reason the revision lookup does:
 * `created_at` is null on the rows written before that column existed.
 */
const TASK_TIMELINE_ACTIONS = Object.freeze([
  'CLEANING_STARTED',
  'BEFORE_EVIDENCE_SUBMITTED',
  'AFTER_EVIDENCE_SUBMITTED',
  'CLEANING_COMPLETED',
  'REVISION_REQUESTED',
  'COMPLETED',
]);

async function findTaskTimelinesByReportIds(reportIds, queryable = pool) {
  const ids = [...new Set(
    (Array.isArray(reportIds) ? reportIds : [])
      .filter(Boolean)
      .map((id) => String(id).trim())
      .filter(Boolean)
  )];
  if (ids.length === 0) return new Map();

  const result = await queryable.query(
    `
    SELECT
      report_id,
      action,
      description,
      admin_id,
      timestamp
    FROM report_histories
    WHERE report_id = ANY($1::text[])
      AND action = ANY($2::text[])
      AND COALESCE(is_deleted, false) = false
    ORDER BY report_id ASC, timestamp ASC, id ASC
    `,
    [ids, TASK_TIMELINE_ACTIONS]
  );

  const timelines = new Map();
  for (const row of result.rows) {
    const event = {
      action: row.action,
      description: row.description || '',
      adminId: row.admin_id || null,
      timestamp: row.timestamp || null,
    };
    const events = timelines.get(row.report_id);
    if (events) {
      events.push(event);
    } else {
      timelines.set(row.report_id, [event]);
    }
  }

  return timelines;
}

/**
 * Records one history entry.
 *
 * The admin-facing columns are optional. A report-scoped row leaves them null and
 * keeps being attributed to the resident it concerns, exactly as before this
 * migration. A row with no report at all - an announcement, an account change -
 * supplies a subject instead, and its residentId may be null because there is no
 * resident to attribute it to.
 *
 * `category` is stored rather than derived because several action constants
 * straddle two admin tabs. See migration/sql/024-admin-history.sql.
 */
async function createHistory({
  residentId = null,
  reportId = null,
  action,
  oldStatus = null,
  newStatus = null,
  description = '',
  isDeleted = false,
  deletedAt = null,
  timestamp = null,
  adminId = null,
  category = null,
  subjectType = null,
  subjectId = null,
  subjectLabel = null,
}, queryable = pool) {
  // Callers that do not state a category still get one, derived from the action.
  // Doing it here means the existing call sites, which all predate this
  // migration, are categorised without being touched, and the fallback matches
  // what the clients apply to a row that somehow arrives uncategorised.
  const resolvedCategory = category || categoryFor(action);

  const result = await queryable.query(
    `
    INSERT INTO report_histories (
      resident_id,
      report_id,
      action,
      old_status,
      new_status,
      description,
      is_deleted,
      deleted_at,
      timestamp,
      admin_id,
      category,
      subject_type,
      subject_id,
      subject_label
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, COALESCE($9, NOW()),
      $10, $11, $12, $13, $14
    )
    RETURNING *
    `,
    [
      residentId,
      reportId,
      action,
      oldStatus,
      newStatus,
      description,
      isDeleted,
      deletedAt,
      timestamp,
      adminId,
      resolvedCategory,
      subjectType,
      subjectId,
      subjectLabel,
    ]
  );

  return result.rows[0];
}

async function softDelete(historyId) {
  const result = await pool.query(
    `
    UPDATE report_histories
    SET
      is_deleted = true,
      deleted_at = NOW(),
      updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [historyId]
  );

  return result.rows[0] || null;
}

async function restore(historyId) {
  const result = await pool.query(
    `
    UPDATE report_histories
    SET
      is_deleted = false,
      deleted_at = NULL,
      updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [historyId]
  );

  return result.rows[0] || null;
}

async function softDeleteForResident(historyId, residentId) {
  const result = await pool.query(
    `
    UPDATE report_histories
    SET
      is_deleted = true,
      deleted_at = NOW(),
      updated_at = NOW()
    WHERE id = $1
      AND resident_id = $2
    RETURNING *
    `,
    [historyId, residentId]
  );

  return result.rows[0] || null;
}

async function restoreForResident(historyId, residentId) {
  const result = await pool.query(
    `
    UPDATE report_histories
    SET
      is_deleted = false,
      deleted_at = NULL,
      updated_at = NOW()
    WHERE id = $1
      AND resident_id = $2
    RETURNING *
    `,
    [historyId, residentId]
  );

  return result.rows[0] || null;
}

async function deleteByIdForResident(historyId, residentId) {
  const result = await pool.query(
    `
    DELETE FROM report_histories
    WHERE id = $1
      AND resident_id = $2
    RETURNING *
    `,
    [historyId, residentId]
  );

  return result.rows[0] || null;
}

/**
 * The Admin app's audit feed: every decision, across every resident.
 *
 * Scoped to the active rows only. Trashed records are a separate view, so the
 * default feed must not carry them.
 *
 * The category filter is applied in SQL rather than by the client so a wide
 * feed is not shipped in full just to have most of it discarded. An absent or
 * empty category means All.
 */
async function findForAdmin({
  category = null,
  subjectType = null,
  reportId = null,
  search = null,
  from = null,
  to = null,
  limit = 200,
  offset = 0,
} = {}) {
  const params = [];
  const conditions = ['is_deleted = false'];

  const addParam = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  // An uncategorised row predates this feature and belongs under Reports, which
  // is the same fallback the clients apply. Matching it here keeps the SQL and
  // the UI agreeing on what the Reports tab contains.
  if (category) {
    const categoryParam = addParam(category);
    const reportsParam = addParam('REPORTS');
    conditions.push(
      `(category = ${categoryParam} OR (category IS NULL AND ${reportsParam} = 'REPORTS'))`
    );
  }

  if (subjectType) {
    conditions.push(`subject_type = ${addParam(subjectType)}`);
  }

  if (reportId) {
    conditions.push(`report_id = ${addParam(reportId)}`);
  }

  if (search) {
    const pattern = `%${String(search).toLowerCase()}%`;
    const patternParam = addParam(pattern);
    conditions.push(
      `(LOWER(COALESCE(action, '')) LIKE ${patternParam}`
      + ` OR LOWER(COALESCE(description, '')) LIKE ${patternParam}`
      + ` OR LOWER(COALESCE(report_id, '')) LIKE ${patternParam}`
      + ` OR LOWER(COALESCE(admin_id, '')) LIKE ${patternParam}`
      + ` OR LOWER(COALESCE(subject_label, '')) LIKE ${patternParam})`
    );
  }

  // Bounds are inclusive, matching the client-side window and the date picker,
  // which ends a custom range at 23:59:59.999 rather than at midnight.
  if (from) {
    conditions.push(`timestamp >= ${addParam(from)}`);
  }
  if (to) {
    conditions.push(`timestamp <= ${addParam(to)}`);
  }

  const limitParam = addParam(Math.max(1, Math.min(Number(limit) || 200, 500)));
  const offsetParam = addParam(Math.max(0, Number(offset) || 0));

  const result = await pool.query(
    `
    SELECT
      id AS history_id,
      resident_id,
      report_id,
      action,
      old_status,
      new_status,
      description,
      admin_id,
      category,
      subject_type,
      subject_id,
      subject_label,
      is_deleted,
      deleted_at,
      timestamp
    FROM report_histories
    WHERE ${conditions.join(' AND ')}
    ORDER BY timestamp DESC, id DESC
    LIMIT ${limitParam} OFFSET ${offsetParam}
    `,
    params
  );

  return result.rows;
}

/** Trashed history rows, for the Admin History trash tab. */
async function findTrashForAdmin({ limit = 200, offset = 0 } = {}) {
  const limitParam = Math.max(1, Math.min(Number(limit) || 200, 500));
  const offsetParam = Math.max(0, Number(offset) || 0);

  const result = await pool.query(
    `
    SELECT
      id AS history_id,
      resident_id,
      report_id,
      action,
      old_status,
      new_status,
      description,
      admin_id,
      category,
      subject_type,
      subject_id,
      subject_label,
      is_deleted,
      deleted_at,
      timestamp
    FROM report_histories
    WHERE is_deleted = true
    ORDER BY COALESCE(deleted_at, timestamp) DESC, id DESC
    LIMIT $1 OFFSET $2
    `,
    [limitParam, offsetParam]
  );

  return result.rows;
}

/**
 * Per-tab row counts for the pill labels.
 *
 * Returned as a full row rather than an object with a possibly-missing key, so a
 * tab can never render "undefined" because its bucket happened to be empty.
 * Uncategorised rows are reported under REPORTS, matching findForAdmin.
 */
async function countByCategoryForAdmin() {
  const result = await pool.query(
    `
    SELECT
      COALESCE(category, 'REPORTS') AS category,
      COUNT(*)::int AS total
    FROM report_histories
    WHERE is_deleted = false
    GROUP BY COALESCE(category, 'REPORTS')
    `
  );

  const counts = {
    REPORTS: 0,
    ASSIGNMENTS: 0,
    CLEANING: 0,
    ANNOUNCEMENTS: 0,
    ACCOUNT: 0,
  };

  for (const row of result.rows) {
    const key = String(row.category || 'REPORTS').toUpperCase();
    if (Object.prototype.hasOwnProperty.call(counts, key)) {
      counts[key] = row.total;
    }
  }

  counts.ALL = Object.values(counts).reduce((total, value) => total + value, 0);

  return counts;
}

/**
 * Trashes a history row identified by its server history_id.
 *
 * Scoped to the id alone rather than to a resident: an administrator manages the
 * audit trail, and an announcement or account record has no resident to match on.
 * The route layer restricts the caller to admins.
 */
async function softDeleteById(historyId) {
  const result = await pool.query(
    `
    UPDATE report_histories
    SET
      is_deleted = true,
      deleted_at = NOW(),
      updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [historyId]
  );

  return result.rows[0] || null;
}

/** Takes a trashed history row back into the active feed. */
async function restoreById(historyId) {
  const result = await pool.query(
    `
    UPDATE report_histories
    SET
      is_deleted = false,
      deleted_at = NULL,
      updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [historyId]
  );

  return result.rows[0] || null;
}

/** Destroys a history row for good. */
async function deleteById(historyId) {
  const result = await pool.query(
    `
    DELETE FROM report_histories
    WHERE id = $1
    RETURNING *
    `,
    [historyId]
  );

  return result.rows[0] || null;
}

module.exports = {
  findAll,
  findByReportId,
  findByResidentId,
  findRevisionRequestedReportIds,
  findTaskTimelinesByReportIds,
  findForAdmin,
  findTrashForAdmin,
  countByCategoryForAdmin,
  createHistory,
  softDelete,
  restore,
  softDeleteForResident,
  restoreForResident,
  deleteByIdForResident,
  softDeleteById,
  restoreById,
  deleteById,
};

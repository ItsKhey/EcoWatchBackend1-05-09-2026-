const { pool } = require('../../config/db');

/**
 * Stores the administrator's duplicate-review decisions.
 *
 * <p>One row per report covered by a decision. That granularity is the whole
 * point: a report that arrives later is unreviewed by construction, so the
 * group it joins is offered again. Storing the verdict against the group
 * instead made the review a one-shot event per location, which is exactly the
 * behaviour the feature must not have.
 */

async function recordDecision({
  reportIds,
  clusterId,
  decision,
  deniedReportIds = [],
  adminId = null,
  queryable = pool,
}) {
  const ids = (reportIds || []).map((id) => String(id || '').trim()).filter(Boolean);
  if (ids.length === 0) return [];

  const denied = (deniedReportIds || []).map((id) => String(id || '').trim()).filter(Boolean);

  const result = await queryable.query(
    `
    INSERT INTO report_duplicate_reviews (
      report_id, cluster_id, decision, denied_report_ids, admin_id
    )
    SELECT unnest($1::text[]), $2, $3, $4::text[], $5
    RETURNING review_id, report_id, cluster_id, decision, denied_report_ids, admin_id, created_at
    `,
    [ids, clusterId, decision, denied, adminId]
  );

  return result.rows;
}

async function findByClusterId(clusterId, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT review_id, report_id, cluster_id, decision, denied_report_ids, admin_id, created_at
    FROM report_duplicate_reviews
    WHERE cluster_id = $1
    ORDER BY created_at DESC
    `,
    [clusterId]
  );

  return result.rows;
}

async function findByReportId(reportId, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT review_id, report_id, cluster_id, decision, denied_report_ids, admin_id, created_at
    FROM report_duplicate_reviews
    WHERE report_id = $1
    ORDER BY created_at DESC
    `,
    [reportId]
  );

  return result.rows;
}

module.exports = {
  recordDecision,
  findByClusterId,
  findByReportId,
};
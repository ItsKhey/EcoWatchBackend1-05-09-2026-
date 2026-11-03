const test = require('node:test');
const assert = require('node:assert/strict');

const clusterRepository = require('../src/modules/reports/clusterRepository');

/**
 * The clone scan is open-work only: Denied and Completed reports are excluded.
 *
 * <p>Denied means the report was reviewed and rejected, so it cannot be the
 * original that a later submission clones. Completed means the waste has
 * already been cleared, so a warning about it would ask the resident to decide
 * about finished work. Every open status - Pending, In Progress and Under
 * Review - still stays in the scan.
 *
 * <p>The lookups accept a `queryable`, so the emitted SQL can be asserted
 * without a database.
 */

/** Captures every SQL a lookup sends, so all of them can be asserted on. */
const createCapturingQueryable = (rows = []) => {
  const captured = { queries: [] };
  return {
    captured,
    async query(sql, params) {
      captured.queries.push({ sql, params });
      return { rows };
    },
  };
};

/** Every SQL text a lookup sent, joined, for asserting a whole query sequence. */
const allSql = (queryable) => queryable.captured.queries.map((q) => q.sql).join('\n');

/** Asserts a query excludes Denied and Completed and keeps every open status. */
const assertTerminalStatusExcluded = (sql) => {
  assert.match(sql, /COALESCE\s*\(\s*r\.status\s*,\s*''\s*\)/i);
  assert.match(sql, /NOT\s+IN\s*\(\s*'denied'\s*,\s*'completed'\s*\)/i);
  assert.doesNotMatch(sql, /IS DISTINCT FROM 'Completed'/i);
  assert.doesNotMatch(sql, /status\s+IN\s*\(\s*'Pending'/i);
};

/** Asserts the admin queue allows Pending through Under Review only. */
const assertAdminOpenStatusFilter = (sql) => {
  assert.match(sql, /COALESCE\s*\(\s*r\.status\s*,\s*''\s*\)/i);
  assert.match(sql, /IN\s*\(\s*'pending'\s*,\s*'in progress'\s*,\s*'under review'\s*\)/i);
};

test('the single-cluster scan excludes Denied and Completed reports', async () => {
  const queryable = createCapturingQueryable();
  await clusterRepository.findNearbyActiveCluster(7.8321, 125.0176, 10, queryable);

  const sql = queryable.captured.queries[0].sql;
  assert.match(sql, /EXISTS/i);
  assertTerminalStatusExcluded(sql);
});

test('the terminal-status filter sits inside the EXISTS, not only in a count', async () => {
  const queryable = createCapturingQueryable();
  await clusterRepository.findNearbyActiveCluster(7.8321, 125.0176, 10, queryable);

  const sql = queryable.captured.queries[0].sql;
  // The count alone is not enough: a cluster whose only reports are Denied or
  // Completed counts zero but would still be returned as "a report already
  // exists here".
  const existsBlock = sql.slice(
    sql.search(/EXISTS/i),
    sql.search(/ORDER BY distance_meters/i)
  );
  assertTerminalStatusExcluded(existsBlock);
});

test('the terminal-status filter is applied before the radius cut-off', async () => {
  const queryable = createCapturingQueryable();
  await clusterRepository.findNearbyActiveCluster(7.8321, 125.0176, 10, queryable);

  // If the filter came after LIMIT 1, a fully Denied or Completed cluster could
  // still win the row and hide a live one that is just further away.
  const sql = queryable.captured.queries[0].sql;
  const existsAt = sql.search(/EXISTS/i);
  const limitAt = sql.search(/LIMIT 1/i);
  assert.ok(existsAt > -1 && limitAt > -1);
  assert.ok(existsAt < limitAt, 'EXISTS filter must precede LIMIT 1');
});

test('the duplicate hand-off counts and previews open statuses only', async () => {
  const queryable = createCapturingQueryable([
    {
      cluster_id: 'CL-123456',
      center_latitude: 7.8321,
      center_longitude: 125.0176,
      status: 'Pending',
      created_at: '2026-10-09T00:00:00.000Z',
      updated_at: '2026-10-09T00:00:00.000Z',
      last_activity_at: '2026-10-09T00:06:00.000Z',
      distance_meters: 1.1,
    },
  ]);

  await clusterRepository.getNearbyClusterWithPreview(7.8321, 125.0176, 10, queryable);

  // Report count and preview report are separate round trips. Both must use the
  // same rule, or the sheet would say "1 report" and show nothing.
  const sql = allSql(queryable);
  assertTerminalStatusExcluded(sql);

  const previewQuery = queryable.captured.queries.find((q) => /report_id, r\.created_at/i.test(q.sql));
  assert.ok(previewQuery, 'the preview report lookup runs');
  assertTerminalStatusExcluded(previewQuery.sql);
});

test('the admin duplicate review keeps only Pending through Under Review', async () => {
  const queryable = createCapturingQueryable();
  await clusterRepository.findPossibleDuplicateGroups(queryable);

  const sql = queryable.captured.queries[0].sql;
  assertAdminOpenStatusFilter(sql);
  // A stale cluster status must not hide a real clone.
  assert.doesNotMatch(sql, /c\.status\s+IN/i);
  assert.match(sql, /COUNT\(r\.report_id\)\s*>=\s*2/i);
});

test('a cluster with only Denied or Completed reports is not offered to the resident', async () => {
  // The EXISTS is what makes this true: the query returns no cluster once no
  // open report is left underneath it.
  const queryable = createCapturingQueryable([]);

  const cluster = await clusterRepository.getNearbyClusterWithPreview(7.8321, 125.0176, 10, queryable);
  assert.equal(cluster, null);
  assertTerminalStatusExcluded(queryable.captured.queries[0].sql);
});

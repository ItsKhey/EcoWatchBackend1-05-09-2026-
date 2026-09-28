const test = require('node:test');
const assert = require('node:assert/strict');

const clusterRepository = require('../repositories/clusterRepository');

/**
 * Cluster matching is coordinate-based, so a cluster row that outlives its
 * reports (a hard delete leaves the row behind) would keep capturing every
 * future submission at that spot. These cases pin the requirement that only
 * clusters holding at least one active report are offered to a resident.
 *
 * The lookups accept a `queryable`, so the emitted SQL can be asserted without a
 * database.
 */

/** Captures the SQL each lookup sends so it can be asserted on. */
const createCapturingQueryable = (rows) => {
  const captured = { sql: null, params: null };
  return {
    captured,
    async query(sql, params) {
      captured.sql = sql;
      captured.params = params;
      return { rows };
    },
  };
};

test('nearby cluster lookup ignores clusters with no active reports', async () => {
  const queryable = createCapturingQueryable([]);
  await clusterRepository.findNearbyActiveCluster(7.8321, 125.0176, 10, queryable);

  assert.match(queryable.captured.sql, /EXISTS/i);
  assert.match(queryable.captured.sql, /r\.is_deleted\s*=\s*false/i);
  assert.match(queryable.captured.sql, /r\.is_archived\s*=\s*false/i);
  assert.match(queryable.captured.sql, /r\.cluster_id\s*=\s*c\.cluster_id/i);
});

test('all-clusters lookup applies the same non-empty rule', async () => {
  const queryable = createCapturingQueryable([]);
  await clusterRepository.findNearbyActiveClusters(7.8321, 125.0176, 10, queryable);

  assert.match(queryable.captured.sql, /EXISTS/i);
  assert.match(queryable.captured.sql, /r\.is_archived\s*=\s*false/i);
});

test('the non-empty rule is applied before the radius cut-off', async () => {
  const queryable = createCapturingQueryable([]);
  await clusterRepository.findNearbyActiveCluster(7.8321, 125.0176, 10, queryable);

  // If the filter came after LIMIT 1, an empty cluster could still win the row
  // and hide a populated one that is just further away.
  const existsAt = queryable.captured.sql.search(/EXISTS/i);
  const limitAt = queryable.captured.sql.search(/LIMIT 1/i);
  assert.ok(existsAt > -1 && limitAt > -1);
  assert.ok(existsAt < limitAt, 'EXISTS filter must precede LIMIT 1');
});

test('a report beyond the radius is not offered', async () => {
  const queryable = createCapturingQueryable([
    {
      cluster_id: 'CL-999999',
      center_latitude: 7.84,
      center_longitude: 125.03,
      status: 'Pending',
      created_at: '2026-09-28T03:00:00.000Z',
      updated_at: '2026-09-28T03:00:00.000Z',
      last_activity_at: '2026-09-28T03:00:00.000Z',
      distance_meters: 4200.5,
    },
  ]);

  const result = await clusterRepository.findNearbyActiveCluster(7.8321, 125.0176, 10, queryable);

  assert.equal(result, null);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const historyRepository = require('../src/modules/history/historyRepository');

/**
 * The personnel card expands one task into its cleaning events, so the lookup
 * must return the phases of the work in the order they happened, grouped by
 * report. The query accepts a `queryable`, which lets these cases assert the
 * emitted SQL and the grouping without a database.
 */

const createCapturingQueryable = (rows = []) => {
  const captured = { sql: null, params: null, calls: 0 };
  return {
    captured,
    async query(sql, params) {
      captured.calls += 1;
      captured.sql = sql;
      captured.params = params;
      return { rows };
    },
  };
};

test('timeline query asks only for cleaning phases and live rows', async () => {
  const queryable = createCapturingQueryable([]);
  await historyRepository.findTaskTimelinesByReportIds(['REP-1'], queryable);

  assert.match(queryable.captured.sql, /report_id = ANY/i);
  assert.match(queryable.captured.sql, /COALESCE\(is_deleted, false\) = false/i);
  assert.match(queryable.captured.sql, /ORDER BY report_id ASC, timestamp ASC/i);

  const actions = queryable.captured.params[1];
  assert.ok(actions.includes('CLEANING_STARTED'));
  assert.ok(actions.includes('BEFORE_EVIDENCE_SUBMITTED'));
  assert.ok(actions.includes('AFTER_EVIDENCE_SUBMITTED'));
  assert.ok(actions.includes('CLEANING_COMPLETED'));
  assert.ok(actions.includes('REVISION_REQUESTED'));
  assert.ok(actions.includes('COMPLETED'));
  // A denial is not a step of the work, and the card is filtered out anyway.
  assert.ok(!actions.includes('DENIED'));
});

test('events are grouped by report and keep the server order', async () => {
  const queryable = createCapturingQueryable([
    {
      report_id: 'REP-1',
      action: 'CLEANING_STARTED',
      description: 'started',
      admin_id: null,
      timestamp: '2026-11-02T15:37:33.003Z',
    },
    {
      report_id: 'REP-1',
      action: 'REVISION_REQUESTED',
      description: 'revise',
      admin_id: 'ADM-1',
      timestamp: '2026-11-02T15:38:10.737Z',
    },
    {
      report_id: 'REP-2',
      action: 'COMPLETED',
      description: 'approved',
      admin_id: 'ADM-1',
      timestamp: '2026-11-02T15:39:00.000Z',
    },
  ]);

  const timelines = await historyRepository.findTaskTimelinesByReportIds(
    ['REP-1', 'REP-2'],
    queryable
  );

  assert.equal(timelines.size, 2);
  assert.deepEqual(
    timelines.get('REP-1').map((event) => event.action),
    ['CLEANING_STARTED', 'REVISION_REQUESTED']
  );
  assert.equal(timelines.get('REP-1')[1].adminId, 'ADM-1');
  assert.equal(timelines.get('REP-1')[0].adminId, null);
  assert.deepEqual(
    timelines.get('REP-2').map((event) => event.action),
    ['COMPLETED']
  );
});

test('report ids are trimmed and deduplicated before the query', async () => {
  const queryable = createCapturingQueryable([]);
  await historyRepository.findTaskTimelinesByReportIds(
    [' REP-1 ', 'REP-1', '', null],
    queryable
  );

  assert.deepEqual(queryable.captured.params[0], ['REP-1']);
});

test('an empty page does not query at all', async () => {
  const queryable = createCapturingQueryable([]);
  const timelines = await historyRepository.findTaskTimelinesByReportIds([], queryable);

  assert.equal(timelines.size, 0);
  assert.equal(queryable.captured.calls, 0);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../src/config/db');
const adminController = require('../src/modules/admin/adminController');
const reportRepository = require('../src/modules/reports/reportRepository');
const { tablesFor } = require('../src/shared/notificationTables');

const ADMIN_ID = 'ADM-DUPREVIEW';
const RESIDENT_A = 'RES-DUPREVIEW-A';
const RESIDENT_B = 'RES-DUPREVIEW-B';
const GROUP_ID = 'CL-DUPREVIEW';

/** The API scopes every review group to one waste scale inside a location. */
const reviewGroupId = (clusterId, scaleKey = 'small') => `${clusterId}::${scaleKey}`;

/**
 * Guards the duplicate-review contract the admin UI depends on:
 *
 *  - only groups with two or more active reports are offered for review
 *  - a confirmed duplicate denies just the reports the admin picked, leaves the
 *    original alone, writes an audit row, and notifies the reporter
 *  - "not a duplicate" changes no report state, only records the decision and
 *    removes the wrapper from the review list
 *  - the denied report is never deleted
 */
const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

const run = async (handler, groupId, body) => {
  const res = createResponse();
  let forwarded = null;
  await handler(
    {
      requestId: 'test-duplicate-review',
      params: { groupId },
      body,
      admin: { admin_id: ADMIN_ID, role: 'ADMIN' },
    },
    res,
    (error) => {
      forwarded = error;
    }
  );
  return forwarded ? { error: forwarded } : { res };
};

const listGroups = async () => run(adminController.getPossibleDuplicates);

const seed = async () => {
  await pool.query(
    `INSERT INTO admins (admin_id, first_name, last_name, username, email,
        password_hash, role)
     VALUES ($1, 'Dup', 'Admin', $1, $1, 'not-a-real-hash', 'ADMIN')
     ON CONFLICT (admin_id) DO UPDATE SET role = 'ADMIN'`,
    [ADMIN_ID]
  );

  for (const residentId of [RESIDENT_A, RESIDENT_B]) {
    await pool.query(
      `INSERT INTO residents (resident_id, first_name, last_name, username, email,
          password_hash, role, status, is_verified)
       VALUES ($1, 'Dup', 'Tester', $1, $1, 'not-a-real-hash', 'RESIDENT', 'AVAILABLE', true)
       ON CONFLICT (resident_id) DO NOTHING`,
      [residentId]
    );
  }

  await pool.query(
    `INSERT INTO report_clusters (cluster_id, center_latitude, center_longitude, status)
     VALUES ($1, 14.6100, 120.9800, 'Pending')
     ON CONFLICT (cluster_id) DO NOTHING`,
    [GROUP_ID]
  );

  // Two reports seconds apart at the same spot: the near-identical case the
  // review exists for. The first is the original.
  const base = Date.now() - 120000;
  await reportRepository.createReport({
    reportId: 'REP-DUP-ORIGINAL',
    residentId: RESIDENT_A,
    title: 'Waste pile by the gate',
    category: 'Recyclable',
    description: 'Duplicate review fixture, original report',
    latitude: 14.6100,
    longitude: 120.9800,
    imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
    clusterId: GROUP_ID,
    createdAt: new Date(base),
  });

  await reportRepository.createReport({
    reportId: 'REP-DUP-SECOND',
    residentId: RESIDENT_B,
    title: 'Waste pile by the gate',
    category: 'Recyclable',
    description: 'Duplicate review fixture, second report',
    latitude: 14.6100,
    longitude: 120.9800,
    imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
    clusterId: GROUP_ID,
    createdAt: new Date(base + 18000),
  });
};

const notificationsTableFor = (residentId) => tablesFor(residentId).notifications;

const cleanup = async () => {
  for (const residentId of [RESIDENT_A, RESIDENT_B]) {
    await pool.query(
      `DELETE FROM ${notificationsTableFor(residentId)} WHERE report_id LIKE 'REP-DUP-%'`
    );
  }
  await pool.query(
    `DELETE FROM report_duplicate_reviews WHERE cluster_id LIKE 'CL-DUPREVIEW%'`
  );
  await pool.query(`DELETE FROM report_histories WHERE report_id LIKE 'REP-DUP-%'`);
  await pool.query(`DELETE FROM reports WHERE cluster_id = $1`, [GROUP_ID]);
  await pool.query(`DELETE FROM report_clusters WHERE cluster_id = $1`, [GROUP_ID]);
  await pool.query(`DELETE FROM residents WHERE resident_id = ANY($1)`, [
    [RESIDENT_A, RESIDENT_B],
  ]);
  await pool.query(`DELETE FROM admins WHERE admin_id = $1`, [ADMIN_ID]);
};

const statusOf = async (reportId) => {
  const result = await pool.query(
    `SELECT status, is_deleted FROM reports WHERE report_id = $1`,
    [reportId]
  );
  return result.rows[0];
};

test.before(async () => { await cleanup(); await seed(); });
test.after(async () => { await cleanup(); });

test('a group of two active reports is offered for duplicate review', async () => {
  const { res, error } = await listGroups();

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  const group = res.body.groups.find(
    (entry) => entry.groupId === reviewGroupId(GROUP_ID)
  );
  assert.ok(group, 'the seeded group must be listed');
  assert.equal(group.reports.length, 2);
  assert.equal(group.wasteScale, 'Small-Scale Waste');
  // The response must not leak the internal grouping to the UI as cluster terms.
  assert.equal(group.spotCount, undefined);
});

test('one location is offered as one review group per waste scale', async () => {
  const clusterId = 'CL-DUPREVIEW-SCALE';
  await pool.query(
    `INSERT INTO report_clusters (cluster_id, center_latitude, center_longitude, status)
     VALUES ($1, 14.6200, 120.9750, 'Pending')
     ON CONFLICT (cluster_id) DO NOTHING`,
    [clusterId]
  );

  const base = Date.now() - 6 * 24 * 60 * 60 * 1000;
  const fixtures = [
    ['REP-SCALE-SMALL-OLD', 'Small-Scale Waste', RESIDENT_A, base],
    ['REP-SCALE-SMALL-NEW', 'Small-Scale Waste', RESIDENT_B, base + 2 * 24 * 60 * 60 * 1000],
    ['REP-SCALE-MEDIUM-OLD', 'Medium-Scale Waste', RESIDENT_A, base + 24 * 60 * 60 * 1000],
    ['REP-SCALE-MEDIUM-NEW', 'Medium-Scale Waste', RESIDENT_B, base + 4 * 24 * 60 * 60 * 1000],
  ];

  for (const [reportId, wasteScale, residentId, createdAt] of fixtures) {
    await reportRepository.createReport({
      reportId,
      residentId,
      title: 'Scale-split fixture',
      category: 'Mixed',
      description: 'Same spot, different waste scales',
      latitude: 14.6200,
      longitude: 120.9750,
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
      clusterId,
      wasteScale,
    });
    // createReport does not take a createdAt, so stamp it explicitly to make
    // the oldest-first assertion independent of insert timing.
    await pool.query(
      `UPDATE reports SET created_at = $2 WHERE report_id = $1`,
      [reportId, new Date(createdAt)]
    );
  }

  try {
    const { res, error } = await listGroups();
    assert.equal(error, undefined, `unexpected error: ${error && error.message}`);

    const small = res.body.groups.find(
      (entry) => entry.groupId === reviewGroupId(clusterId, 'small')
    );
    const medium = res.body.groups.find(
      (entry) => entry.groupId === reviewGroupId(clusterId, 'medium')
    );

    assert.ok(small, 'small reports at the spot must form their own group');
    assert.ok(medium, 'medium reports at the spot must form their own group');
    assert.equal(small.reports.length, 2);
    assert.equal(medium.reports.length, 2);
    assert.equal(small.wasteScale, 'Small-Scale Waste');
    assert.equal(medium.wasteScale, 'Medium-Scale Waste');
    assert.equal(
      small.reports.every((report) => report.waste_scale === 'Small-Scale Waste'),
      true,
      'a group must never mix scales'
    );
    assert.equal(
      medium.reports.every((report) => report.waste_scale === 'Medium-Scale Waste'),
      true,
      'a group must never mix scales'
    );

    // Days apart, same scale: still one group, oldest first.
    assert.equal(small.reports[0].report_id, 'REP-SCALE-SMALL-OLD');
    assert.equal(medium.reports[0].report_id, 'REP-SCALE-MEDIUM-OLD');

    // A scale with only one report is not a clone pair.
    assert.equal(
      res.body.groups.some(
        (entry) => entry.groupId === reviewGroupId(clusterId, 'large')
      ),
      false
    );
  } finally {
    await pool.query(`DELETE FROM reports WHERE cluster_id = $1`, [clusterId]);
    await pool.query(`DELETE FROM report_clusters WHERE cluster_id = $1`, [clusterId]);
  }
});

test('accepting one waste scale leaves the other scale in review', async () => {
  const clusterId = 'CL-DUPREVIEW-SCALE-ACCEPT';
  await pool.query(
    `INSERT INTO report_clusters (cluster_id, center_latitude, center_longitude, status)
     VALUES ($1, 14.6250, 120.9720, 'Pending')
     ON CONFLICT (cluster_id) DO NOTHING`,
    [clusterId]
  );

  const base = Date.now() - 4 * 24 * 60 * 60 * 1000;
  const fixtures = [
    ['REP-SCALE-A-SMALL-1', 'Small-Scale Waste', RESIDENT_A, base],
    ['REP-SCALE-A-SMALL-2', 'Small-Scale Waste', RESIDENT_B, base + 3600000],
    ['REP-SCALE-A-MEDIUM-1', 'Medium-Scale Waste', RESIDENT_A, base + 86400000],
    ['REP-SCALE-A-MEDIUM-2', 'Medium-Scale Waste', RESIDENT_B, base + 90000000],
  ];

  for (const [reportId, wasteScale, residentId, createdAt] of fixtures) {
    await reportRepository.createReport({
      reportId,
      residentId,
      title: 'Scale-accept fixture',
      category: 'Mixed',
      description: 'Same spot, different waste scales',
      latitude: 14.6250,
      longitude: 120.9720,
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
      clusterId,
      wasteScale,
      createdAt: new Date(createdAt),
    });
  }

  try {
    const accepted = await run(
      adminController.markNotDuplicates,
      reviewGroupId(clusterId, 'small'),
      {}
    );
    assert.equal(accepted.error, undefined,
      `unexpected error: ${accepted.error && accepted.error.message}`);

    const { res, error } = await listGroups();
    assert.equal(error, undefined, `unexpected error: ${error && error.message}`);

    assert.equal(
      res.body.groups.some(
        (entry) => entry.groupId === reviewGroupId(clusterId, 'small')
      ),
      false,
      'the reviewed scale must leave the queue'
    );

    const medium = res.body.groups.find(
      (entry) => entry.groupId === reviewGroupId(clusterId, 'medium')
    );
    assert.ok(medium, 'the other scale must still be offered for review');
    assert.equal(medium.reports.length, 2);

    // No report state changed, and only the small reports were marked reviewed.
    const reviewed = await pool.query(
      `SELECT report_id FROM report_duplicate_reviews WHERE cluster_id = $1
       ORDER BY report_id`,
      [clusterId]
    );
    assert.deepEqual(
      reviewed.rows.map((row) => row.report_id),
      ['REP-SCALE-A-SMALL-1', 'REP-SCALE-A-SMALL-2']
    );
  } finally {
    await pool.query(
      `DELETE FROM report_duplicate_reviews WHERE cluster_id = $1`, [clusterId]
    );
    await pool.query(`DELETE FROM report_histories WHERE report_id LIKE 'REP-SCALE-A-%'`);
    await pool.query(`DELETE FROM reports WHERE cluster_id = $1`, [clusterId]);
    await pool.query(`DELETE FROM report_clusters WHERE cluster_id = $1`, [clusterId]);
  }
});

test('denying one waste scale rejects reports from another scale', async () => {
  const clusterId = 'CL-DUPREVIEW-SCALE-DENY';
  await pool.query(
    `INSERT INTO report_clusters (cluster_id, center_latitude, center_longitude, status)
     VALUES ($1, 14.6280, 120.9680, 'Pending')
     ON CONFLICT (cluster_id) DO NOTHING`,
    [clusterId]
  );

  const base = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const fixtures = [
    ['REP-SCALE-D-SMALL-1', 'Small-Scale Waste', RESIDENT_A, base],
    ['REP-SCALE-D-SMALL-2', 'Small-Scale Waste', RESIDENT_B, base + 3600000],
    ['REP-SCALE-D-MEDIUM-1', 'Medium-Scale Waste', RESIDENT_A, base + 86400000],
    ['REP-SCALE-D-MEDIUM-2', 'Medium-Scale Waste', RESIDENT_B, base + 90000000],
  ];

  for (const [reportId, wasteScale, residentId, createdAt] of fixtures) {
    await reportRepository.createReport({
      reportId,
      residentId,
      title: 'Scale-deny fixture',
      category: 'Mixed',
      description: 'Same spot, different waste scales',
      latitude: 14.6280,
      longitude: 120.9680,
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
      clusterId,
      wasteScale,
      createdAt: new Date(createdAt),
    });
  }

  try {
    const foreign = await run(
      adminController.confirmDuplicateReports,
      reviewGroupId(clusterId, 'small'),
      { reportIds: ['REP-SCALE-D-MEDIUM-1'] }
    );
    assert.ok(foreign.error, 'a report filed under another scale must be rejected');
    assert.equal(foreign.error.statusCode, 400);

    const denied = await run(
      adminController.confirmDuplicateReports,
      reviewGroupId(clusterId, 'medium'),
      { reportIds: ['REP-SCALE-D-MEDIUM-2'] }
    );
    assert.equal(denied.error, undefined,
      `unexpected error: ${denied.error && denied.error.message}`);

    assert.equal((await statusOf('REP-SCALE-D-MEDIUM-2')).status, 'Denied');
    assert.equal((await statusOf('REP-SCALE-D-SMALL-1')).status, 'Pending');
    assert.equal((await statusOf('REP-SCALE-D-SMALL-2')).status, 'Pending');

    const { res } = await listGroups();
    const small = res.body.groups.find(
      (entry) => entry.groupId === reviewGroupId(clusterId, 'small')
    );
    assert.ok(small, 'the untouched scale must still be offered');
    assert.equal(small.reports.length, 2);
  } finally {
    for (const residentId of [RESIDENT_A, RESIDENT_B]) {
      await pool.query(
        `DELETE FROM ${notificationsTableFor(residentId)} WHERE report_id LIKE 'REP-SCALE-D-%'`
      );
    }
    await pool.query(
      `DELETE FROM report_duplicate_reviews WHERE cluster_id = $1`, [clusterId]
    );
    await pool.query(`DELETE FROM report_histories WHERE report_id LIKE 'REP-SCALE-D-%'`);
    await pool.query(`DELETE FROM reports WHERE cluster_id = $1`, [clusterId]);
    await pool.query(`DELETE FROM report_clusters WHERE cluster_id = $1`, [clusterId]);
  }
});

test('a single-report group is never offered for review', async () => {
  const soloClusterId = 'CL-DUPREVIEW-SOLO';
  await pool.query(
    `INSERT INTO report_clusters (cluster_id, center_latitude, center_longitude, status)
     VALUES ($1, 14.6300, 120.9700, 'Pending')
     ON CONFLICT (cluster_id) DO NOTHING`,
    [soloClusterId]
  );
  await reportRepository.createReport({
    reportId: 'REP-DUP-SOLO',
    residentId: RESIDENT_A,
    title: 'Single report',
    category: 'Organic',
    description: 'Duplicate review fixture, single report',
    latitude: 14.6300,
    longitude: 120.9700,
    imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
    clusterId: soloClusterId,
    createdAt: new Date(),
  });

  try {
    const { res, error } = await listGroups();
    assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
    assert.equal(
      res.body.groups.some(
        (entry) => entry.groupId === reviewGroupId(soloClusterId)
      ),
      false,
      'one report cannot be a duplicate of itself'
    );
  } finally {
    await pool.query(`DELETE FROM reports WHERE cluster_id = $1`, [soloClusterId]);
    await pool.query(`DELETE FROM report_clusters WHERE cluster_id = $1`, [soloClusterId]);
  }
});

test('confirming a duplicate denies only the picked report and keeps the original', async () => {
  const { res, error } = await run(adminController.confirmDuplicateReports, 
    GROUP_ID,
    { reportIds: ['REP-DUP-SECOND'] }
  );

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.deniedReports, ['REP-DUP-SECOND']);

  const denied = await statusOf('REP-DUP-SECOND');
  assert.equal(denied.status, 'Denied');
  // Preserved, never deleted: the row is the audit trail.
  assert.equal(denied.is_deleted, false);

  const original = await statusOf('REP-DUP-ORIGINAL');
  assert.equal(original.status, 'Pending', 'the original report stays active');

  const history = await pool.query(
    `SELECT action, old_status, new_status, description
       FROM report_histories WHERE report_id = 'REP-DUP-SECOND'
       ORDER BY timestamp DESC`
  );
  const decision = history.rows.find((row) => row.action === 'DUPLICATE_CONFIRMED');
  assert.ok(decision, 'the administrator decision must be auditable');
  assert.equal(decision.new_status, 'Denied');
  assert.match(decision.description, /duplicate/i);

  const notifications = await pool.query(
    `SELECT title, message, type
       FROM ${notificationsTableFor(RESIDENT_B)} WHERE report_id = 'REP-DUP-SECOND'`
  );
  assert.equal(notifications.rows.length >= 1, true, 'the reporter must be told');
  const notice = notifications.rows[0];
  assert.equal(notice.title, 'Report Update');
  assert.match(notice.message, /duplicate/i);
  assert.doesNotMatch(notice.message, /rejected/i);
});

test('a confirmed-duplicate group leaves the review list', async () => {
  const { res, error } = await listGroups();
  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  assert.equal(
    res.body.groups.some((entry) => entry.groupId === reviewGroupId(GROUP_ID)),
    false,
    'the group was already reviewed'
  );
});

test('accepting records the decision, unwraps the group and changes nothing', async () => {
  const groupId = 'CL-DUPREVIEW-ACCEPT';
  await pool.query(
    `INSERT INTO report_clusters (cluster_id, center_latitude, center_longitude, status)
     VALUES ($1, 14.6400, 120.9600, 'Pending')
     ON CONFLICT (cluster_id) DO NOTHING`,
    [groupId]
  );
  const base = Date.now() - 90000;
  for (const [suffix, residentId] of [['ONE', RESIDENT_A], ['TWO', RESIDENT_B]]) {
    await reportRepository.createReport({
      reportId: `REP-DUP-ACCEPT-${suffix}`,
      residentId,
      title: 'Separate incident',
      category: 'Mixed',
      description: 'Duplicate review fixture, accept case',
      latitude: 14.6400,
      longitude: 120.9600,
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
      clusterId: groupId,
      createdAt: new Date(base),
    });
  }

  try {
    const before = await statusOf('REP-DUP-ACCEPT-ONE');
    const { res, error } = await run(adminController.markNotDuplicates,
      reviewGroupId(groupId),
      {}
    );
    assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
    assert.equal(res.body.success, true);

    // No report state changed: both stay ordinary individual reports.
    assert.equal((await statusOf('REP-DUP-ACCEPT-ONE')).status, before.status);
    assert.equal((await statusOf('REP-DUP-ACCEPT-TWO')).status, 'Pending');

    // The decision is on the record.
    const history = await pool.query(
      `SELECT action FROM report_histories WHERE report_id LIKE 'REP-DUP-ACCEPT-%'`
    );
    assert.equal(
      history.rows.filter((row) => row.action === 'NOT_DUPLICATE').length >= 2,
      true,
      'both reports keep an audit row for the decision'
    );

    // And the wrapper is gone, so the reports read as ordinary list rows.
    const listed = await listGroups();
    assert.equal(
      listed.res.body.groups.some(
        (entry) => entry.groupId === reviewGroupId(groupId)
      ),
      false
    );
  } finally {
    await pool.query(`DELETE FROM report_histories WHERE report_id LIKE 'REP-DUP-ACCEPT-%'`);
    await pool.query(`DELETE FROM reports WHERE cluster_id = $1`, [groupId]);
    await pool.query(`DELETE FROM report_clusters WHERE cluster_id = $1`, [groupId]);
  }
});

test('denying requires at least one report and rejects a report from another group', async () => {
  const empty = await run(adminController.confirmDuplicateReports, GROUP_ID, {
    reportIds: [],
  });
  assert.ok(empty.error, 'an empty selection must be rejected');
  assert.equal(empty.error.statusCode, 400);

  const foreign = await run(adminController.confirmDuplicateReports, GROUP_ID, {
    reportIds: ['REP-NOT-IN-GROUP'],
  });
  assert.ok(foreign.error, 'a report outside the group must be rejected');
  assert.equal(foreign.error.statusCode, 400);
});

/**
 * The regression that made the card appear to work exactly once.
 *
 * <p>When the verdict was stored on the cluster, the first review at a spot
 * retired that location permanently: the original report stayed active and
 * invisible, a new report arriving at the same place joined the same cluster,
 * and the group was filtered out for good. Both decisions below must therefore
 * let the next report re-open the group.
 */
test('a new report at a previously reviewed spot is offered again', async () => {
  const groupId = 'CL-DUPREVIEW-REPEAT';
  await pool.query(
    `INSERT INTO report_clusters (cluster_id, center_latitude, center_longitude, status)
     VALUES ($1, 14.6500, 120.9500, 'Pending')
     ON CONFLICT (cluster_id) DO NOTHING`,
    [groupId]
  );
  const base = Date.now() - 300000;
  await reportRepository.createReport({
    reportId: 'REP-REPEAT-ONE',
    residentId: RESIDENT_A,
    title: 'First report',
    category: 'Organic',
    description: 'Repeat-review fixture, first',
    latitude: 14.6500,
    longitude: 120.9500,
    imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
    clusterId: groupId,
    createdAt: new Date(base),
  });
  await reportRepository.createReport({
    reportId: 'REP-REPEAT-TWO',
    residentId: RESIDENT_B,
    title: 'Second report',
    category: 'Organic',
    description: 'Repeat-review fixture, second',
    latitude: 14.6500,
    longitude: 120.9500,
    imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
    clusterId: groupId,
    createdAt: new Date(base + 60000),
  });

  try {
    // Confirmed not duplicates: the group leaves the review list.
    const accepted = await run(
      adminController.markNotDuplicates,
      reviewGroupId(groupId),
      {}
    );
    assert.equal(accepted.error, undefined,
      `unexpected error: ${accepted.error && accepted.error.message}`);

    const afterAccept = await listGroups();
    assert.equal(
      afterAccept.res.body.groups.some(
        (entry) => entry.groupId === reviewGroupId(groupId)
      ),
      false,
      'the reviewed group is not offered again on its own'
    );

    // A third report arrives at the same spot. It has never been reviewed, so
    // the group must come back rather than being retired forever.
    await reportRepository.createReport({
      reportId: 'REP-REPEAT-THREE',
      residentId: RESIDENT_A,
      title: 'Third report',
      category: 'Organic',
      description: 'Repeat-review fixture, third',
      latitude: 14.6500,
      longitude: 120.9500,
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
      clusterId: groupId,
      createdAt: new Date(),
    });

    const afterNew = await listGroups();
    const reopened = afterNew.res.body.groups.find(
      (entry) => entry.groupId === reviewGroupId(groupId)
    );
    assert.ok(reopened,
      'a new unreviewed report must re-open the group at the same location');
    assert.equal(reopened.reports.length, 3);
  } finally {
    await pool.query(
      `DELETE FROM report_duplicate_reviews WHERE cluster_id = $1`, [groupId]
    );
    await pool.query(`DELETE FROM report_histories WHERE report_id LIKE 'REP-REPEAT-%'`);
    await pool.query(`DELETE FROM reports WHERE cluster_id = $1`, [groupId]);
    await pool.query(`DELETE FROM report_clusters WHERE cluster_id = $1`, [groupId]);
  }
});

test('the same holds after a confirmed duplicate', async () => {
  const groupId = 'CL-DUPREVIEW-REPEAT-DENY';
  await pool.query(
    `INSERT INTO report_clusters (cluster_id, center_latitude, center_longitude, status)
     VALUES ($1, 14.6600, 120.9400, 'Pending')
     ON CONFLICT (cluster_id) DO NOTHING`,
    [groupId]
  );
  const base = Date.now() - 300000;
  for (const [suffix, residentId] of [['ONE', RESIDENT_A], ['TWO', RESIDENT_B]]) {
    await reportRepository.createReport({
      reportId: `REP-REPEATD-${suffix}`,
      residentId,
      title: 'First pair',
      category: 'Mixed',
      description: 'Repeat-review fixture, deny case',
      latitude: 14.6600,
      longitude: 120.9400,
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
      clusterId: groupId,
      createdAt: new Date(base),
    });
  }

  try {
    const denied = await run(
      adminController.confirmDuplicateReports,
      reviewGroupId(groupId),
      { reportIds: ['REP-REPEATD-TWO'] }
    );
    assert.equal(denied.error, undefined,
      `unexpected error: ${denied.error && denied.error.message}`);

    // Only the surviving original plus a new report should be offered, which is
    // what makes the review usable again at this location.
    await reportRepository.createReport({
      reportId: 'REP-REPEATD-THREE',
      residentId: RESIDENT_A,
      title: 'Later report',
      category: 'Mixed',
      description: 'Repeat-review fixture, later report',
      latitude: 14.6600,
      longitude: 120.9400,
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
      clusterId: groupId,
      createdAt: new Date(),
    });

    const listed = await listGroups();
    const reopened = listed.res.body.groups.find(
      (entry) => entry.groupId === reviewGroupId(groupId)
    );
    assert.ok(reopened, 'a later report must re-open the group after a deny');
    assert.equal(
      reopened.reports.some((entry) => String(entry.report_id) === 'REP-REPEATD-TWO'),
      false,
      'the confirmed duplicate is not offered back'
    );
  } finally {
    for (const residentId of [RESIDENT_A, RESIDENT_B]) {
      await pool.query(
        `DELETE FROM ${notificationsTableFor(residentId)} WHERE report_id LIKE 'REP-REPEATD-%'`
      );
    }
    await pool.query(
      `DELETE FROM report_duplicate_reviews WHERE cluster_id = $1`, [groupId]
    );
    await pool.query(`DELETE FROM report_histories WHERE report_id LIKE 'REP-REPEATD-%'`);
    await pool.query(`DELETE FROM reports WHERE cluster_id = $1`, [groupId]);
    await pool.query(`DELETE FROM report_clusters WHERE cluster_id = $1`, [groupId]);
  }
});

test('the admin queue includes Pending through Under Review only', async () => {
  const clusterId = 'CL-DUPREVIEW-STATUS';
  await pool.query(
    `INSERT INTO report_clusters (cluster_id, center_latitude, center_longitude, status)
     VALUES ($1, 14.6800, 120.9200, 'Pending')
     ON CONFLICT (cluster_id) DO NOTHING`,
    [clusterId]
  );

  const fixtures = [
    ['REP-STATUS-DENIED', RESIDENT_A, 'Denied'],
    ['REP-STATUS-COMPLETED', RESIDENT_B, 'Completed'],
    ['REP-STATUS-PENDING', RESIDENT_A, 'Pending'],
    ['REP-STATUS-INPROGRESS', RESIDENT_B, 'In Progress'],
    ['REP-STATUS-REVIEW', RESIDENT_A, 'Under Review'],
  ];
  const base = Date.now() - 60000;
  let index = 0;
  for (const [reportId, residentId, status] of fixtures) {
    await reportRepository.createReport({
      reportId,
      residentId,
      title: 'Status scan fixture',
      category: 'Mixed',
      description: 'Same spot, mixed report statuses',
      latitude: 14.6800,
      longitude: 120.9200,
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
      clusterId,
      createdAt: new Date(base + index * 1000),
    });
    await pool.query(
      `UPDATE reports SET status = $2 WHERE report_id = $1`,
      [reportId, status]
    );
    index += 1;
  }

  try {
    const { res, error } = await listGroups();
    assert.equal(error, undefined, `unexpected error: ${error && error.message}`);

    const group = res.body.groups.find(
      (entry) => entry.groupId === reviewGroupId(clusterId)
    );
    assert.ok(group, 'three open reports form a clone group');
    assert.equal(group.reports.length, 3);
    assert.equal(
      group.reports.some((report) => report.report_id === 'REP-STATUS-DENIED'),
      false,
      'a Denied report has already been rejected and is not reviewable'
    );
    assert.equal(
      group.reports.some((report) => report.report_id === 'REP-STATUS-COMPLETED'),
      false,
      'a Completed report has already been cleared and is not reviewable'
    );
    assert.equal(
      group.reports.some((report) => report.report_id === 'REP-STATUS-PENDING'),
      true,
      'Pending remains reviewable'
    );
    assert.equal(
      group.reports.some((report) => report.report_id === 'REP-STATUS-INPROGRESS'),
      true,
      'In Progress remains reviewable'
    );
    assert.equal(
      group.reports.some((report) => report.report_id === 'REP-STATUS-REVIEW'),
      true,
      'Under Review remains reviewable'
    );
  } finally {
    await pool.query(`DELETE FROM reports WHERE cluster_id = $1`, [clusterId]);
    await pool.query(`DELETE FROM report_clusters WHERE cluster_id = $1`, [clusterId]);
  }
});

test('a group made only of Denied reports is not offered', async () => {
  const clusterId = 'CL-DUPREVIEW-ALLDENIED';
  await pool.query(
    `INSERT INTO report_clusters (cluster_id, center_latitude, center_longitude, status)
     VALUES ($1, 14.6850, 120.9150, 'Pending')
     ON CONFLICT (cluster_id) DO NOTHING`,
    [clusterId]
  );

  for (const [suffix, residentId] of [['ONE', RESIDENT_A], ['TWO', RESIDENT_B]]) {
    await reportRepository.createReport({
      reportId: `REP-ALLDENIED-${suffix}`,
      residentId,
      title: 'Denied pair',
      category: 'Mixed',
      description: 'Both reports were rejected',
      latitude: 14.6850,
      longitude: 120.9150,
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
      clusterId,
      createdAt: new Date(),
    });
  }
  await pool.query(
    `UPDATE reports SET status = 'Denied' WHERE cluster_id = $1`,
    [clusterId]
  );

  try {
    const { res } = await listGroups();
    assert.equal(
      res.body.groups.some(
        (entry) => entry.groupId === reviewGroupId(clusterId)
      ),
      false,
      'Denied reports cannot duplicate each other'
    );
  } finally {
    await pool.query(`DELETE FROM reports WHERE cluster_id = $1`, [clusterId]);
    await pool.query(`DELETE FROM report_clusters WHERE cluster_id = $1`, [clusterId]);
  }
});

test('a Completed-only group is not offered for review', async () => {
  const clusterId = 'CL-DUPREVIEW-COMPLETED';
  await pool.query(
    `INSERT INTO report_clusters (cluster_id, center_latitude, center_longitude, status)
     VALUES ($1, 14.6900, 120.9100, 'Pending')
     ON CONFLICT (cluster_id) DO NOTHING`,
    [clusterId]
  );

  for (const [suffix, residentId] of [['ONE', RESIDENT_A], ['TWO', RESIDENT_B]]) {
    await reportRepository.createReport({
      reportId: `REP-COMPLETED-${suffix}`,
      residentId,
      title: 'Completed pair',
      category: 'Mixed',
      description: 'Both reports were already cleared',
      latitude: 14.6900,
      longitude: 120.9100,
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
      clusterId,
      createdAt: new Date(),
    });
  }
  await pool.query(
    `UPDATE reports SET status = 'Completed' WHERE cluster_id = $1`,
    [clusterId]
  );

  try {
    const { res, error } = await listGroups();
    assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
    assert.equal(
      res.body.groups.some(
        (entry) => entry.groupId === reviewGroupId(clusterId)
      ),
      false,
      'Completed work is closed and must not re-enter the review queue'
    );
  } finally {
    await pool.query(`DELETE FROM reports WHERE cluster_id = $1`, [clusterId]);
    await pool.query(`DELETE FROM report_clusters WHERE cluster_id = $1`, [clusterId]);
  }
});

test('a decision covering no reports records nothing', async () => {
  const groupId = 'CL-DUPREVIEW-EMPTY';
  await pool.query(
    `INSERT INTO report_clusters (cluster_id, center_latitude, center_longitude, status)
     VALUES ($1, 14.6700, 120.9300, 'Pending')
     ON CONFLICT (cluster_id) DO NOTHING`,
    [groupId]
  );
  await reportRepository.createReport({
    reportId: 'REP-EMPTY-ONE',
    residentId: RESIDENT_A,
    title: 'Only report',
    category: 'Plastic',
    description: 'Empty-decision fixture',
    latitude: 14.6700,
    longitude: 120.9300,
    imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
    clusterId: groupId,
    createdAt: new Date(),
  });

  try {
    const result = await run(adminController.markNotDuplicates, groupId, {});
    assert.equal(result.error, undefined,
      `unexpected error: ${result.error && result.error.message}`);
    const reviews = await pool.query(
      `SELECT COUNT(*)::int AS count FROM report_duplicate_reviews WHERE cluster_id = $1`,
      [groupId]
    );
    assert.equal(reviews.rows[0].count, 1, 'exactly the reviewed report is recorded');
  } finally {
    await pool.query(
      `DELETE FROM report_duplicate_reviews WHERE cluster_id = $1`, [groupId]
    );
    await pool.query(`DELETE FROM report_histories WHERE report_id LIKE 'REP-EMPTY-%'`);
    await pool.query(`DELETE FROM reports WHERE cluster_id = $1`, [groupId]);
    await pool.query(`DELETE FROM report_clusters WHERE cluster_id = $1`, [groupId]);
  }
});





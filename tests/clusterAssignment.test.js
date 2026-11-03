const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../src/config/db');
const adminController = require('../src/modules/admin/adminController');
const clusterRepository = require('../src/modules/reports/clusterRepository');
const reportRepository = require('../src/modules/reports/reportRepository');

const ADMIN_ID = 'ADM-CLUSTERTEST';
const RESIDENT_ID = 'RES-CLUSTERTEST';
const CLUSTER_ID = 'CL-CLUSTERTEST';
const PERSONNEL = ['PERS-9001', 'PERS-9002', 'PERS-9003'];

/** Minimal stand-in for the Express response used by the controller. */
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

const createRequest = (clusterId, body) => ({
  requestId: 'test-cluster-assign',
  params: { clusterId },
  body,
  admin: { admin_id: ADMIN_ID, role: 'ADMIN' },
});

/** Runs the controller, returning the captured response or the thrown error. */
const runAssign = async (clusterId, body) => {
  const res = createResponse();
  let forwarded = null;
  await adminController.assignCluster(createRequest(clusterId, body), res, (e) => {
    forwarded = e;
  });
  if (forwarded) return { error: forwarded };
  return { res };
};

const seed = async () => {
  // reports.assigned_by_admin_id is a foreign key, so the acting admin has to
  // be a real row rather than an invented identifier.
  await pool.query(
    `INSERT INTO admins (admin_id, first_name, last_name, username, email,
        password_hash, role)
     VALUES ($1, 'Cluster', 'Admin', $1, $1, 'not-a-real-hash', 'ADMIN')
     ON CONFLICT (admin_id) DO UPDATE SET role = 'ADMIN'`,
    [ADMIN_ID]
  );

  await pool.query(
    `INSERT INTO residents (resident_id, first_name, last_name, username, email,
        password_hash, role, status, is_verified)
     VALUES ($1, 'Cluster', 'Tester', $1, $1, 'not-a-real-hash', 'RESIDENT', 'AVAILABLE', true)
     ON CONFLICT (resident_id) DO NOTHING`,
    [RESIDENT_ID]
  );

  for (const personnelId of PERSONNEL) {
    const suffix = personnelId.slice(-4);
    await pool.query(
      `INSERT INTO personnel_accounts (personnel_id, first_name, last_name, username, email,
          password_hash, role, status, is_cleaning)
       VALUES ($1, 'Clean', 'Tester', $2, $3, 'not-a-real-hash', 'PERSONNEL', 'OFFLINE', false)
       ON CONFLICT (personnel_id) DO NOTHING`,
      [personnelId, `clustercleaner${suffix}`, `clustercleaner${suffix}@gmail.com`]
    );
  }

  await pool.query(
    `INSERT INTO report_clusters (cluster_id, center_latitude, center_longitude, status)
     VALUES ($1, 14.5995, 120.9842, 'Pending')
     ON CONFLICT (cluster_id) DO NOTHING`,
    [CLUSTER_ID]
  );

  // Three reports in the cluster, oldest first so the FIFO pick is checkable.
  const base = Date.now() - 60000;
  for (let index = 0; index < 3; index += 1) {
    const reportId = `REP-CLT${index}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await reportRepository.createReport({
      reportId,
      residentId: RESIDENT_ID,
      title: `Cluster report ${index}`,
      category: 'Recyclable',
      description: 'Cluster assignment fixture',
      latitude: 14.5995,
      longitude: 120.9842,
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
      clusterId: CLUSTER_ID,
      createdAt: new Date(base + index * 1000),
    });
  }
};

const cleanup = async () => {
  await pool.query(
    `DELETE FROM report_histories WHERE resident_id = $1 OR report_id LIKE 'REP-CLT%'`,
    [RESIDENT_ID]
  );
  await pool.query(`DELETE FROM reports WHERE cluster_id = $1`, [CLUSTER_ID]);
  await pool.query(`DELETE FROM report_clusters WHERE cluster_id = $1`, [CLUSTER_ID]);
  await pool.query(`DELETE FROM personnel_accounts WHERE personnel_id = ANY($1)`, [PERSONNEL]);
  await pool.query(`DELETE FROM residents WHERE resident_id = $1`, [RESIDENT_ID]);
  await pool.query(`DELETE FROM admins WHERE admin_id = $1`, [ADMIN_ID]);
};

test.before(async () => { await cleanup(); await seed(); });
test.after(async () => { await cleanup(); });

test('assigning a cleaner to a cluster assigns one report and advances the cluster', async () => {
  const { res, error } = await runAssign(CLUSTER_ID, {
    personnelId: PERSONNEL[0],
    adminResponse: 'Please clear this spot.',
  });

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  assert.equal(res.body.success, true);
  assert.equal(res.body.assignedReportId !== undefined, true);
  assert.equal(res.body.remainingUnassigned, 2);

  // The report really was written, with the cleaner, its timestamp and status.
  const report = await pool.query(
    `SELECT assigned_personnel_id, assigned_at, status
       FROM reports WHERE report_id = $1`,
    [res.body.assignedReportId]
  );
  assert.equal(report.rows[0].assigned_personnel_id, PERSONNEL[0]);
  assert.ok(report.rows[0].assigned_at, 'assigned_at must be stamped');
  assert.equal(report.rows[0].status, 'In Progress');

  // The cleaner is marked busy, exactly as a report assignment does it.
  const personnel = await pool.query(
    `SELECT is_cleaning, current_assignment_report_id, status
       FROM personnel_accounts WHERE personnel_id = $1`,
    [PERSONNEL[0]]
  );
  assert.equal(personnel.rows[0].is_cleaning, true);
  assert.equal(personnel.rows[0].status, 'CLEANING');
  assert.equal(personnel.rows[0].current_assignment_report_id, res.body.assignedReportId);

  // And the cluster moved out of Pending.
  const cluster = await clusterRepository.getClusterById(CLUSTER_ID);
  assert.equal(cluster.status, 'In Progress');
});

test('a second cleaner takes the next report, never the same one twice', async () => {
  const { res, error } = await runAssign(CLUSTER_ID, {
    personnelId: PERSONNEL[1],
    adminResponse: 'Please clear this spot.',
  });

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  assert.equal(res.body.remainingUnassigned, 1);

  const rows = await pool.query(
    `SELECT report_id, assigned_personnel_id FROM reports WHERE cluster_id = $1`,
    [CLUSTER_ID]
  );
  const assigned = rows.rows.filter((r) => r.assigned_personnel_id);
  assert.equal(assigned.length, 2, 'two reports are now assigned');
  assert.equal(
    new Set(assigned.map((r) => r.assigned_personnel_id)).size,
    2,
    'each report has a distinct cleaner'
  );
});

test('the last report fills the cluster and a fourth assign is refused', async () => {
  const { res, error } = await runAssign(CLUSTER_ID, {
    personnelId: PERSONNEL[2],
    adminResponse: 'Please clear this spot.',
  });

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  assert.equal(res.body.remainingUnassigned, 0);

  const fourth = await runAssign(CLUSTER_ID, {
    personnelId: PERSONNEL[2],
    adminResponse: 'Please clear this spot.',
  });
  assert.ok(fourth.error, 'a fully assigned cluster refuses further assignment');
  assert.equal(fourth.error.statusCode, 409);
});

/**
 * Counts must describe outstanding work, so a Completed report leaves the total
 * rather than inflating it forever. Seeded fresh here because the assignment
 * tests above deliberately leave the cluster fully assigned.
 */
const seedCounts = async () => {
  await cleanup();
  await seed();

  const rows = await pool.query(
    `SELECT report_id FROM reports WHERE cluster_id = $1 ORDER BY created_at ASC`,
    [CLUSTER_ID]
  );
  const ids = rows.rows.map((r) => r.report_id);

  await pool.query(
    `UPDATE reports SET status = 'Completed' WHERE report_id = $1`,
    [ids[1]]
  );
  await pool.query(
    `UPDATE reports SET status = 'Completed' WHERE report_id = $1`,
    [ids[2]]
  );

  return ids;
};

test('a completed report is left out of the cluster counts', async () => {
  const ids = await seedCounts();

  const cluster = await clusterRepository.getClusterById(CLUSTER_ID);

  // 3 seeded reports, 2 of them now Completed.
  assert.equal(ids.length, 3);
  assert.equal(cluster.reportCount, 1, 'only the outstanding report is counted');
  assert.equal(cluster.spotCount, 1, 'spotCount follows the same set');
});

test('counting falls when a report is completed and rises when one is added', async () => {
  const before = await clusterRepository.getClusterById(CLUSTER_ID);
  assert.equal(before.reportCount, 1);

  // A cleaner finishes the last outstanding report.
  const rows = await pool.query(
    `SELECT report_id FROM reports WHERE cluster_id = $1 AND status IS DISTINCT FROM 'Completed'`,
    [CLUSTER_ID]
  );
  await pool.query(
    `UPDATE reports SET status = 'Completed' WHERE report_id = $1`,
    [rows.rows[0].report_id]
  );

  const afterClean = await clusterRepository.getClusterById(CLUSTER_ID);
  assert.equal(afterClean.reportCount, 0, 'a fully cleaned cluster counts zero');

  // A new resident report lands inside the same radius.
  await reportRepository.createReport({
    reportId: `REP-NEW${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    residentId: RESIDENT_ID,
    title: 'Brand new report at the same spot',
    category: 'Recyclable',
    description: 'Arrived after the cluster was cleaned',
    latitude: 14.5995,
    longitude: 120.9842,
    imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
    clusterId: CLUSTER_ID,
  });

  const afterNew = await clusterRepository.getClusterById(CLUSTER_ID);
  assert.equal(afterNew.reportCount, 1, 'the new report is counted immediately');
});

test('nearby clusters report the same outstanding count', async () => {
  const nearby = await clusterRepository.findNearbyActiveClusters(
    14.5995, 120.9842, 10
  );
  const mine = nearby.find((c) => c.clusterId === CLUSTER_ID);

  assert.ok(mine, 'the cluster is still listed');
  const cluster = await clusterRepository.getClusterById(CLUSTER_ID);
  assert.equal(mine.reportCount, cluster.reportCount);
  assert.equal(mine.spotCount, cluster.reportCount);
});

test('a malformed personnel id is rejected before anything is written', async () => {
  const { error } = await runAssign(CLUSTER_ID, {
    personnelId: 'not-a-personnel-id',
    adminResponse: 'Please clear this spot.',
  });

  assert.ok(error, 'a bad personnel id must be refused');
  assert.equal(error.statusCode, 400);
});

test('an unknown cluster is a 404 rather than a silent success', async () => {
  const { error } = await runAssign('CL-DOESNOTEXIST', {
    personnelId: PERSONNEL[0],
    adminResponse: 'Please clear this spot.',
  });

  assert.ok(error, 'an unknown cluster must be refused');
  assert.equal(error.statusCode, 404);
});

/**
 * Returns the cluster and its cleaners to a clean Pending state, so a test
 * never inherits assignments left behind by the one before it.
 */
const resetCluster = async () => {
  await pool.query(
    `UPDATE reports SET assigned_personnel_id = NULL, assigned_personnel_ids = NULL,
       assigned_at = NULL, handled_by_id = NULL, status = 'Pending'
     WHERE cluster_id = $1`,
    [CLUSTER_ID]
  );
  await pool.query(
    `UPDATE personnel_accounts SET is_cleaning = false, current_assignment = NULL,
       current_assignment_report_id = NULL, current_assignment_location = NULL,
       current_assignment_assigned_at = NULL, status = 'OFFLINE'
     WHERE personnel_id = ANY($1)`,
    [PERSONNEL]
  );
  await clusterRepository.updateClusterStatus(CLUSTER_ID, 'Pending');
};

/**
 * Completes every open report beyond the first n, oldest kept, so a test knows
 * exactly how many reports are available to hand out. The count tests above add
 * reports to this cluster, so the number is otherwise not fixed.
 */
const leaveOpenReports = async (n) => {
  const rows = await pool.query(
    `SELECT report_id FROM reports
      WHERE cluster_id = $1 AND status IS DISTINCT FROM 'Completed'
      ORDER BY created_at ASC, report_id ASC`,
    [CLUSTER_ID]
  );
  const ids = rows.rows.map((r) => r.report_id);
  const surplus = ids.slice(n);
  if (surplus.length > 0) {
    await pool.query(
      `UPDATE reports SET status = 'Completed' WHERE report_id = ANY($1)`,
      [surplus]
    );
  }
  return ids;
};

test('a cleaner already busy elsewhere is refused with a conflict', async () => {
  await resetCluster();
  await leaveOpenReports(3);

  // Two cleaners take the first two reports, which is what marks them busy.
  const first = await runAssign(CLUSTER_ID, {
    personnelId: PERSONNEL[0],
    adminResponse: 'Please clear this spot.',
  });
  assert.equal(first.error, undefined, 'the first assignment should succeed');

  const second = await runAssign(CLUSTER_ID, {
    personnelId: PERSONNEL[1],
    adminResponse: 'Please clear this spot.',
  });
  assert.equal(second.error, undefined, 'the second assignment should succeed');

  // Only one report is still free, and it is not the one the first cleaner is
  // already booked on. Asking for that cleaner again has to be refused.
  const retry = await runAssign(CLUSTER_ID, {
    personnelId: PERSONNEL[0],
    adminResponse: 'Please clear this spot.',
  });

  assert.ok(retry.error, 'a busy cleaner must be refused');
  assert.equal(retry.error.statusCode, 409);
});

/* ------------------------------------------------------- multiple personnel */

test('three cleaners can be assigned to one cluster, one report each', async () => {
  await resetCluster();
  await leaveOpenReports(3);

  const { res, error } = await runAssign(CLUSTER_ID, {
    personnelIds: [...PERSONNEL],
    adminResponse: 'Full crew on this spot.',
  });

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  assert.equal(res.body.placements.length, 3);
  assert.equal(res.body.remainingUnassigned, 0);

  const rows = await pool.query(
    `SELECT report_id, assigned_personnel_id FROM reports WHERE cluster_id = $1`,
    [CLUSTER_ID]
  );
  const assigned = rows.rows.filter((r) => r.assigned_personnel_id);
  assert.equal(assigned.length, 3, 'every report now has its own cleaner');
  assert.equal(
    new Set(assigned.map((r) => r.assigned_personnel_id)).size,
    3,
    'no cleaner was reused across reports'
  );

  // Each cleaner is independently marked busy against their own report.
  for (const personnelId of PERSONNEL) {
    const person = await pool.query(
      `SELECT current_assignment_report_id FROM personnel_accounts WHERE personnel_id = $1`,
      [personnelId]
    );
    assert.ok(
      person.rows[0].current_assignment_report_id,
      `${personnelId} is bound to a report`
    );
  }
});

test('selecting more cleaners than open reports is refused up front', async () => {
  await resetCluster();
  await leaveOpenReports(2);

  const { error } = await runAssign(CLUSTER_ID, {
    personnelIds: [...PERSONNEL],
    adminResponse: 'Too many cleaners for this spot.',
  });

  assert.ok(error, 'the request must be refused');
  assert.equal(error.statusCode, 409);

  // Nothing was written.
  const rows = await pool.query(
    `SELECT COUNT(*)::int AS count FROM reports
     WHERE cluster_id = $1 AND assigned_personnel_id IS NOT NULL`,
    [CLUSTER_ID]
  );
  assert.equal(rows.rows[0].count, 0, 'a refused request assigns nobody');
});

test('a malformed id inside personnelIds is refused', async () => {
  await resetCluster();
  await leaveOpenReports(3);

  const { error } = await runAssign(CLUSTER_ID, {
    personnelIds: [PERSONNEL[0], 'nonsense'],
    adminResponse: 'One bad id in the list.',
  });

  assert.ok(error, 'a bad id must be refused');
  assert.equal(error.statusCode, 400);

  const rows = await pool.query(
    `SELECT COUNT(*)::int AS count FROM reports
     WHERE cluster_id = $1 AND assigned_personnel_id IS NOT NULL`,
    [CLUSTER_ID]
  );
  assert.equal(rows.rows[0].count, 0, 'nothing is assigned when the list is invalid');
});

test('duplicate ids collapse to one placement rather than two', async () => {
  await resetCluster();
  await leaveOpenReports(3);

  const { res, error } = await runAssign(CLUSTER_ID, {
    personnelIds: [PERSONNEL[0], PERSONNEL[0]],
    adminResponse: 'Same cleaner picked twice.',
  });

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  assert.equal(res.body.placements.length, 1, 'the duplicate is dropped');
});
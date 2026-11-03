const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../src/config/db');
const clusterRepository = require('../src/modules/reports/clusterRepository');
const reportRepository = require('../src/modules/reports/reportRepository');

const ADMIN_ID = 'ADM-CLONESTATUS';
const RESIDENT_ID = 'RES-CLONESTATUS';
const CLUSTER_ID = 'CL-CLONESTATUS';
const LATITUDE = 14.6012345;
const LONGITUDE = 120.9812345;

const makeReportId = () =>
  `REP-CLS${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

const seed = async () => {
  await pool.query(
    `INSERT INTO admins (admin_id, first_name, last_name, username, email,
        password_hash, role)
     VALUES ($1, 'Clone', 'Status', $1, $1, 'not-a-real-hash', 'ADMIN')
     ON CONFLICT (admin_id) DO UPDATE SET role = 'ADMIN'`,
    [ADMIN_ID]
  );

  await pool.query(
    `INSERT INTO residents (resident_id, first_name, last_name, username, email,
        password_hash, role, status, is_verified)
     VALUES ($1, 'Clone', 'Status', $1, $1, 'not-a-real-hash', 'RESIDENT', 'AVAILABLE', true)
     ON CONFLICT (resident_id) DO NOTHING`,
    [RESIDENT_ID]
  );

  await pool.query(
    `INSERT INTO report_clusters (cluster_id, center_latitude, center_longitude, status)
     VALUES ($1, $2, $3, 'Pending')
     ON CONFLICT (cluster_id) DO UPDATE SET status = 'Pending', center_latitude = $2, center_longitude = $3`,
    [CLUSTER_ID, LATITUDE, LONGITUDE]
  );

  await reportRepository.createReport({
    reportId: makeReportId(),
    residentId: RESIDENT_ID,
    title: 'Waste at the corner',
    category: 'Recyclable',
    description: 'Clone-scan status fixture',
    latitude: LATITUDE,
    longitude: LONGITUDE,
    imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
    clusterId: CLUSTER_ID,
  });
};

const cleanup = async () => {
  await pool.query(
    `DELETE FROM report_histories WHERE resident_id = $1 OR report_id LIKE 'REP-CLS%'`,
    [RESIDENT_ID]
  );
  await pool.query(`DELETE FROM reports WHERE cluster_id = $1`, [CLUSTER_ID]);
  await pool.query(
    `DELETE FROM report_clusters WHERE cluster_id LIKE 'CL-%' AND NOT EXISTS (
        SELECT 1 FROM reports r WHERE r.cluster_id = report_clusters.cluster_id
      ) AND created_at > NOW() - INTERVAL '1 hour'`
  );
  await pool.query(`DELETE FROM residents WHERE resident_id = $1`, [RESIDENT_ID]);
  await pool.query(`DELETE FROM admins WHERE admin_id = $1`, [ADMIN_ID]);
};

const setEveryReportStatus = async (status) => {
  await pool.query(
    `UPDATE reports SET status = $2 WHERE cluster_id = $1`,
    [CLUSTER_ID, status]
  );
};

test.before(async () => { await cleanup(); await seed(); });
test.after(async () => { await cleanup(); });

test('a spot with an open report is offered to the resident', async () => {
  const nearby = await clusterRepository.findNearbyActiveCluster(LATITUDE, LONGITUDE, 10);

  assert.ok(nearby, 'the pending report makes the spot scannable');
  assert.equal(nearby.clusterId, CLUSTER_ID);

  const preview = await clusterRepository.getNearbyClusterWithPreview(LATITUDE, LONGITUDE, 10);
  assert.ok(preview, 'the duplicate hand-off is raised');
  assert.equal(preview.reportCount, 1);
  assert.equal(preview.reportStatus, 'Pending', 'a Pending report describes the spot');
  assert.ok(preview.previewReportId, 'a photo of the report is offered');
});

test('completing the only report takes the spot out of the scan', async () => {
  await setEveryReportStatus('Completed');

  // The cluster row is deliberately left exactly as it was: still 'Pending',
  // still sitting on the same coordinates. Only the report underneath changed.
  const cluster = await pool.query(
    `SELECT status FROM report_clusters WHERE cluster_id = $1`,
    [CLUSTER_ID]
  );
  assert.equal(cluster.rows[0].status, 'Pending', 'the cluster row is never advanced');

  const nearby = await clusterRepository.findNearbyActiveCluster(LATITUDE, LONGITUDE, 10);
  assert.equal(nearby, null, 'a Completed report is finished work, not a clone target');

  const preview = await clusterRepository.getNearbyClusterWithPreview(LATITUDE, LONGITUDE, 10);
  assert.equal(preview, null, 'and nothing is previewed either');
});

test('Under Review is scannable too', async () => {
  await setEveryReportStatus('Under Review');

  const nearby = await clusterRepository.findNearbyActiveCluster(LATITUDE, LONGITUDE, 10);
  assert.ok(nearby, 'Under Review is not a reason to hide the spot');
  assert.equal(nearby.clusterId, CLUSTER_ID);

  const preview = await clusterRepository.getNearbyClusterWithPreview(LATITUDE, LONGITUDE, 10);
  assert.equal(preview.reportStatus, 'Under Review');
});

test('a Completed report neither counts nor hides the open one beside it', async () => {
  await setEveryReportStatus('Completed');
  const openReport = await reportRepository.createReport({
    reportId: makeReportId(),
    residentId: RESIDENT_ID,
    title: 'Still being cleaned',
    category: 'Recyclable',
    description: 'Clone-scan status fixture, open report',
    latitude: LATITUDE,
    longitude: LONGITUDE,
    imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
    clusterId: CLUSTER_ID,
  });
  await pool.query(
    `UPDATE reports SET status = 'In Progress' WHERE report_id = $1`,
    [openReport.report_id]
  );

  const preview = await clusterRepository.getNearbyClusterWithPreview(LATITUDE, LONGITUDE, 10);
  assert.equal(preview.reportStatus, 'In Progress', 'live work describes the spot, not finished work');
  assert.equal(preview.reportCount, 1, 'the Completed report is not counted');

  // Leave the fixture exactly as the next test expects it: one Completed report.
  await pool.query(`DELETE FROM reports WHERE report_id = $1`, [openReport.report_id]);
});

test('the admin review and the resident scan both ignore Completed reports', async () => {
  await setEveryReportStatus('Completed');
  await reportRepository.createReport({
    reportId: makeReportId(),
    residentId: RESIDENT_ID,
    title: 'Second report at the same corner',
    category: 'Recyclable',
    description: 'Clone-scan status fixture, second report',
    latitude: LATITUDE,
    longitude: LONGITUDE,
    imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
    clusterId: CLUSTER_ID,
  });
  await setEveryReportStatus('Completed');

  // With even the newer report finished, there is nothing left to warn about.
  const nearby = await clusterRepository.findNearbyActiveCluster(LATITUDE, LONGITUDE, 10);
  assert.equal(nearby, null, 'the resident scan drops Completed reports');

  // The administrator cannot decide anything about completed work either.
  let groups = await clusterRepository.findPossibleDuplicateGroups();
  assert.equal(
    groups.find((g) => g.clusterId === CLUSTER_ID),
    undefined,
    'a Completed report must not make an admin review group'
  );

  // Making both reports open again restores the pair.
  await setEveryReportStatus('Under Review');
  groups = await clusterRepository.findPossibleDuplicateGroups();
  const group = groups.find((g) => g.clusterId === CLUSTER_ID);
  assert.ok(group, 'Under Review reports form an admin review group');
  assert.equal(group.reportCount, 2);
});

test('denying every report takes the spot out of the scan', async () => {
  await setEveryReportStatus('Denied');

  const nearby = await clusterRepository.findNearbyActiveCluster(LATITUDE, LONGITUDE, 10);
  assert.equal(nearby, null, 'a Denied-only spot produces no duplicate hand-off');

  const preview = await clusterRepository.getNearbyClusterWithPreview(LATITUDE, LONGITUDE, 10);
  assert.equal(preview, null, 'and nothing is previewed either');

  const groups = await clusterRepository.findPossibleDuplicateGroups();
  assert.equal(
    groups.find((g) => g.clusterId === CLUSTER_ID),
    undefined,
    'a Denied-only spot raises no duplicate review'
  );
});

test('a fresh report at a fully Denied spot starts its own cluster', async () => {
  const newReport = await reportRepository.createReport({
    reportId: makeReportId(),
    residentId: RESIDENT_ID,
    title: 'Brand new waste at the same corner',
    category: 'Recyclable',
    description: 'Filed after every earlier report was Denied',
    latitude: LATITUDE,
    longitude: LONGITUDE,
    imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
    clusterId: null,
  });

  // This is what createReport does once the scan comes back empty, so the new
  // report cannot be filed against a spot whose reports were all rejected.
  const fresh = await clusterRepository.findNearbyActiveCluster(LATITUDE, LONGITUDE, 10);
  assert.equal(fresh, null, 'a Denied spot accepts new work without a warning');

  const newCluster = await clusterRepository.createCluster(LATITUDE, LONGITUDE);
  assert.notEqual(newCluster.cluster_id, CLUSTER_ID);
  await reportRepository.updateReport(newReport.report_id, { clusterId: newCluster.cluster_id });

  // Now that an open report exists again the spot is scannable once more.
  const revived = await clusterRepository.findNearbyActiveCluster(LATITUDE, LONGITUDE, 10);
  assert.equal(revived.clusterId, newCluster.cluster_id);

  await pool.query(`DELETE FROM reports WHERE cluster_id = $1`, [newCluster.cluster_id]);
  await pool.query(`DELETE FROM report_clusters WHERE cluster_id = $1`, [newCluster.cluster_id]);
});

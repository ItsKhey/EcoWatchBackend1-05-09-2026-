/**
 * Read-only check that an empty cluster no longer captures a new submission.
 * Run after the empty-cluster exclusion fix to confirm real data behaves.
 */
require('dotenv').config();
const { pool } = require('../src/config/db');
const clusterRepository = require('../src/modules/reports/clusterRepository');

const LAT = 7.8321;
const LON = 125.0176;

(async () => {
  try {
    const near = await clusterRepository.findNearbyActiveCluster(LAT, LON, 10);
    console.log('[VERIFY] nearby active cluster (10m):',
      near ? near.clusterId : 'none (a new cluster will be created)');

    if (near) {
      const detail = await clusterRepository.getNearbyClusterWithPreview(LAT, LON, 10);
      console.log('[VERIFY] sheet payload would show:', {
        reportCount: detail.reportCount,
        spotCount: detail.spotCount,
        previewReportId: detail.previewReportId,
        previewPhoto: detail.previewPhoto ? 'resolved' : 'none',
      });
    }

    const all = await clusterRepository.findNearbyActiveClusters(LAT, LON, 10);
    console.log('[VERIFY] all nearby active clusters (10m):', all.length);
  } catch (error) {
    console.error('[VERIFY] FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();

/**
 * Removes waste-spot clusters that no longer hold any report.
 *
 * A hard report delete leaves the cluster row behind, and cluster matching is
 * coordinate-based, so an empty cluster keeps capturing new submissions at that
 * spot and offers to attach them to a cleanup area with no reports. Deleting
 * the leftovers lets the next submission create a fresh cluster.
 *
 * Dry run by default. Pass --apply to delete.
 */
require('dotenv').config();
const { pool } = require('../config/db');

const APPLY = process.argv.includes('--apply');

(async () => {
  try {
    const orphans = await pool.query(`
      SELECT c.cluster_id, c.center_latitude, c.center_longitude,
             c.status, c.created_at, c.last_activity_at
      FROM report_clusters c
      WHERE NOT EXISTS (
        SELECT 1 FROM reports r
        WHERE r.cluster_id = c.cluster_id
          AND r.is_deleted = false
          AND r.is_archived = false
      )
      ORDER BY c.created_at ASC
    `);

    if (orphans.rows.length === 0) {
      console.log('[CLUSTER-CLEANUP] No empty clusters found. Nothing to do.');
      return;
    }

    console.log(`[CLUSTER-CLEANUP] Found ${orphans.rows.length} cluster(s) with no active reports:`);
    console.table(orphans.rows);

    if (!APPLY) {
      console.log('[CLUSTER-CLEANUP] Dry run. Re-run with --apply to delete them.');
      return;
    }

    const ids = orphans.rows.map((row) => row.cluster_id);
    const deleted = await pool.query(
      'DELETE FROM report_clusters WHERE cluster_id = ANY($1::text[]) RETURNING cluster_id',
      [ids]
    );

    console.log(`[CLUSTER-CLEANUP] Deleted ${deleted.rows.length} cluster(s).`);
  } catch (error) {
    console.error('[CLUSTER-CLEANUP] Failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();

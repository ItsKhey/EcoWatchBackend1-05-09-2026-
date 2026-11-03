/**
 * Read-only diagnostic for the "Existing Cleanup Area Found" sheet.
 * Reports why a detected cluster shows 0 reports and no preview photo.
 */
require('dotenv').config();
const { pool } = require('../src/config/db');

(async () => {
  try {
    const clusters = await pool.query(`
      SELECT cluster_id, center_latitude, center_longitude, status,
             created_at, last_activity_at,
             (SELECT COUNT(*) FROM reports r
               WHERE r.cluster_id = c.cluster_id) AS all_reports,
             (SELECT COUNT(*) FROM reports r
               WHERE r.cluster_id = c.cluster_id
                 AND r.is_deleted = false AND r.is_archived = false) AS active_reports
      FROM report_clusters c
      ORDER BY c.created_at DESC
      LIMIT 5
    `);
    console.log('--- recent clusters ---');
    console.table(clusters.rows);

    const orphans = await pool.query(`
      SELECT report_id, title, cluster_id, is_deleted, is_archived, created_at
      FROM reports
      ORDER BY created_at DESC
      LIMIT 10
    `);
    console.log('--- recent reports (cluster_id column) ---');
    console.table(orphans.rows);

    const unlinked = await pool.query(
      "SELECT COUNT(*)::int AS unlinked FROM reports WHERE cluster_id IS NULL"
    );
    console.log('reports with NULL cluster_id:', unlinked.rows[0].unlinked);

    const photos = await pool.query(`
      SELECT rp.report_id, COUNT(*)::int AS photos
      FROM report_photos rp GROUP BY rp.report_id ORDER BY photos DESC LIMIT 5
    `);
    console.log('--- report_photos counts ---');
    console.table(photos.rows);
  } catch (error) {
    console.error('DIAGNOSTIC FAILED:', error.message);
  } finally {
    await pool.end();
  }
})();

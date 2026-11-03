const { pool } = require('../../config/db');
const { customAlphabet } = require('nanoid');

const CLUSTER_ID_PATTERN = /^CL-[0-9]{6}$/i;
const generateClusterId = () => {
  const nanoid = customAlphabet('0123456789', 6);
  return `CL-${nanoid()}`;
};

/**
 * The rows that may take part in the resident's duplicate/clone scan.
 *
 * <p>Denied and Completed are both exclusions. Denied means the report was
 * reviewed and rejected, so it cannot be the original that a later submission
 * clones. Completed means the waste at that spot has already been cleared and
 * the job is finished, so warning a resident about it would offer a duplicate
 * decision about work that no longer exists.
 *
 * <p>Everything still open - Pending, In Progress and Under Review - stays in
 * the scan: it describes waste that was reported at this spot and may still be
 * the original of a clone. Submission time is deliberately irrelevant.
 *
 * <p>Kept as SQL text so the nearby hand-off, its count and its preview ask the
 * same question instead of drifting apart.
 */
const DUPLICATE_SCAN_STATUS_FILTER =
  `LOWER(TRIM(COALESCE(r.status, ''))) NOT IN ('denied', 'completed')`;

/**
 * The rows the administrator's Possible Duplicate Reports queue may show.
 *
 * <p>Only reports from Pending through Under Review are still open enough for
 * the administrator to decide whether one duplicates another. Completed work
 * has already been cleared and Denied work has already been rejected, so
 * neither is actionable in the review queue.
 */
const ADMIN_DUPLICATE_REVIEW_STATUS_FILTER =
  `LOWER(TRIM(COALESCE(r.status, ''))) IN ('pending', 'in progress', 'under review')`;

/**
 * The order in which report statuses describe a nearby spot.
 *
 * <p>The cluster row is a location, not a report: it is never advanced to a
 * terminal state, so it can still say 'Pending' after every report underneath
 * it has finished. The nearby hand-off must therefore describe the reports,
 * and when several disagree the most active one wins.
 */
const REPRESENTATIVE_REPORT_STATUS_ORDER = Object.freeze([
  'in progress',
  'under review',
  'pending',
]);

/**
 * Picks the status the resident should see for the reports at a spot.
 *
 * <p>Denied and Completed rows are already filtered out of the scan, so they
 * never reach here. Returns the original spelling of the winning row so the UI
 * keeps the server's casing, or null when there is nothing to describe.
 */
const representativeReportStatus = (rows) => {
  const byKey = new Map();
  for (const row of rows || []) {
    const raw = String(row?.status || '').trim();
    const key = raw.toLowerCase();
    if (!key || byKey.has(key)) continue;
    byKey.set(key, raw);
  }

  for (const key of REPRESENTATIVE_REPORT_STATUS_ORDER) {
    const raw = byKey.get(key);
    if (raw) return raw;
  }
  return null;
};

/**
 * Earth radius in meters for Haversine calculations.
 */
const EARTH_RADIUS_METERS = 6371000;

/**
 * Computes Haversine distance in meters between two lat/lng points.
 * Returns null when either coordinate pair is incomplete.
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

/**
 * Finds the nearest cluster within the given radius (meters) that still holds a
 * report worth comparing a new submission against.
 *
 * <p>Uses Haversine distance in PostgreSQL for accurate geospatial filtering.
 *
 * <p>Only clusters that hold at least one open report are considered. A
 * cluster outlives its reports (a hard delete leaves the row behind), and
 * matching on coordinates alone would make such an empty cluster capture every
 * future submission at that spot.
 *
 * <p>The report status, not the cluster status, decides liveness. The cluster
 * row itself is never advanced to a terminal state and can carry a stale
 * 'Pending' long after its reports changed, so matching on it would hide real
 * clones or keep finished spots alive. A report is part of the scan while it is
 * still open; Denied and Completed reports are not.
 */
async function findNearbyActiveCluster(latitude, longitude, radiusMeters = 10, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT
      c.cluster_id,
      c.center_latitude,
      c.center_longitude,
      c.status,
      c.created_at,
      c.updated_at,
      c.last_activity_at,
      (
        6371000 * 2 * ASIN(
          SQRT(
            POWER(SIN((c.center_latitude - $1) * PI() / 180 / 2), 2) +
            COS($1 * PI() / 180) * COS(c.center_latitude * PI() / 180) *
            POWER(SIN((c.center_longitude - $2) * PI() / 180 / 2), 2)
          )
        )
      ) AS distance_meters
    FROM report_clusters c
    WHERE EXISTS (
        SELECT 1
        FROM reports r
        WHERE r.cluster_id = c.cluster_id
          AND r.is_deleted = false
          AND r.is_archived = false
          AND ${DUPLICATE_SCAN_STATUS_FILTER}
      )
    ORDER BY distance_meters ASC
    LIMIT 1
    `,
    [latitude, longitude]
  );

  if (result.rows.length === 0) return null;

  const cluster = result.rows[0];
  const distance = cluster.distance_meters;

  if (distance > radiusMeters) return null;

  return {
    clusterId: cluster.cluster_id,
    centerLatitude: parseFloat(cluster.center_latitude),
    centerLongitude: parseFloat(cluster.center_longitude),
    status: cluster.status,
    distance: Math.round(distance * 10) / 10,
    createdAt: cluster.created_at,
    updatedAt: cluster.updated_at,
    lastActivityAt: cluster.last_activity_at,
  };
}

/**
 * Finds ALL active clusters within the given radius, ordered by distance.
 * Used by the GET /api/report-clusters/nearby endpoint.
 *
 * Each result carries `reportCount` and `spotCount` so a caller rendering one
 * marker per cluster can say how many reports it stands for, without a second
 * round trip per cluster. Previously neither count was returned here, so the
 * admin map had no way to show a cluster as anything other than an unlabelled
 * pin.
 *
 * Both count the same set of reports: the ones still outstanding, meaning not
 * deleted, not archived and not yet Completed. Completed reports are excluded
 * on purpose. A waste the cleaner has already cleared is no longer work this
 * cluster is asking for, so leaving it in the count made the marker advertise
 * "5 reports" for a spot with only 3 left to do, and it never came back down
 * as the cluster was cleaned. Because the count is derived at read time rather
 * than stored, it rises and falls on its own as reports arrive inside the
 * radius and as they are completed.
 *
 * This is the operational nearby map, not the clone scan. The clone scan also
 * drops Denied reports, and it keeps In Progress and Under Review work even
 * when this map has already counted it as outstanding; this list answers "how
 * much work is still here", the scan answers "could this submission clone
 * something already reported".
 *
 * A cluster appears in this list only while it still holds an outstanding
 * report. Once the last report is Completed the cluster drops out of the map,
 * rather than lingering there as a 'Pending' spot with nothing behind it.
 */
async function findNearbyActiveClusters(latitude, longitude, radiusMeters = 10, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT
      c.cluster_id,
      c.center_latitude,
      c.center_longitude,
      c.status,
      c.created_at,
      c.updated_at,
      c.last_activity_at,
      (
        6371000 * 2 * ASIN(
          SQRT(
            POWER(SIN((c.center_latitude - $1) * PI() / 180 / 2), 2) +
            COS($1 * PI() / 180) * COS(c.center_latitude * PI() / 180) *
            POWER(SIN((c.center_longitude - $2) * PI() / 180 / 2), 2)
          )
        )
      ) AS distance_meters,
      (
        SELECT COUNT(*)::int
        FROM reports r
        WHERE r.cluster_id = c.cluster_id
          AND r.is_deleted = false
          AND r.is_archived = false
          AND r.status IS DISTINCT FROM 'Completed'
      ) AS report_count
    FROM report_clusters c
    WHERE c.status IN ('Pending', 'In Progress')
      AND EXISTS (
        SELECT 1
        FROM reports r
        WHERE r.cluster_id = c.cluster_id
          AND r.is_deleted = false
          AND r.is_archived = false
          AND r.status IS DISTINCT FROM 'Completed'
      )
    ORDER BY distance_meters ASC
    `,
    [latitude, longitude]
  );

  return result.rows.map((cluster) => ({
    clusterId: cluster.cluster_id,
    centerLatitude: parseFloat(cluster.center_latitude),
    centerLongitude: parseFloat(cluster.center_longitude),
    status: cluster.status,
    // The number of reports this cluster stands for. Kept alongside reportCount
    // under its own name because the resident app reads spotCount from this
    // endpoint and treats the two as distinct fields.
    reportCount: cluster.report_count,
    spotCount: cluster.report_count,
    distance: Math.round(cluster.distance_meters * 10) / 10,
    createdAt: cluster.created_at,
    updatedAt: cluster.updated_at,
    lastActivityAt: cluster.last_activity_at,
  })).filter((c) => c.distance <= radiusMeters);
}

/**
 * Creates a new cluster with the given center coordinates.
 */
async function createCluster(latitude, longitude, queryable = pool) {
  let clusterId = generateClusterId();

  // Ensure uniqueness by checking for collisions.
  const existing = await queryable.query(
    'SELECT cluster_id FROM report_clusters WHERE cluster_id = $1',
    [clusterId]
  );

  if (existing.rows.length > 0) {
    clusterId = generateClusterId();
  }

  const result = await queryable.query(
    `
    INSERT INTO report_clusters (cluster_id, center_latitude, center_longitude, status, last_activity_at)
    VALUES ($1, $2, $3, 'Pending', NOW())
    RETURNING *
    `,
    [clusterId, latitude, longitude]
  );

  return result.rows[0];
}

/**
 * Retrieves a cluster by its ID, including the count of reports inside.
 *
 * The count covers outstanding reports only: a report the cleaner has already
 * Completed is no longer part of what this cluster is asking for, so it is
 * filtered out here as well as in the nearby-cluster queries. A cluster holding
 * 3 pending and 2 completed reports reports 3, not 5.
 */
async function getClusterById(clusterId, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT
      c.cluster_id,
      c.center_latitude,
      c.center_longitude,
      c.status,
      c.created_at,
      c.updated_at,
      c.last_activity_at,
      COUNT(r.report_id) FILTER (
        WHERE r.status IS DISTINCT FROM 'Completed'
      )::int AS report_count
    FROM report_clusters c
    LEFT JOIN reports r ON r.cluster_id = c.cluster_id AND r.is_deleted = false AND r.is_archived = false
    WHERE c.cluster_id = $1
    GROUP BY c.cluster_id
    `,
    [clusterId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    clusterId: row.cluster_id,
    centerLatitude: parseFloat(row.center_latitude),
    centerLongitude: parseFloat(row.center_longitude),
    status: row.status,
    reportCount: row.report_count,
    spotCount: row.report_count, // Currently equals reportCount; may diverge in future
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
  };
}

/**
 * Updates the last_activity_at timestamp for a cluster.
 * Called when a new report joins or photos are added.
 */
async function touchClusterActivity(clusterId, queryable = pool) {
  const result = await queryable.query(
    `
    UPDATE report_clusters
    SET last_activity_at = NOW(), updated_at = NOW()
    WHERE cluster_id = $1
    RETURNING *
    `,
    [clusterId]
  );

  return result.rows[0] || null;
}

/**
 * Gets the nearest scannable cluster along with the report count,
 * preview photo, and preview report ID.
 *
 * <p>The count and the preview describe the same set the duplicate scan uses:
 * every open report at the spot. Denied and Completed reports are left out, so
 * the sheet never announces a rejected or already-cleared spot.
 */
async function getNearbyClusterWithPreview(latitude, longitude, radiusMeters = 10, queryable = pool) {
  const cluster = await findNearbyActiveCluster(latitude, longitude, radiusMeters, queryable);
  if (!cluster) return null;

  // Get the report count
  const countResult = await queryable.query(
    `
    SELECT COUNT(*)::int AS report_count
    FROM reports r
    WHERE r.cluster_id = $1
      AND r.is_deleted = false
      AND r.is_archived = false
      AND ${DUPLICATE_SCAN_STATUS_FILTER}
    `,
    [cluster.clusterId]
  );

  cluster.reportCount = countResult.rows[0].report_count;
  cluster.spotCount = cluster.reportCount; // Currently equals reportCount

  // The cluster row's own status is stale by design, so the hand-off carries a
  // status derived from the reports themselves. Without this the sheet would
  // announce a completed spot as 'Pending' simply because the location row was
  // never advanced.
  const statusResult = await queryable.query(
    `
    SELECT r.status
    FROM reports r
    WHERE r.cluster_id = $1
      AND r.is_deleted = false
      AND r.is_archived = false
      AND ${DUPLICATE_SCAN_STATUS_FILTER}
    `,
    [cluster.clusterId]
  );
  cluster.reportStatus = representativeReportStatus(statusResult.rows);

  // Get the newest scannable report in the cluster for preview
  const newestReportResult = await queryable.query(
    `
    SELECT r.report_id, r.created_at
    FROM reports r
    WHERE r.cluster_id = $1
      AND r.is_deleted = false
      AND r.is_archived = false
      AND ${DUPLICATE_SCAN_STATUS_FILTER}
    ORDER BY r.created_at DESC
    LIMIT 1
    `,
    [cluster.clusterId]
  );

  const newestReport = newestReportResult.rows[0];
  cluster.previewReportId = newestReport?.report_id || null;

  // Get a preview photo (first photo of the most recent report in the cluster)
  if (cluster.previewReportId) {
    const photoResult = await queryable.query(
      `
      SELECT image_url
      FROM report_photos
      WHERE report_id = $1
      ORDER BY order_index ASC
      LIMIT 1
      `,
      [cluster.previewReportId]
    );
    cluster.previewPhoto = photoResult.rows[0]?.image_url || null;
  } else {
    cluster.previewPhoto = null;
  }

  // Get the cluster status
  const clusterStatusResult = await queryable.query(
    'SELECT status FROM report_clusters WHERE cluster_id = $1',
    [cluster.clusterId]
  );

  cluster.status = clusterStatusResult.rows[0]?.status || 'Pending';

  return cluster;
}

/**
 * Gets preview information for multiple clusters (batch operation).
 * Returns a map of clusterId -> { previewReportId, previewPhoto }.
 *
 * The preview is drawn from outstanding reports only, so a cluster whose most
 * recent report has since been cleaned up still shows the waste that is
 * actually waiting for a cleaner rather than a finished one.
 */
async function getClustersPreviewInfo(clusterIds, queryable = pool) {
  if (!clusterIds || clusterIds.length === 0) return {};

  const result = await queryable.query(
    `
    SELECT DISTINCT ON (r.cluster_id)
      r.cluster_id,
      r.report_id AS preview_report_id,
      rp.image_url AS preview_photo
    FROM reports r
    LEFT JOIN report_photos rp ON rp.report_id = r.report_id AND rp.order_index = 0
    WHERE r.cluster_id = ANY($1)
      AND r.is_deleted = false
      AND r.is_archived = false
      AND r.status IS DISTINCT FROM 'Completed'
    ORDER BY r.cluster_id, r.created_at DESC
    `,
    [clusterIds]
  );

  const previewMap = {};
  for (const row of result.rows) {
    previewMap[row.cluster_id] = {
      previewReportId: row.preview_report_id,
      previewPhoto: row.preview_photo || null,
    };
  }

  return previewMap;
}

/**
 * Moves a cluster to a new lifecycle status.
 *
 * The cluster carries no personnel of its own: an assignment belongs to a
 * report. The cluster status exists so the admin's cluster list can group work
 * by state without walking every report underneath, which is why it is advanced
 * here rather than derived.
 */
async function updateClusterStatus(clusterId, status, queryable = pool) {
  if (!clusterId || !status) return null;

  const result = await queryable.query(
    `
    UPDATE report_clusters
    SET status = $2, updated_at = NOW()
    WHERE cluster_id = $1
    RETURNING cluster_id
    `,
    [clusterId, status]
  );

  return result.rows[0]?.cluster_id || null;
}

/**
 * Every group the administrator still needs to review.
 *
 * <p>A group qualifies when two or more open reports sit in the same spot
 * <em>and at least one of them has never been reviewed</em>. Open means the
 * report has not already finished or been rejected: Pending, In Progress and
 * Under Review are in, Completed and Denied are out. That matches the admin
 * review queue, where every card still offers a decision about live work.
 *
 * <p>The resident's nearby hand-off applies the same status rule - Pending, In
 * Progress and Under Review only - so a spot with nothing but Denied or
 * Completed reports never produces a duplicate prompt. The scans still differ
 * in scope: the admin queue groups open reports, while the resident scan asks
 * whether anything open sits at the spot the new submission is headed for.
 *
 * <p>The "never reviewed" test is what makes the feature repeatable. An earlier
 * version keyed the verdict on the cluster, so the first review permanently
 * retired that location and no later report there was ever offered again. Here
 * a decision is recorded per report, so the same spot comes back as soon as a
 * new report joins it.
 *
 * <p>The cluster's own status is deliberately not part of the filter. It is a
 * location row and can stay 'Pending' long after every report underneath it has
 * moved on; the reports are the source of truth for whether a clone exists.
 */
async function findPossibleDuplicateGroups(queryable = pool) {
  const result = await queryable.query(
    `
    SELECT
      c.cluster_id,
      c.center_latitude,
      c.center_longitude,
      c.status,
      c.created_at,
      c.updated_at,
      c.last_activity_at,
      COUNT(r.report_id)::int AS report_count
    FROM report_clusters c
    JOIN reports r ON r.cluster_id = c.cluster_id
    WHERE r.is_deleted = false
      AND r.is_archived = false
      AND ${ADMIN_DUPLICATE_REVIEW_STATUS_FILTER}
    GROUP BY c.cluster_id
    HAVING COUNT(r.report_id) >= 2
       AND COUNT(*) FILTER (
         WHERE NOT EXISTS (
           SELECT 1 FROM report_duplicate_reviews d
           WHERE d.report_id = r.report_id
         )
       ) >= 1
    ORDER BY c.last_activity_at DESC NULLS LAST
    `
  );

  return result.rows.map((row) => ({
    clusterId: row.cluster_id,
    centerLatitude: parseFloat(row.center_latitude),
    centerLongitude: parseFloat(row.center_longitude),
    status: row.status,
    reportCount: row.report_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
  }));
}

module.exports = {
  CLUSTER_ID_PATTERN,
  generateClusterId,
  haversineDistance,
  findNearbyActiveCluster,
  findNearbyActiveClusters,
  createCluster,
  getClusterById,
  getNearbyClusterWithPreview,
  getClustersPreviewInfo,
  touchClusterActivity,
  updateClusterStatus,
  findPossibleDuplicateGroups,
};

const { pool } = require('../config/db');
const { customAlphabet } = require('nanoid');

const CLUSTER_ID_PATTERN = /^CL-[0-9]{6}$/i;
const generateClusterId = () => {
  const nanoid = customAlphabet('0123456789', 6);
  return `CL-${nanoid()}`;
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
 * Finds the nearest active cluster within the given radius (meters).
 * Active statuses: Pending, In Progress.
 *
 * Uses Haversine distance in PostgreSQL for accurate geospatial filtering.
 */
async function findNearbyActiveCluster(latitude, longitude, radiusMeters = 10, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT
      cluster_id,
      center_latitude,
      center_longitude,
      status,
      created_at,
      updated_at,
      last_activity_at,
      (
        6371000 * 2 * ASIN(
          SQRT(
            POWER(SIN((center_latitude - $1) * PI() / 180 / 2), 2) +
            COS($1 * PI() / 180) * COS(center_latitude * PI() / 180) *
            POWER(SIN((center_longitude - $2) * PI() / 180 / 2), 2)
          )
        )
      ) AS distance_meters
    FROM report_clusters
    WHERE status IN ('Pending', 'In Progress')
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
 */
async function findNearbyActiveClusters(latitude, longitude, radiusMeters = 10, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT
      cluster_id,
      center_latitude,
      center_longitude,
      status,
      created_at,
      updated_at,
      last_activity_at,
      (
        6371000 * 2 * ASIN(
          SQRT(
            POWER(SIN((center_latitude - $1) * PI() / 180 / 2), 2) +
            COS($1 * PI() / 180) * COS(center_latitude * PI() / 180) *
            POWER(SIN((center_longitude - $2) * PI() / 180 / 2), 2)
          )
        )
      ) AS distance_meters
    FROM report_clusters
    WHERE status IN ('Pending', 'In Progress')
    ORDER BY distance_meters ASC
    `,
    [latitude, longitude]
  );

  return result.rows.map((cluster) => ({
    clusterId: cluster.cluster_id,
    centerLatitude: parseFloat(cluster.center_latitude),
    centerLongitude: parseFloat(cluster.center_longitude),
    status: cluster.status,
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
      COUNT(r.report_id)::int AS report_count
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
 * Gets the nearest active cluster along with the report count,
 * preview photo, and preview report ID.
 */
async function getNearbyClusterWithPreview(latitude, longitude, radiusMeters = 10, queryable = pool) {
  const cluster = await findNearbyActiveCluster(latitude, longitude, radiusMeters, queryable);
  if (!cluster) return null;

  // Get the report count
  const countResult = await queryable.query(
    `
    SELECT COUNT(*)::int AS report_count
    FROM reports
    WHERE cluster_id = $1 AND is_deleted = false AND is_archived = false
    `,
    [cluster.clusterId]
  );

  cluster.reportCount = countResult.rows[0].report_count;
  cluster.spotCount = cluster.reportCount; // Currently equals reportCount

  // Get the newest active report in the cluster for preview
  const newestReportResult = await queryable.query(
    `
    SELECT r.report_id, r.created_at
    FROM reports r
    WHERE r.cluster_id = $1 AND r.is_deleted = false AND r.is_archived = false
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
  const statusResult = await queryable.query(
    'SELECT status FROM report_clusters WHERE cluster_id = $1',
    [cluster.clusterId]
  );

  cluster.status = statusResult.rows[0]?.status || 'Pending';

  return cluster;
}

/**
 * Gets preview information for multiple clusters (batch operation).
 * Returns a map of clusterId -> { previewReportId, previewPhoto }.
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
};

-- Migration 014: Report Clusters & Multi-Photo Support
-- Implements location-based cluster detection and unlimited photo storage.

-- 1. Create the report_clusters table
CREATE TABLE IF NOT EXISTS report_clusters (
  cluster_id       TEXT        PRIMARY KEY,
  center_latitude  DECIMAL(10, 8) NOT NULL,
  center_longitude DECIMAL(11, 8) NOT NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  status           TEXT          NOT NULL DEFAULT 'Pending'
);

-- Index for status-based filtering
CREATE INDEX IF NOT EXISTS idx_report_clusters_status ON report_clusters (status);

-- 2. Add cluster_id column to reports table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reports' AND column_name = 'cluster_id'
  ) THEN
    ALTER TABLE reports ADD COLUMN cluster_id TEXT;
  END IF;
END $$;

-- Index for cluster-based lookups
CREATE INDEX IF NOT EXISTS idx_reports_cluster_id ON reports (cluster_id);

-- 3. Create the report_photos table
CREATE TABLE IF NOT EXISTS report_photos (
  photo_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   TEXT        NOT NULL REFERENCES reports(report_id) ON DELETE CASCADE,
  image_url   TEXT        NOT NULL,
  order_index INTEGER     NOT NULL DEFAULT 0,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for report photo lookups
CREATE INDEX IF NOT EXISTS idx_report_photos_report_id ON report_photos (report_id);
CREATE INDEX IF NOT EXISTS idx_report_photos_report_order ON report_photos (report_id, order_index);

-- 4. Create the report_clusters_idempotency table to prevent duplicate cluster
--    creation under concurrent transactions (race condition protection).
CREATE TABLE IF NOT EXISTS report_clusters_idempotency (
  latitude_bucket  DECIMAL(10, 8) NOT NULL,
  longitude_bucket DECIMAL(11, 8) NOT NULL,
  created_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (latitude_bucket, longitude_bucket)
);

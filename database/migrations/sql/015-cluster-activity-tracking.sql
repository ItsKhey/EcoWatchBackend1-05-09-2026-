-- Migration 015: Cluster Activity Tracking
-- Adds last_activity_at to report_clusters for Admin app sorting.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'report_clusters' AND column_name = 'last_activity_at'
  ) THEN
    ALTER TABLE report_clusters ADD COLUMN last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;
END $$;

-- Set last_activity_at to match created_at for existing clusters
UPDATE report_clusters SET last_activity_at = created_at WHERE last_activity_at IS NULL;

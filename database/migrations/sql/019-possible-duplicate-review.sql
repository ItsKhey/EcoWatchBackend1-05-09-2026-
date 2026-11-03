-- Tracks the administrator's duplicate-review decision for each cluster of
-- nearby reports. Default 'POSSIBLE' keeps every existing cluster eligible
-- for review; the admin app then labels a group as admin-not-duplicate or
-- confirmed duplicate without ever exposing the cluster concept in the UI.
ALTER TABLE report_clusters
  ADD COLUMN IF NOT EXISTS duplicate_review TEXT NOT NULL DEFAULT 'POSSIBLE';

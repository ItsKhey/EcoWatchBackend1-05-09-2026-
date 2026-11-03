-- Records the administrator's duplicate-review decision per report.
--
-- The decision is deliberately stored against the reports it covered rather
-- than against the cluster as a whole. A cluster-scoped verdict is permanent:
-- once one group at a spot was reviewed, a later report at that same spot was
-- never offered again, so the review only ever worked once. Keying on the
-- report means a group is offered again the moment a new, unreviewed report
-- joins it, which is what an administrator expects.
--
-- The cluster itself stays an internal nearby-detection detail and is never
-- shown in the admin UI.

CREATE TABLE IF NOT EXISTS report_duplicate_reviews (
  review_id BIGSERIAL PRIMARY KEY,
  report_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  denied_report_ids TEXT[] NOT NULL DEFAULT '{}',
  admin_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT report_duplicate_reviews_decision_ck
    CHECK (decision IN ('DUPLICATE_CONFIRMED', 'NOT_DUPLICATE'))
);

CREATE INDEX IF NOT EXISTS report_duplicate_reviews_report_idx
  ON report_duplicate_reviews (report_id);

CREATE INDEX IF NOT EXISTS report_duplicate_reviews_cluster_idx
  ON report_duplicate_reviews (cluster_id);

-- Replaces the earlier cluster-scoped verdict column, which is what made the
-- review a one-time event per location.
ALTER TABLE report_clusters DROP COLUMN IF EXISTS duplicate_review;
-- Migration 022: Personnel assignment workflow
--
-- The third EcoWatch role needs its own view of the work the admin already
-- assigned. Today an assignment is only a pointer on `reports`
-- (assigned_personnel_id) plus a busy flag on `personnel_accounts`, neither of
-- which can express acknowledgment, before/after evidence, or completion, and
-- both of which are cleared the moment an administrator approves completion.
--
-- This migration adds a personnel-owned lifecycle record that survives the
-- report pointer being cleared, so a cleaner keeps a history of finished work.
-- It deliberately does NOT touch `reports.status`, which is the resident-facing
-- value: the personnel workflow states (ASSIGNED -> ACCEPTED -> IN_PROGRESS ->
-- COMPLETED) live only in `personnel_assignments`.
--
-- Idempotent so it can be re-run on an already-migrated database.

-- 1. Per-personnel FCM binding, mirroring admins.fcm_token. Personnel were
--    previously excluded from every push path because there was nowhere to
--    store a device token.
ALTER TABLE personnel_accounts ADD COLUMN IF NOT EXISTS fcm_token TEXT;
CREATE INDEX IF NOT EXISTS index_personnel_accounts_fcm_token
  ON personnel_accounts (fcm_token);

-- 2. Human-readable assignment id sequence (ASG-0001).
CREATE SEQUENCE IF NOT EXISTS personnel_assignment_id_seq;

-- 3. The assignment lifecycle record.
CREATE TABLE IF NOT EXISTS personnel_assignments (
  assignment_id        TEXT        PRIMARY KEY
    DEFAULT ('ASG-' || LPAD(nextval('personnel_assignment_id_seq')::TEXT, 4, '0')),
  report_id            TEXT        NOT NULL
    REFERENCES reports (report_id) ON UPDATE CASCADE ON DELETE CASCADE,
  personnel_id         TEXT        NOT NULL
    REFERENCES personnel_accounts (personnel_id) ON UPDATE CASCADE ON DELETE CASCADE,
  cluster_id           TEXT,
  status               TEXT        NOT NULL DEFAULT 'ASSIGNED',
  assigned_by_admin_id TEXT,
  assigned_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  accepted_at          TIMESTAMPTZ,
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  completion_notes     TEXT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT personnel_assignments_status_ck
    CHECK (status IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'))
);

-- One live assignment per report, and one per cleaner. These mirror the
-- existing reports_active_assigned_personnel_uidx invariant without changing
-- it: completed and cancelled rows are history and may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS personnel_assignments_active_report_uidx
  ON personnel_assignments (report_id)
  WHERE status IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS');

CREATE UNIQUE INDEX IF NOT EXISTS personnel_assignments_active_personnel_uidx
  ON personnel_assignments (personnel_id)
  WHERE status IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS');

CREATE INDEX IF NOT EXISTS idx_personnel_assignments_personnel
  ON personnel_assignments (personnel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_personnel_assignments_report
  ON personnel_assignments (report_id);

CREATE INDEX IF NOT EXISTS idx_personnel_assignments_cluster
  ON personnel_assignments (cluster_id);

-- 4. Before/after evidence. Kept separate from report_photos, which the
--    resident owns and which has no notion of phase or uploader. Multiple
--    photos per phase are allowed, matching the multi-photo report model;
--    completion requires at least one of each.
CREATE TABLE IF NOT EXISTS personnel_evidence (
  evidence_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id TEXT        NOT NULL
    REFERENCES personnel_assignments (assignment_id) ON UPDATE CASCADE ON DELETE CASCADE,
  report_id     TEXT        NOT NULL,
  personnel_id  TEXT        NOT NULL
    REFERENCES personnel_accounts (personnel_id) ON UPDATE CASCADE ON DELETE CASCADE,
  phase         TEXT        NOT NULL,
  image_url     TEXT        NOT NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT personnel_evidence_phase_ck CHECK (phase IN ('BEFORE', 'AFTER'))
);

CREATE INDEX IF NOT EXISTS idx_personnel_evidence_assignment
  ON personnel_evidence (assignment_id, phase, uploaded_at);

-- 5. Personnel notification store. Same shape as admin_notifications: the
--    existing architecture is one owner table per account type keyed to that
--    account, so this extends it to the third role rather than starting a
--    parallel system.
CREATE TABLE IF NOT EXISTS personnel_notifications (
  notification_id BIGSERIAL    PRIMARY KEY,
  personnel_id    VARCHAR(90)  NOT NULL,
  assignment_id   TEXT,
  report_id       VARCHAR(100),
  title           TEXT         NOT NULL,
  message         TEXT         NOT NULL,
  is_read         BOOLEAN      NOT NULL DEFAULT FALSE,
  type            VARCHAR(64)  NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT personnel_notifications_personnel_fk
    FOREIGN KEY (personnel_id) REFERENCES personnel_accounts (personnel_id)
    ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS index_personnel_notifications_owner
  ON personnel_notifications (personnel_id, notification_id);
CREATE INDEX IF NOT EXISTS index_personnel_notifications_unread
  ON personnel_notifications (personnel_id, is_read);
CREATE INDEX IF NOT EXISTS index_personnel_notifications_assignment
  ON personnel_notifications (personnel_id, assignment_id);

-- 6. Backfill: an existing live report pointer becomes an ASSIGNED record so a
--    cleaner who was assigned before this migration still sees the job. The
--    report may already be "In Progress" (admins set that at assign time), so
--    the cleaner's own state still starts at ASSIGNED and they acknowledge it.
INSERT INTO personnel_assignments (
  report_id,
  personnel_id,
  cluster_id,
  status,
  assigned_by_admin_id,
  assigned_at
)
SELECT
  r.report_id,
  r.assigned_personnel_id,
  r.cluster_id,
  'ASSIGNED',
  r.assigned_by_admin_id,
  COALESCE(r.assigned_at, NOW())
FROM reports r
WHERE r.assigned_personnel_id IS NOT NULL
  AND COALESCE(r.is_deleted, false) = false
  AND COALESCE(r.is_archived, false) = false
  AND NOT EXISTS (
    SELECT 1
    FROM personnel_assignments pa
    WHERE pa.report_id = r.report_id
      AND pa.status IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS')
  );

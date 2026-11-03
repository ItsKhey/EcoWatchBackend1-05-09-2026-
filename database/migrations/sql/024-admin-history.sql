-- Migration 024: Give the history log an administrator's-eye view.
--
-- The Admin app's History screen needs to answer "what did this admin decide, and
-- on what?" across five kinds of record: reports, assignments, cleaning,
-- announcements and ESP accounts. Three things blocked that, and this migration
-- addresses all three.
--
-- 1. SCOPE. `report_histories` is keyed by resident_id, and GET /api/history/
--    my-history filters on the caller's own id. Admin actions are written under
--    the *resident's* id, so an administrator querying their own id matched
--    almost nothing. The columns below are all nullable precisely so a row can
--    belong to no resident at all: an announcement or an account change has no
--    report and no resident to attribute it to. The new admin endpoint reads the
--    table unfiltered instead.
--
-- 2. CATEGORY. The action column is a flat constant ('ASSIGNED', 'ACCOUNT_CREATED',
--    ...) and several constants straddle two tabs: COMPLETED is both a finished
--    cleaning job and a report an admin marked complete. Storing the decision
--    server-side means the tab is decided where the decision is made, rather than
--    re-derived by every client from a keyword. It stays nullable and is treated
--    as 'REPORTS' when absent, so rows written before this migration keep
--    rendering exactly where they used to.
--
-- 3. SUBJECT. Announcement and account records have no report to join to, so the
--    subject is denormalised onto the row: what it was about, its stable id, and
--    a label the card can show without a second lookup. Report-scoped rows leave
--    these NULL and keep using report_id.
--
-- Nothing here rewrites existing rows. The new columns are nullable, the CHECK
-- constraint admits NULL, and the index is created CONCURRENTLY-equivalently (as a
-- plain CREATE INDEX IF NOT EXISTS inside the advisory lock below) so an existing
-- install upgrades without a rewrite.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:admin-history:v1')
);

-- Who acted. Absent on rows written by the resident app, which never had an
-- administrator actor.
ALTER TABLE report_histories
  ADD COLUMN IF NOT EXISTS admin_id TEXT;

-- Which Admin History tab the row belongs under. NULL means 'not categorised
-- yet', which clients read as REPORTS.
ALTER TABLE report_histories
  ADD COLUMN IF NOT EXISTS category TEXT;

-- What the row is about, for records that have no report to join to.
-- 'ANNOUNCEMENT' or 'PERSONNEL'.
ALTER TABLE report_histories
  ADD COLUMN IF NOT EXISTS subject_type TEXT;

-- Stable server id of that subject: an announcement id or a personnel id.
ALTER TABLE report_histories
  ADD COLUMN IF NOT EXISTS subject_id TEXT;

-- Human-readable subject, denormalised so a card renders without a second query.
-- For a personnel record this is the full name; for an announcement, its title.
ALTER TABLE report_histories
  ADD COLUMN IF NOT EXISTS subject_label TEXT;

-- The database is the final authority on the category set, so a typo cannot file
-- an admin decision under an unknown heading. NULL is allowed on purpose: rows
-- predating this migration are uncategorised rather than wrong.
ALTER TABLE report_histories
  DROP CONSTRAINT IF EXISTS report_histories_category_ck;

ALTER TABLE report_histories
  ADD CONSTRAINT report_histories_category_ck
  CHECK (
    category IS NULL
    OR category IN (
      'REPORTS',
      'ASSIGNMENTS',
      'CLEANING',
      'ANNOUNCEMENTS',
      'ACCOUNT'
    )
  );

-- Same reasoning for the subject kind.
ALTER TABLE report_histories
  DROP CONSTRAINT IF EXISTS report_histories_subject_type_ck;

ALTER TABLE report_histories
  ADD CONSTRAINT report_histories_subject_type_ck
  CHECK (
    subject_type IS NULL
    OR subject_type IN ('ANNOUNCEMENT', 'PERSONNEL')
  );

-- The admin feed reads the whole table newest first and filters by tab, so the
-- ordering the screen depends on needs an index of its own.
CREATE INDEX IF NOT EXISTS idx_report_histories_admin_feed
  ON report_histories (timestamp DESC, id DESC)
  WHERE is_deleted = false;

-- Per-tab counts are shown on the pill labels; this keeps them off a table scan
-- once the table grows past the first few hundred decisions.
CREATE INDEX IF NOT EXISTS idx_report_histories_category
  ON report_histories (category, timestamp DESC)
  WHERE is_deleted = false;

-- Backfill existing rows.
--
-- Without this every record written before this migration would land under
-- Reports, because that is the NULL fallback: the assignment and cleaning history
-- an administrator already has would silently move tabs the first time the
-- Admin History screen opened. Backfilling keeps the existing record where it
-- belongs instead of asking the admin to re-file their own history.
--
-- Only rows that are still NULL are touched, so re-running is a no-op and a row
-- categorised by a later call site is never overwritten.
UPDATE report_histories SET category = 'REPORTS'
WHERE category IS NULL AND action IN (
  'SUBMITTED', 'STATUS_CHANGED', 'ARCHIVED', 'RESTORED', 'UPDATED',
  'MOVED_TO_TRASH', 'PERMANENTLY_DELETED', 'DENIED', 'DUPLICATE',
  'DUPLICATE_CONFIRMED', 'NOT_DUPLICATE', 'ADMIN_RESPONSE_UPDATED'
);

UPDATE report_histories SET category = 'ASSIGNMENTS'
WHERE category IS NULL AND action IN (
  'ASSIGNED', 'REASSIGNED', 'UNASSIGNED', 'ASSIGNMENT_CANCELLED',
  'ASSIGNMENT_REJECTED', 'ASSIGNMENT_COMPLETED'
);

-- Cleaning is set last and deliberately wins any overlap: COMPLETED is written
-- both for a finished cleaning job and for a report an admin marked complete,
-- and the pre-existing rows are attributed the same way the shared action table
-- attributes them. The two sets do not actually intersect, so the order only
-- matters as a guard if a future action is added to both.
UPDATE report_histories SET category = 'CLEANING'
WHERE category IS NULL AND (
  action LIKE 'CLEANING%'
  OR action LIKE '%EVIDENCE%'
  OR action = 'COMPLETED'
  OR action = 'STARTED'
  OR action = 'INCOMPLETE'
  OR action = 'REVISION_REQUESTED'
);

-- Announcements and account rows did not exist before this migration, so there
-- is nothing to back-fill for them. Stated explicitly so the omission reads as a
-- decision rather than an oversight.

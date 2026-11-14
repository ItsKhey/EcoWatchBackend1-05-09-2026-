-- Migration 030: Remove the announcement feature.
--
-- Run with: npm run migrate:remove-announcements
-- This migration is idempotent and safe to re-run.
--
-- The announcement feature was removed from the Admin app and the backend. What
-- remains at the database layer is the storage it used: the announcements table,
-- the notifications and report_histories rows it wrote, the CHECK constraints
-- that still admit its vocabulary, and the two notification-preference columns.
-- This migration removes all of it.
--
-- Uses the same advisory lock as the announcement migrations it replaces, so a
-- concurrently running announcement migration serialises with this one instead
-- of recreating the objects this migration is dropping.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:announcements:v1')
);

-- ---------------------------------------------------------------------------
-- 1. Announcement data
-- ---------------------------------------------------------------------------
-- Deleted before the constraints are narrowed: the new CHECKs would reject
-- these rows, so leaving them in place would make ADD CONSTRAINT fail.

DELETE FROM notifications
WHERE type = 'ANNOUNCEMENT';

DELETE FROM report_histories
WHERE category = 'ANNOUNCEMENTS'
   OR subject_type = 'ANNOUNCEMENT';

-- ---------------------------------------------------------------------------
-- 2. Announcement vocabulary in CHECK constraints
-- ---------------------------------------------------------------------------
-- Postgres has no "remove a value from a CHECK" operation, so each constraint
-- is restated in full. Every other value is preserved exactly as it was before
-- this migration.

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_ck;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_ck
  CHECK (
    type = ANY (ARRAY[
      'PERSONNEL_ASSIGNED',
      'PERSONNEL_UNASSIGNED',
      'CLEANING_STARTED',
      'ADMIN_RESPONSE_UPDATED',
      'REPORT_DENIED',
      'REPORT_DUPLICATE',
      'REPORT_COMPLETED',
      'REPORT_UPDATE',
      'NEW_REPORT'
    ]::varchar[])
  );

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
      'ACCOUNT'
    )
  );

ALTER TABLE report_histories
  DROP CONSTRAINT IF EXISTS report_histories_subject_type_ck;

ALTER TABLE report_histories
  ADD CONSTRAINT report_histories_subject_type_ck
  CHECK (
    subject_type IS NULL
    OR subject_type IN ('PERSONNEL', 'RESIDENT')
  );

-- ---------------------------------------------------------------------------
-- 3. Announcement preference columns
-- ---------------------------------------------------------------------------
-- Both tables stored a cenro_announcements toggle. The backend no longer reads
-- or writes it, so the column would otherwise sit at its default forever.

ALTER TABLE public.notification_preferences
  DROP COLUMN IF EXISTS cenro_announcements;

ALTER TABLE public.admin_notification_preferences
  DROP COLUMN IF EXISTS cenro_announcements;

-- ---------------------------------------------------------------------------
-- 4. The announcements table
-- ---------------------------------------------------------------------------
-- DROP TABLE removes the indexes, constraints, and the bigserial sequence owned
-- by the table. CASCADE is not used: nothing else should reference this table,
-- and a silent cascade would hide a dependency that ought to be reviewed.

DROP TABLE IF EXISTS public.announcements;

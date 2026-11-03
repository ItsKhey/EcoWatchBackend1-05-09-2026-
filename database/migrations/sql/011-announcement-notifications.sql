-- Allows the notifications table to carry ANNOUNCEMENT rows.
-- Run with: npm run migrate:announcement-notifications
-- Idempotent: it re-points the constraint at the current definition and is a
-- no-op when ANNOUNCEMENT is already permitted.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:announcements:v1')
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'notifications_type_ck'
       AND pg_get_constraintdef(oid) LIKE '%ANNOUNCEMENT%'
  ) THEN
    ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_ck;
    ALTER TABLE notifications
      ADD CONSTRAINT notifications_type_ck
      CHECK (
        type = ANY (ARRAY[
          'PERSONNEL_ASSIGNED',
          'PERSONNEL_UNASSIGNED',
          'CLEANING_STARTED',
          'ADMIN_RESPONSE_UPDATED',
          'REPORT_DENIED',
          'REPORT_COMPLETED',
          'REPORT_UPDATE',
          'NEW_REPORT',
          'ANNOUNCEMENT'
        ]::varchar[])
      );
  END IF;
END
$$;

-- An announcement notification belongs to no report. The column is already
-- nullable, so this only records the intent: report_id stays NULL rather than
-- pointing at a report that does not exist.
COMMENT ON COLUMN notifications.report_id IS
  'Owning report. NULL for broadcasts such as ANNOUNCEMENT, which are not tied to a report.';

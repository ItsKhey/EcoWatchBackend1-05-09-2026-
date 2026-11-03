-- Allows the notifications table to carry REPORT_DUPLICATE rows.
-- Run with: node migration/migrate-report-duplicate-notifications.js
-- Idempotent: it re-points the constraint at the current definition and is a
-- no-op when REPORT_DUPLICATE is already permitted.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:duplicate-review:v1')
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'notifications_type_ck'
       AND pg_get_constraintdef(oid) LIKE '%REPORT_DUPLICATE%'
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
          'REPORT_DUPLICATE',
          'REPORT_COMPLETED',
          'REPORT_UPDATE',
          'NEW_REPORT',
          'ANNOUNCEMENT'
        ]::varchar[])
      );
  END IF;
END
$$;
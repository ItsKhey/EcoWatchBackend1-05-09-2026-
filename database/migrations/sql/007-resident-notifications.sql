-- Phase 2C: resident notification center, FCM registration, and authoritative
-- report submission timestamps.
-- Run with: npm run migrate:resident-notifications
-- This migration is additive/idempotent and safe to run after Phase 2B.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:phase-2c:resident-notifications:v1')
);

-- ---------------------------------------------------------------------------
-- Report submission timestamp repair
-- ---------------------------------------------------------------------------
-- MongoDB report documents created before timestamps were enabled were migrated
-- with a NULL created_at. The original SUBMITTED history event is the
-- authoritative server-owned submission timestamp for those rows. Backfill the
-- existing created_at column only; no duplicate report timestamp is introduced.

DO $$
BEGIN
  IF to_regclass('public.report_histories') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE public.reports AS r
      SET created_at = submitted.timestamp
      FROM (
        SELECT DISTINCT ON (report_id) report_id, timestamp
        FROM public.report_histories
        WHERE upper(trim(COALESCE(action, ''))) = 'SUBMITTED'
          AND timestamp IS NOT NULL
        ORDER BY report_id, timestamp ASC
      ) AS submitted
      WHERE r.created_at IS NULL
        AND submitted.report_id = r.report_id
    $sql$;

    EXECUTE $sql$
      UPDATE public.archived_reports AS r
      SET created_at = submitted.timestamp
      FROM (
        SELECT DISTINCT ON (report_id) report_id, timestamp
        FROM public.report_histories
        WHERE upper(trim(COALESCE(action, ''))) = 'SUBMITTED'
          AND timestamp IS NOT NULL
        ORDER BY report_id, timestamp ASC
      ) AS submitted
      WHERE r.created_at IS NULL
        AND submitted.report_id = r.report_id
    $sql$;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.reports WHERE created_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce reports.created_at: one or more rows have no created_at or authoritative SUBMITTED history timestamp';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.archived_reports WHERE created_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce archived_reports.created_at: one or more rows have no created_at or authoritative SUBMITTED history timestamp';
  END IF;
END
$$;

ALTER TABLE public.reports
  ALTER COLUMN created_at SET DEFAULT NOW(),
  ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE public.archived_reports
  ALTER COLUMN created_at SET DEFAULT NOW(),
  ALTER COLUMN created_at SET NOT NULL;

COMMENT ON COLUMN public.reports.created_at IS
  'Authoritative server-owned report submission timestamp used by every client.';

-- ---------------------------------------------------------------------------
-- Resident FCM token storage
-- ---------------------------------------------------------------------------

ALTER TABLE public.residents
  ADD COLUMN IF NOT EXISTS fcm_token text;

CREATE UNIQUE INDEX IF NOT EXISTS residents_fcm_token_uidx
  ON public.residents (fcm_token)
  WHERE fcm_token IS NOT NULL;

COMMENT ON COLUMN public.residents.fcm_token IS
  'Current FCM registration token for this resident device; never exposed by profile APIs.';

-- ---------------------------------------------------------------------------
-- Canonical resident notification table
-- ---------------------------------------------------------------------------

-- The original table used a generic id column. Rename it in place so primary and
-- foreign keys retain their existing identity/sequence values.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notifications'
      AND column_name = 'id'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notifications'
      AND column_name = 'notification_id'
  ) THEN
    ALTER TABLE public.notifications RENAME COLUMN id TO notification_id;
  END IF;
END
$$;

-- Keep a read-only compatibility alias for the previous Render deployment
-- during rolling releases. New code uses notification_id; old code can still
-- SELECT/filter/RETURNING id while the service is being replaced.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS id bigint
    GENERATED ALWAYS AS (notification_id) STORED;

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS type varchar(64) NOT NULL DEFAULT 'REPORT_UPDATE';

-- Remove orphan markers first, then discard legacy personnel rows that were
-- incorrectly written into the resident notification table by Phase 2B.
DO $$
BEGIN
  IF to_regclass('public.trash_notifications') IS NOT NULL THEN
    DELETE FROM public.trash_notifications AS t
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.notifications AS n
      WHERE n.notification_id = t.notification_id
    );
  END IF;
END
$$;

DELETE FROM public.notifications AS n
WHERE n.resident_id IS NULL
   OR NOT EXISTS (
     SELECT 1
     FROM public.residents AS r
     WHERE r.resident_id = n.resident_id
       AND lower(trim(COALESCE(r.role, 'RESIDENT'))) = 'resident'
   );

UPDATE public.notifications
SET created_at = COALESCE(created_at, NOW()),
    is_read = COALESCE(is_read, false),
    title = COALESCE(NULLIF(trim(title), ''), 'Report update'),
    message = COALESCE(NULLIF(trim(message), ''), 'Your report was updated.');

ALTER TABLE public.notifications
  ALTER COLUMN notification_id SET DEFAULT nextval(pg_get_serial_sequence('public.notifications', 'notification_id')),
  ALTER COLUMN resident_id SET NOT NULL,
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN message SET NOT NULL,
  ALTER COLUMN type SET NOT NULL,
  ALTER COLUMN is_read SET DEFAULT false,
  ALTER COLUMN is_read SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT NOW(),
  ALTER COLUMN created_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'notifications_type_ck'
      AND conrelid = 'public.notifications'::regclass
  ) THEN
    ALTER TABLE public.notifications
      ADD CONSTRAINT notifications_type_ck
      CHECK (type IN (
        'PERSONNEL_ASSIGNED',
        'PERSONNEL_UNASSIGNED',
        'CLEANING_STARTED',
        'ADMIN_RESPONSE_UPDATED',
        'REPORT_DENIED',
        'REPORT_COMPLETED',
        'REPORT_UPDATE'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'notifications_resident_fk'
      AND conrelid = 'public.notifications'::regclass
  ) THEN
    ALTER TABLE public.notifications
      ADD CONSTRAINT notifications_resident_fk
      FOREIGN KEY (resident_id)
      REFERENCES public.residents(resident_id)
      ON UPDATE CASCADE
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'notifications_report_fk'
      AND conrelid = 'public.notifications'::regclass
  ) THEN
    ALTER TABLE public.notifications
      ADD CONSTRAINT notifications_report_fk
      FOREIGN KEY (report_id)
      REFERENCES public.reports(report_id)
      ON UPDATE CASCADE
      ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.trash_notifications') IS NOT NULL THEN
    ALTER TABLE public.trash_notifications
      ALTER COLUMN notification_id SET NOT NULL;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'trash_notifications_notification_fk'
        AND conrelid = 'public.trash_notifications'::regclass
    ) THEN
      ALTER TABLE public.trash_notifications
        ADD CONSTRAINT trash_notifications_notification_fk
        FOREIGN KEY (notification_id)
        REFERENCES public.notifications(notification_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE;
    END IF;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS trash_notifications_resident_notification_uidx
  ON public.trash_notifications (resident_id, notification_id);

CREATE INDEX IF NOT EXISTS notifications_resident_created_idx
  ON public.notifications (resident_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_resident_unread_idx
  ON public.notifications (resident_id, created_at DESC)
  WHERE is_read = false;

CREATE INDEX IF NOT EXISTS notifications_report_idx
  ON public.notifications (report_id)
  WHERE report_id IS NOT NULL;

-- All notification access is through the protected Node API. Enabling RLS
-- prevents accidental direct PostgREST access if the Supabase anon key is ever
-- introduced; the Render service uses the database owner/service connection.
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.residents ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.notifications IS
  'Server-created resident report notifications. Clients may list and mark their own rows read but cannot create notification content.';
COMMENT ON COLUMN public.notifications.type IS
  'Server-owned report event classification used by in-app and FCM delivery.';

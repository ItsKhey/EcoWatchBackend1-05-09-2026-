-- Phase 2B: canonical single-personnel report assignments.
-- Run with: npm run migrate:report-assignments
-- This migration is additive and safe to run repeatedly after Phase 2A.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:phase-2b:report-assignments:v1')
);

-- The canonical report fields are nullable so old reports, archived reports,
-- and rolling deployments remain readable while they are backfilled below.
ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS assigned_personnel_id varchar(9),
  ADD COLUMN IF NOT EXISTS assigned_by_admin_id varchar(50),
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

-- Archived reports retain the same assignment metadata when a resident moves
-- a report between the active and archive collections.
ALTER TABLE public.archived_reports
  ADD COLUMN IF NOT EXISTS assigned_personnel_id varchar(9),
  ADD COLUMN IF NOT EXISTS assigned_by_admin_id varchar(50),
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

-- These fields are deliberately separate from status/current_assignment_*.
-- The boolean is the canonical availability flag used by admin clients, while
-- current_assignment stores the human-readable task title.
ALTER TABLE public.personnel_accounts
  ADD COLUMN IF NOT EXISTS is_cleaning boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS current_assignment text,
  ADD COLUMN IF NOT EXISTS profile_image text;

-- Backfill only an unambiguous, existing PERS account from the old array. A
-- multi-person legacy assignment is intentionally not guessed at; it remains
-- available through assigned_personnel_ids until an admin explicitly replaces
-- it through the reassign endpoint.
DO $$
DECLARE
  ids_type text;
BEGIN
  SELECT data_type
  INTO ids_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'reports'
    AND column_name = 'assigned_personnel_ids';

  IF ids_type IN ('json', 'jsonb') THEN
    EXECUTE $sql$
      UPDATE public.reports AS r
      SET assigned_personnel_id = r.assigned_personnel_ids::jsonb ->> 0
      WHERE r.assigned_personnel_id IS NULL
        AND r.assigned_personnel_ids IS NOT NULL
        AND jsonb_typeof(r.assigned_personnel_ids::jsonb) = 'array'
        AND jsonb_array_length(r.assigned_personnel_ids::jsonb) = 1
        AND r.assigned_personnel_ids::jsonb ->> 0 ~ '^PERS-[0-9]{4}$'
        AND EXISTS (
          SELECT 1
          FROM public.personnel_accounts AS p
          WHERE p.personnel_id = r.assigned_personnel_ids::jsonb ->> 0
        )
    $sql$;
  ELSIF ids_type IN ('text', 'character varying', 'character') THEN
    -- Older Mongo migrations sometimes left the JSON array in a text column.
    EXECUTE $sql$
      UPDATE public.reports AS r
      SET assigned_personnel_id = substring(
        r.assigned_personnel_ids::text
        FROM '"(PERS-[0-9]{4})"'
      )
      WHERE r.assigned_personnel_id IS NULL
        AND r.assigned_personnel_ids::text ~ '^\s*\[\s*"(PERS-[0-9]{4})"\s*\]\s*$'
        AND EXISTS (
          SELECT 1
          FROM public.personnel_accounts AS p
          WHERE p.personnel_id = substring(
            r.assigned_personnel_ids::text
            FROM '"(PERS-[0-9]{4})"'
          )
        )
    $sql$;
  ELSIF ids_type = 'ARRAY' THEN
    -- The production schema stores assigned_personnel_ids as a PostgreSQL
    -- array. Backfill only an unambiguous one-element PERS assignment.
    EXECUTE $sql$
      UPDATE public.reports AS r
      SET assigned_personnel_id = r.assigned_personnel_ids[1]
      WHERE r.assigned_personnel_id IS NULL
        AND cardinality(r.assigned_personnel_ids) = 1
        AND r.assigned_personnel_ids[1] ~ '^PERS-[0-9]{4}$'
        AND EXISTS (
          SELECT 1
          FROM public.personnel_accounts AS p
          WHERE p.personnel_id = r.assigned_personnel_ids[1]
        )
    $sql$;
  END IF;
END
$$;

DO $$
DECLARE
  ids_type text;
BEGIN
  SELECT data_type
  INTO ids_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'archived_reports'
    AND column_name = 'assigned_personnel_ids';

  IF ids_type IN ('json', 'jsonb') THEN
    EXECUTE $sql$
      UPDATE public.archived_reports AS r
      SET assigned_personnel_id = r.assigned_personnel_ids::jsonb ->> 0
      WHERE r.assigned_personnel_id IS NULL
        AND r.assigned_personnel_ids IS NOT NULL
        AND jsonb_typeof(r.assigned_personnel_ids::jsonb) = 'array'
        AND jsonb_array_length(r.assigned_personnel_ids::jsonb) = 1
        AND r.assigned_personnel_ids::jsonb ->> 0 ~ '^PERS-[0-9]{4}$'
    $sql$;
  ELSIF ids_type IN ('text', 'character varying', 'character') THEN
    EXECUTE $sql$
      UPDATE public.archived_reports AS r
      SET assigned_personnel_id = substring(
        r.assigned_personnel_ids::text
        FROM '"(PERS-[0-9]{4})"'
      )
      WHERE r.assigned_personnel_id IS NULL
        AND r.assigned_personnel_ids::text ~ '^\s*\[\s*"(PERS-[0-9]{4})"\s*\]\s*$'
    $sql$;
  ELSIF ids_type = 'ARRAY' THEN
    EXECUTE $sql$
      UPDATE public.archived_reports AS r
      SET assigned_personnel_id = r.assigned_personnel_ids[1]
      WHERE r.assigned_personnel_id IS NULL
        AND cardinality(r.assigned_personnel_ids) = 1
        AND r.assigned_personnel_ids[1] ~ '^PERS-[0-9]{4}$'
    $sql$;
  END IF;
END
$$;

UPDATE public.reports AS r
SET assigned_personnel_id = r.handled_by_id
WHERE r.assigned_personnel_id IS NULL
  AND r.handled_by_id ~ '^PERS-[0-9]{4}$'
  AND EXISTS (
    SELECT 1
    FROM public.personnel_accounts AS p
    WHERE p.personnel_id = r.handled_by_id
  );

UPDATE public.reports
SET assigned_at = COALESCE(updated_at, created_at, NOW())
WHERE assigned_personnel_id IS NOT NULL
  AND assigned_at IS NULL;

UPDATE public.archived_reports
SET assigned_at = COALESCE(created_at, NOW())
WHERE assigned_personnel_id IS NOT NULL
  AND assigned_at IS NULL;

-- Normalize rows that were already synchronized by the Phase 2A assignment
-- path. The title is only a display convenience; the report ID remains the
-- authoritative relationship.
UPDATE public.personnel_accounts AS p
SET is_cleaning = (p.current_assignment_report_id IS NOT NULL),
    status = CASE
      WHEN p.current_assignment_report_id IS NOT NULL THEN 'CLEANING'
      WHEN p.status = 'CLEANING' THEN 'OFFLINE'
      ELSE p.status
    END,
    current_assignment = CASE
      WHEN p.current_assignment_report_id IS NULL THEN NULL
      ELSE COALESCE(
        p.current_assignment,
        (
          SELECT r.title
          FROM public.reports AS r
          WHERE r.report_id = p.current_assignment_report_id
        )
      )
    END;

-- Add relationship protection only when existing data is consistent. This
-- makes a bad legacy row fail the migration visibly instead of silently
-- attaching a report to a deleted or fabricated personnel ID.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.reports AS r
    WHERE r.assigned_personnel_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.personnel_accounts AS p
        WHERE p.personnel_id = r.assigned_personnel_id
      )
  ) THEN
    RAISE EXCEPTION
      'Cannot add report assignment foreign key: reports contain unknown assigned_personnel_id values';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.reports AS r
    WHERE r.assigned_by_admin_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.admins AS a
        WHERE a.admin_id = r.assigned_by_admin_id
      )
  ) THEN
    RAISE EXCEPTION
      'Cannot add assignment audit foreign key: reports contain unknown assigned_by_admin_id values';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reports_assigned_personnel_fk'
      AND conrelid = 'public.reports'::regclass
  ) THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_assigned_personnel_fk
      FOREIGN KEY (assigned_personnel_id)
      REFERENCES public.personnel_accounts(personnel_id)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reports_assigned_by_admin_fk'
      AND conrelid = 'public.reports'::regclass
  ) THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_assigned_by_admin_fk
      FOREIGN KEY (assigned_by_admin_id)
      REFERENCES public.admins(admin_id)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reports_assigned_personnel_format_ck'
      AND conrelid = 'public.reports'::regclass
  ) THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_assigned_personnel_format_ck
      CHECK (
        assigned_personnel_id IS NULL
        OR assigned_personnel_id ~ '^PERS-[0-9]{4}$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reports_assignment_timestamp_ck'
      AND conrelid = 'public.reports'::regclass
  ) THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_assignment_timestamp_ck
      CHECK (
        assigned_personnel_id IS NULL
        OR assigned_at IS NOT NULL
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'personnel_accounts_phase2b_assignment_ck'
      AND conrelid = 'public.personnel_accounts'::regclass
  ) THEN
    ALTER TABLE public.personnel_accounts
      ADD CONSTRAINT personnel_accounts_phase2b_assignment_ck
      CHECK (
        (is_cleaning = false AND current_assignment_report_id IS NULL)
        OR (
          is_cleaning = true
          AND current_assignment_report_id IS NOT NULL
          AND status = 'CLEANING'
        )
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS reports_assigned_personnel_idx
  ON public.reports (assigned_personnel_id)
  WHERE assigned_personnel_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reports_active_assigned_personnel_uidx
  ON public.reports (assigned_personnel_id)
  WHERE assigned_personnel_id IS NOT NULL
    AND is_deleted = false
    AND is_archived = false;

CREATE INDEX IF NOT EXISTS reports_assigned_by_admin_idx
  ON public.reports (assigned_by_admin_id)
  WHERE assigned_by_admin_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS archived_reports_assigned_personnel_idx
  ON public.archived_reports (assigned_personnel_id)
  WHERE assigned_personnel_id IS NOT NULL;

-- Keep the legacy Phase 2A synchronization trigger coherent with the new
-- fields. It also clears the display text and cleaning flag when a report FK
-- is removed by ON DELETE SET NULL.
CREATE OR REPLACE FUNCTION public.set_personnel_account_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.current_assignment_report_id IS NULL THEN
    NEW.is_cleaning = false;
    NEW.current_assignment = NULL;
    NEW.current_assignment_location = NULL;
    NEW.current_assignment_assigned_at = NULL;

    IF NEW.status = 'CLEANING' THEN
      NEW.status = 'OFFLINE';
    END IF;
  ELSE
    NEW.is_cleaning = true;
    IF NEW.status <> 'CLEANING' THEN
      NEW.status = 'CLEANING';
    END IF;
  END IF;

  IF NEW.deleted_at IS NOT NULL THEN
    NEW.enabled = false;
    -- A soft-deleted account may retain an auditable historical assignment;
    -- keep the cleaning relationship internally consistent until the report
    -- FK is cleared. Normal assignment paths reject such accounts up front.
    IF NEW.current_assignment_report_id IS NULL THEN
      NEW.is_cleaning = false;
      NEW.status = 'OFFLINE';
    END IF;
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS personnel_accounts_set_updated_at
  ON public.personnel_accounts;
CREATE TRIGGER personnel_accounts_set_updated_at
BEFORE UPDATE ON public.personnel_accounts
FOR EACH ROW
EXECUTE FUNCTION public.set_personnel_account_updated_at();

CREATE INDEX IF NOT EXISTS personnel_accounts_phase2b_busy_idx
  ON public.personnel_accounts (current_assignment_report_id, is_cleaning)
  WHERE current_assignment_report_id IS NOT NULL;

COMMENT ON COLUMN public.reports.assigned_personnel_id IS
  'Canonical active personnel account assigned to this report.';
COMMENT ON COLUMN public.reports.assigned_by_admin_id IS
  'Authenticated administrator who performed the assignment or reassignment.';
COMMENT ON COLUMN public.reports.assigned_at IS
  'Server-owned timestamp for the current assignment.';
COMMENT ON COLUMN public.personnel_accounts.is_cleaning IS
  'Server-owned cleaning flag synchronized with the current report assignment.';
COMMENT ON COLUMN public.personnel_accounts.current_assignment IS
  'Human-readable title of the current report assignment.';
COMMENT ON COLUMN public.personnel_accounts.profile_image IS
  'Optional server-managed personnel avatar URL.';

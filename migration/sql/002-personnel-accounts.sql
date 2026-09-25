-- Phase 2A: personnel account and assignment schema.
-- Run with: npm run migrate:personnel
-- This migration is safe to run repeatedly.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:phase-2a:personnel-accounts:v1')
);

CREATE SEQUENCE IF NOT EXISTS public.personnel_account_id_seq
  AS integer
  START WITH 1
  MINVALUE 1
  MAXVALUE 9999
  CACHE 1
  NO CYCLE;

CREATE OR REPLACE FUNCTION public.next_personnel_account_id()
RETURNS text
LANGUAGE sql
VOLATILE
AS $function$
  SELECT 'PERS-' || LPAD(nextval('public.personnel_account_id_seq')::text, 4, '0');
$function$;

CREATE TABLE IF NOT EXISTS public.personnel_accounts (
  personnel_id varchar(9) PRIMARY KEY
    DEFAULT public.next_personnel_account_id(),

  first_name varchar(100) NOT NULL,
  last_name varchar(100) NOT NULL,
  address text NOT NULL DEFAULT '',
  email varchar(255) NOT NULL,
  username varchar(50) NOT NULL,
  password_hash text NOT NULL,

  role varchar(30) NOT NULL DEFAULT 'PERSONNEL',
  status varchar(20) NOT NULL DEFAULT 'OFFLINE',
  last_active timestamptz,

  current_assignment_report_id varchar(50),
  current_assignment_location jsonb,
  current_assignment_assigned_at timestamptz,

  enabled boolean NOT NULL DEFAULT true,
  disabled_at timestamptz,
  deleted_at timestamptz,

  phone_number varchar(25),

  created_by_admin_id varchar(50),
  updated_by_admin_id varchar(50),
  disabled_by_admin_id varchar(50),
  deleted_by_admin_id varchar(50),

  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT personnel_accounts_id_format_ck
    CHECK (personnel_id ~ '^PERS-[0-9]{4}$'),

  CONSTRAINT personnel_accounts_first_name_ck
    CHECK (
      first_name = btrim(first_name)
      AND char_length(first_name) BETWEEN 1 AND 100
    ),

  CONSTRAINT personnel_accounts_last_name_ck
    CHECK (
      last_name = btrim(last_name)
      AND char_length(last_name) BETWEEN 1 AND 100
    ),

  CONSTRAINT personnel_accounts_address_ck
    CHECK (
      address = btrim(address)
      AND char_length(address) <= 300
    ),

  CONSTRAINT personnel_accounts_gmail_ck
    CHECK (
      email = lower(email)
      AND email ~ '^[a-z0-9._%+-]+@gmail\.com$'
    ),

  CONSTRAINT personnel_accounts_username_ck
    CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,49}$'),

  CONSTRAINT personnel_accounts_role_ck
    CHECK (role = 'PERSONNEL'),

  CONSTRAINT personnel_accounts_status_ck
    CHECK (status IN ('ONLINE', 'OFFLINE', 'CLEANING')),

  CONSTRAINT personnel_accounts_cleaning_assignment_ck
    CHECK (
      status <> 'CLEANING'
      OR current_assignment_report_id IS NOT NULL
    ),

  CONSTRAINT personnel_accounts_location_ck
    CHECK (
      current_assignment_location IS NULL
      OR jsonb_typeof(current_assignment_location) = 'object'
    ),

  CONSTRAINT personnel_accounts_phone_ck
    CHECK (
      phone_number IS NULL
      OR phone_number ~ '^[0-9+() .-]{7,25}$'
    ),

  CONSTRAINT personnel_accounts_disabled_state_ck
    CHECK (
      (enabled = true AND disabled_at IS NULL)
      OR (enabled = false AND disabled_at IS NOT NULL)
    ),

  CONSTRAINT personnel_accounts_deleted_state_ck
    CHECK (deleted_at IS NULL OR enabled = false),

  CONSTRAINT personnel_accounts_current_assignment_report_fk
    FOREIGN KEY (current_assignment_report_id)
    REFERENCES public.reports(report_id)
    ON UPDATE CASCADE
    ON DELETE SET NULL,

  CONSTRAINT personnel_accounts_created_by_admin_fk
    FOREIGN KEY (created_by_admin_id)
    REFERENCES public.admins(admin_id)
    ON UPDATE CASCADE
    ON DELETE SET NULL,

  CONSTRAINT personnel_accounts_updated_by_admin_fk
    FOREIGN KEY (updated_by_admin_id)
    REFERENCES public.admins(admin_id)
    ON UPDATE CASCADE
    ON DELETE SET NULL,

  CONSTRAINT personnel_accounts_disabled_by_admin_fk
    FOREIGN KEY (disabled_by_admin_id)
    REFERENCES public.admins(admin_id)
    ON UPDATE CASCADE
    ON DELETE SET NULL,

  CONSTRAINT personnel_accounts_deleted_by_admin_fk
    FOREIGN KEY (deleted_by_admin_id)
    REFERENCES public.admins(admin_id)
    ON UPDATE CASCADE
    ON DELETE SET NULL
);

-- Identity values remain reserved after disable/delete so a deleted account
-- cannot be impersonated by recreating the same username or Gmail address.
CREATE UNIQUE INDEX IF NOT EXISTS personnel_accounts_username_lower_uidx
  ON public.personnel_accounts (lower(username));

CREATE UNIQUE INDEX IF NOT EXISTS personnel_accounts_email_lower_uidx
  ON public.personnel_accounts (lower(email));

CREATE INDEX IF NOT EXISTS personnel_accounts_active_idx
  ON public.personnel_accounts (created_at DESC)
  WHERE enabled = true AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS personnel_accounts_status_idx
  ON public.personnel_accounts (status, last_active DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS personnel_accounts_assignment_idx
  ON public.personnel_accounts (current_assignment_report_id)
  WHERE current_assignment_report_id IS NOT NULL;

-- Serialize identity writes and enforce case-insensitive username/Gmail
-- uniqueness across Personnel, Resident, and Admin account namespaces. The
-- controller pre-checks remain for friendly errors; these triggers are the
-- final protection against concurrent requests.
CREATE OR REPLACE FUNCTION public.enforce_account_identity_uniqueness()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  normalized_username text;
  normalized_email text;
  current_identifier text;
  conflicting_account text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('myecowatch:account-identity-uniqueness:v1')
  );

  normalized_username := NULLIF(lower(btrim(NEW.username)), '');
  normalized_email := NULLIF(lower(btrim(NEW.email)), '');

  IF TG_TABLE_NAME = 'personnel_accounts' THEN
    current_identifier := NEW.personnel_id::text;
  ELSIF TG_TABLE_NAME = 'residents' THEN
    current_identifier := NEW.resident_id::text;
  ELSE
    current_identifier := NEW.admin_id::text;
  END IF;

  SELECT source
  INTO conflicting_account
  FROM (
    SELECT 'admins' AS source
    FROM public.admins
    WHERE lower(username) = normalized_username
      AND admin_id::text <> current_identifier

    UNION ALL

    SELECT 'residents' AS source
    FROM public.residents
    WHERE lower(username) = normalized_username
      AND resident_id::text <> current_identifier

    UNION ALL

    SELECT 'personnel_accounts' AS source
    FROM public.personnel_accounts
    WHERE lower(username) = normalized_username
      AND personnel_id::text <> current_identifier

    UNION ALL

    SELECT 'admins' AS source
    FROM public.admins
    WHERE email IS NOT NULL
      AND lower(email) = normalized_email
      AND admin_id::text <> current_identifier

    UNION ALL

    SELECT 'residents' AS source
    FROM public.residents
    WHERE email IS NOT NULL
      AND lower(email) = normalized_email
      AND resident_id::text <> current_identifier

    UNION ALL

    SELECT 'personnel_accounts' AS source
    FROM public.personnel_accounts
    WHERE lower(email) = normalized_email
      AND personnel_id::text <> current_identifier
  ) conflicts
  LIMIT 1;

  IF conflicting_account IS NOT NULL THEN
    RAISE EXCEPTION 'Username or email is already registered'
      USING
        ERRCODE = '23505',
        CONSTRAINT = 'account_identity_unique',
        SCHEMA = 'public',
        TABLE = TG_TABLE_NAME;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS account_identity_uniqueness_admins
  ON public.admins;
CREATE TRIGGER account_identity_uniqueness_admins
BEFORE INSERT OR UPDATE OF username, email ON public.admins
FOR EACH ROW
EXECUTE FUNCTION public.enforce_account_identity_uniqueness();

DROP TRIGGER IF EXISTS account_identity_uniqueness_residents
  ON public.residents;
CREATE TRIGGER account_identity_uniqueness_residents
BEFORE INSERT OR UPDATE OF username, email ON public.residents
FOR EACH ROW
EXECUTE FUNCTION public.enforce_account_identity_uniqueness();

DROP TRIGGER IF EXISTS account_identity_uniqueness_personnel
  ON public.personnel_accounts;
CREATE TRIGGER account_identity_uniqueness_personnel
BEFORE INSERT OR UPDATE OF username, email ON public.personnel_accounts
FOR EACH ROW
EXECUTE FUNCTION public.enforce_account_identity_uniqueness();

CREATE OR REPLACE FUNCTION public.set_personnel_account_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- ON DELETE SET NULL from reports must also terminate the cleaning state.
  IF NEW.current_assignment_report_id IS NULL THEN
    NEW.current_assignment_location = NULL;
    NEW.current_assignment_assigned_at = NULL;

    IF NEW.status = 'CLEANING' THEN
      NEW.status = 'OFFLINE';
    END IF;
  END IF;

  IF NEW.deleted_at IS NOT NULL THEN
    NEW.enabled = false;
    NEW.status = 'OFFLINE';
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS personnel_accounts_set_updated_at ON public.personnel_accounts;
CREATE TRIGGER personnel_accounts_set_updated_at
BEFORE UPDATE ON public.personnel_accounts
FOR EACH ROW
EXECUTE FUNCTION public.set_personnel_account_updated_at();

COMMENT ON TABLE public.personnel_accounts IS
  'Admin-managed environmental services personnel accounts. Personnel cannot self-register.';
COMMENT ON COLUMN public.personnel_accounts.current_assignment_report_id IS
  'The report currently being handled by this personnel account.';
COMMENT ON COLUMN public.personnel_accounts.current_assignment_location IS
  'Location snapshot captured from the current report assignment.';

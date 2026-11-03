-- Migration 026: Let an administrator manage a reporter (resident) account.
--
-- Run with: npm run migrate:reporter-account-management
-- This migration is additive/idempotent and safe to re-run.
--
-- ---------------------------------------------------------------------------
-- Why this is needed
-- ---------------------------------------------------------------------------
-- An administrator can already reset a personnel password and disable a
-- personnel account. Reporters had no equivalent: /api/auth/disable-account is
-- mounted `protect, protectResident`, so it pauses the CALLER's own account and
-- an administrator token can never aim it at somebody else. Until this
-- migration the admin reporter-detail screen could show an account but not act
-- on it.
--
-- ---------------------------------------------------------------------------
-- 1. disabled_by_admin_id
-- ---------------------------------------------------------------------------
-- The pause itself needs no new column. residents.status already blocks
-- authentication for every status in DISABLED_RESIDENT_STATUSES, and
-- `disabled_by_resident` is already the marker that keeps a pause reversible:
-- the login path restores an account ONLY when that marker is true, so an
-- administrator disable is simply a pause WITHOUT the marker and the resident
-- can never undo it by signing in again.
--
-- What was missing is attribution: residents recorded who paused themselves
-- but not who disabled them, so an account disabled by an administrator was
-- indistinguishable from one the resident had left behind. This column is the
-- same bookkeeping personnel_accounts.disabled_by_admin_id carries, so the two
-- account types answer "who did this" the same way. It is nullable and is
-- never cleared by a self-service pause, matching disabled_at.

ALTER TABLE public.residents
  ADD COLUMN IF NOT EXISTS disabled_by_admin_id character varying(30);

COMMENT ON COLUMN public.residents.disabled_by_admin_id IS
  'Administrator who disabled this reporter account. NULL for an account that was never disabled by an administrator, including one the resident paused themselves.';

-- ON DELETE SET NULL, like the personnel equivalent: deleting an administrator
-- must not delete or unblock a reporter account, it only removes the
-- attribution. Added in a DO block so re-running the migration after the column
-- already exists cannot fail on the constraint name.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'residents_disabled_by_admin_fk'
  ) THEN
    ALTER TABLE public.residents
      ADD CONSTRAINT residents_disabled_by_admin_fk
      FOREIGN KEY (disabled_by_admin_id)
      REFERENCES public.admins(admin_id)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. A subject kind for reporter rows in the Admin History trail
-- ---------------------------------------------------------------------------
-- A credential reset and an account disable are account-management decisions,
-- so they belong under the ACCOUNT tab, but they are about a reporter and have
-- no report to join to. The trail denormalises the subject onto the row
-- (migration 024) and the database constrains the subject kind, so RESIDENT
-- has to be admitted before such a row can be written at all.
--
-- The CHECK is dropped and recreated rather than altered: Postgres has no
-- "add a value to a CHECK" operation, and the constraint is the final authority
-- on the vocabulary, so it has to be restated in full.
ALTER TABLE report_histories
  DROP CONSTRAINT IF EXISTS report_histories_subject_type_ck;

ALTER TABLE report_histories
  ADD CONSTRAINT report_histories_subject_type_ck
  CHECK (
    subject_type IS NULL
    OR subject_type IN ('ANNOUNCEMENT', 'PERSONNEL', 'RESIDENT')
  );

-- ---------------------------------------------------------------------------
-- Nothing is rewritten
-- ---------------------------------------------------------------------------
-- Every existing row keeps its NULL category and subject, so no decision an
-- administrator already made moves tab or changes shape. The two columns and
-- the widened CHECK are the whole change.
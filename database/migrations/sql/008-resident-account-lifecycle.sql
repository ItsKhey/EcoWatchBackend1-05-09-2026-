-- Resident self-service account lifecycle: pause (disable) and permanent delete.
-- Run with: npm run migrate:resident-account-lifecycle
-- This migration is additive/idempotent and safe to run after Phase 2C.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:phase-2d:resident-account-lifecycle:v1')
);

-- ---------------------------------------------------------------------------
-- Self-service pause bookkeeping
-- ---------------------------------------------------------------------------
-- residents.status already blocks authentication for disabled accounts, so the
-- pause itself needs no new lifecycle column. The two columns below only record
-- *who* paused the account, which is what makes the pause reversible: the next
-- successful login restores only a self-paused account, while an account
-- disabled by an administrator stays blocked.
--
-- No column is ever cleared by a pause. Profile, reports, history and settings
-- are all left untouched, so restoring the account returns the resident to
-- exactly the state they left.

ALTER TABLE public.residents
  ADD COLUMN IF NOT EXISTS disabled_by_resident boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

COMMENT ON COLUMN public.residents.disabled_by_resident IS
  'True when the resident paused their own account; only this state is auto-restored on the next successful login.';

COMMENT ON COLUMN public.residents.disabled_at IS
  'Server-owned timestamp of the most recent self-service account pause.';

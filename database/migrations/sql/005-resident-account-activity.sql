-- Add server-owned activity metadata for resident/reporter accounts.
-- Run this idempotent migration against Supabase before deploying the admin
-- reporter-account endpoints. Existing timestamps are used only as a safe
-- initial value; subsequent activity is written by the auth middleware.

ALTER TABLE public.residents
  ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ;

UPDATE public.residents
SET last_active = COALESCE(last_active, updated_at, created_at)
WHERE last_active IS NULL;

CREATE INDEX IF NOT EXISTS idx_residents_last_active
  ON public.residents (last_active DESC);

CREATE INDEX IF NOT EXISTS idx_reports_resident_created_at
  ON public.reports (resident_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_archived_reports_resident_created_at
  ON public.archived_reports (resident_id, created_at DESC);

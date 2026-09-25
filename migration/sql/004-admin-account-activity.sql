-- Add server-owned activity metadata for the authenticated administrator.
-- Run this idempotent migration against Supabase before deploying the admin
-- account-details endpoint.

ALTER TABLE public.admins
  ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ;

-- Existing accounts may predate activity tracking. Use their latest
-- server-owned profile timestamp as a safe initial value.
UPDATE public.admins
SET last_active = COALESCE(last_active, updated_at, created_at, NOW())
WHERE last_active IS NULL;

CREATE INDEX IF NOT EXISTS idx_admins_last_active
  ON public.admins (last_active DESC);

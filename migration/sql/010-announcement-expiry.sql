-- Administrator-chosen expiry deadline for announcements.
-- Run with: npm run migrate:announcement-expiry
-- This migration is safe to run repeatedly.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:announcements:v1')
);

-- When the announcement stops being delivered and becomes eligible for
-- permanent deletion. Computed server-side at publish time from the
-- administrator's chosen window, so a skewed device clock cannot extend or
-- shorten the deadline.
--
-- NULL means the announcement does not expire on a timer. Existing rows land
-- here, so no announcement disappears the moment this migration is applied.
ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL;

-- The nightly cleanup scans only rows that actually have a deadline, and the
-- read queries use the same partial index to hide expired rows immediately
-- rather than waiting for the job to run.
CREATE INDEX IF NOT EXISTS idx_announcements_expires_at
  ON public.announcements (expires_at)
  WHERE expires_at IS NOT NULL;

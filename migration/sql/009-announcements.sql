-- CENRO announcements broadcast to residents.
-- Run with: npm run migrate:announcements
-- This migration is safe to run repeatedly.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:announcements:v1')
);

CREATE TABLE IF NOT EXISTS public.announcements (
  id bigserial PRIMARY KEY,

  -- Server-owned record of who published the announcement.
  created_by_admin_id varchar(255),

  title varchar(150) NOT NULL,
  message text NOT NULL,

  -- 'ALL_RESIDENTS' is the only audience that can be published today.
  -- 'BARANGAY' and 'SELECTED_RESIDENTS' are reserved so the stored row can
  -- already carry the target before the matching UI goes live.
  -- The CHECK names the column itself, so the database is the final authority
  -- on the allowed values rather than the application alone.
  audience varchar(32) NOT NULL DEFAULT 'ALL_RESIDENTS'
    CHECK (audience IN ('ALL_RESIDENTS', 'BARANGAY', 'SELECTED_RESIDENTS')),

  -- NULL for the whole-city broadcast; otherwise the future barangay scope.
  barangay varchar(150),

  -- NULL for a broadcast; otherwise the future explicit resident selection.
  target_resident_ids text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- 'NORMAL' or 'IMPORTANT'. Drives resident-side prominence only; it never
  -- changes who may read the announcement.
  priority varchar(16) NOT NULL DEFAULT 'NORMAL'
    CHECK (priority IN ('NORMAL', 'IMPORTANT')),

  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz
);

-- The dashboard lists newest first.
CREATE INDEX IF NOT EXISTS idx_announcements_created_at
  ON public.announcements (created_at DESC, id DESC);

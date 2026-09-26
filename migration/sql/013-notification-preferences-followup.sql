-- Custom notification sound, and the administrator-side preference record.
-- Run with: npm run migrate:notification-preferences-followup
-- This migration is safe to run repeatedly.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:notification-preferences:v1')
);

-- ---------------------------------------------------------------------------
-- Resident: custom sound
-- ---------------------------------------------------------------------------
-- The chosen ringtone was previously device-local, so it was lost on reinstall
-- and disagreed between two devices on the same account. Storing it here means
-- the whole settings screen survives a restore.
--
-- NULL means "use the device default", which is the state a resident who never
-- opened the sound picker is in.
ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS sound_uri text NULL;

COMMENT ON COLUMN public.notification_preferences.sound_uri IS
  'Custom notification ringtone chosen by the resident. NULL uses the device default.';

-- ---------------------------------------------------------------------------
-- Administrator preferences
-- ---------------------------------------------------------------------------
-- The Admin app carries 13 notification toggles, all of them device-local until
-- now. The columns mirror that model so the whole screen can round-trip, even
-- though the backend only produces a subset of those event types today: an
-- unsyncable toggle is the same bug as an unenforced one.
--
-- Defaults are TRUE so an absent row fails open, matching the resident table.
CREATE TABLE IF NOT EXISTS public.admin_notification_preferences (
  admin_id varchar(255) PRIMARY KEY
    REFERENCES public.admins(admin_id) ON DELETE CASCADE,

  master_enabled boolean NOT NULL DEFAULT true,

  -- Report-facing categories (the Admin app's legacy names).
  report_status_updates boolean NOT NULL DEFAULT true,
  report_completed boolean NOT NULL DEFAULT true,
  report_denied boolean NOT NULL DEFAULT true,
  cenro_announcements boolean NOT NULL DEFAULT true,
  security_alerts boolean NOT NULL DEFAULT true,

  -- Personnel / operations categories.
  high_priority_reports boolean NOT NULL DEFAULT true,
  personnel_accepted boolean NOT NULL DEFAULT true,
  personnel_cleaning boolean NOT NULL DEFAULT true,
  photo_updates boolean NOT NULL DEFAULT true,
  awaiting_approval boolean NOT NULL DEFAULT true,
  archived_reports boolean NOT NULL DEFAULT true,
  maintenance_alerts boolean NOT NULL DEFAULT true,

  sound_enabled boolean NOT NULL DEFAULT true,
  vibration_enabled boolean NOT NULL DEFAULT true,
  sound_uri text NULL,

  updated_at timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.admin_notification_preferences IS
  'Per-administrator notification choices. Absence of a row means every category is enabled.';

ALTER TABLE public.admin_notification_preferences ENABLE ROW LEVEL SECURITY;

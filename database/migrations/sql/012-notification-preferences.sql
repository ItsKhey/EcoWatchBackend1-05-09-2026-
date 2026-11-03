-- Server-owned notification preferences, so a resident's choices can actually
-- be honoured when the backend decides who to push to.
-- Run with: npm run migrate:notification-preferences
-- This migration is safe to run repeatedly.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:notification-preferences:v1')
);

-- One row per resident account, not per device. The previous behaviour kept
-- these choices in a device-local table, which meant they were lost on
-- reinstall, disagreed between two devices on the same account, and were
-- invisible to the server so it could never suppress a push.
CREATE TABLE IF NOT EXISTS public.notification_preferences (
  resident_id varchar(255) PRIMARY KEY
    REFERENCES public.residents(resident_id) ON DELETE CASCADE,

  -- Master switch. Defaults to TRUE so a resident with no row at all still
  -- receives pushes: for an emergency notice, failing open is the safe
  -- direction. A missing row must never mean silence.
  master_enabled boolean NOT NULL DEFAULT true,

  report_status_updates boolean NOT NULL DEFAULT true,
  report_completed boolean NOT NULL DEFAULT true,
  report_denied boolean NOT NULL DEFAULT true,

  -- Backs the "CENRO Announcements" toggle in the Resident app, and is the
  -- switch consulted before an announcement push is sent.
  cenro_announcements boolean NOT NULL DEFAULT true,
  security_alerts boolean NOT NULL DEFAULT true,

  -- Presentation preferences. Recorded here so the full settings screen can be
  -- restored on a new device, even though the push decision does not read them.
  sound_enabled boolean NOT NULL DEFAULT true,
  vibration_enabled boolean NOT NULL DEFAULT true,

  updated_at timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.notification_preferences IS
  'Per-resident notification choices. Absence of a row means every category is enabled.';

COMMENT ON COLUMN public.notification_preferences.master_enabled IS
  'When false no push is sent at all. Defaults true so an absent row fails open.';

COMMENT ON COLUMN public.notification_preferences.cenro_announcements IS
  'Whether to push CENRO announcements. Muting suppresses the push only; the announcement still appears in the feed and the Alerts list.';

-- The broadcast reads preferences for every token holder, so a lookup by
-- resident_id is the hot path. The primary key already covers it; this index
-- is unnecessary and intentionally omitted.

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

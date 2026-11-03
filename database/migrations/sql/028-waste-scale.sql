-- Migration 028: Waste scale, cleaning teams, and collection-vehicle dispatch
--
-- A resident now says how big their problem is when they file a report: a
-- Small-, Medium- or Large-Scale Waste. That single label decides how much has
-- to be sent to the site:
--
--   Small-Scale Waste  -> one individual personnel member.
--   Medium-Scale Waste -> a cleaning team.
--   Large-Scale Waste  -> a cleaning team plus a collection vehicle.
--
-- Until now an assignment could only ever be one person, and the only vehicle
-- concept in the system was "the truck this one driver owns" on
-- personnel_accounts. That cannot express a crew turning out with a truck, so
-- this migration adds:
--
--   1. reports.waste_scale          - the scale the resident filed under.
--   2. cleaning_teams                - a reusable crew, with its members.
--   3. reports.assigned_team_id      - the team put on the job.
--   4. reports.assigned_vehicle_id   - the truck put on the job.
--   5. personnel_assignments.team/vehicle - so the cleaner app can show the
--      crew and the vehicle on the task it is working on.
--
-- Idempotent so it can be re-run on an already-migrated database.

-- 1. The scale the resident chose, plus the crew and vehicle dispatched.
--
--    The scale is nullable so reports filed before this migration keep
--    working; the server treats a missing scale as Small-Scale Waste when it
--    validates an assignment.
ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS waste_scale varchar(30);

COMMENT ON COLUMN public.reports.waste_scale IS
  'How big the reported waste is: Small-Scale Waste, Medium-Scale Waste or Large-Scale Waste. Chosen by the resident when filing and fixed by the server so the administrator assigns a crew that matches it.';

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS assigned_team_id text;

COMMENT ON COLUMN public.reports.assigned_team_id IS
  'The cleaning team dispatched to this report. Set for Medium- and Large-Scale Waste.';

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS assigned_vehicle_id varchar(8);

COMMENT ON COLUMN public.reports.assigned_vehicle_id IS
  'The collection vehicle dispatched to this report. Only Large-Scale Waste carries one.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reports_waste_scale_ck'
  ) THEN
    ALTER TABLE reports
      ADD CONSTRAINT reports_waste_scale_ck
      CHECK (
        waste_scale IS NULL
        OR waste_scale IN ('Small-Scale Waste', 'Medium-Scale Waste', 'Large-Scale Waste')
      );
  END IF;
END
$$;

-- 2. The archived copy of a report keeps the same three columns, so the
--    resident's history view and the admin's archive read the same values the
--    active report carried.
ALTER TABLE archived_reports
  ADD COLUMN IF NOT EXISTS waste_scale varchar(30);

ALTER TABLE archived_reports
  ADD COLUMN IF NOT EXISTS assigned_team_id text;

ALTER TABLE archived_reports
  ADD COLUMN IF NOT EXISTS assigned_vehicle_id varchar(8);

-- trash_reports is only a marker table (report_id, resident_id, deleted_at);
-- the report row itself stays in `reports` and is read from there, so the
-- trashed view picks the scale up for free.

-- 3. Cleaning teams.
--
--    A team is a named group of personnel the administrator maintains once and
--    then dispatches as a unit. The membership table is what lets the
--    assignment carry "the team" rather than a hand-picked list of names, so
--    the crew stays consistent across reports.
CREATE SEQUENCE IF NOT EXISTS public.cleaning_team_id_seq
  AS integer
  START WITH 1
  MINVALUE 1
  MAXVALUE 9999
  CACHE 1
  NO CYCLE;

CREATE OR REPLACE FUNCTION public.next_cleaning_team_id()
RETURNS text
LANGUAGE sql
VOLATILE
AS $function$
  SELECT 'TEAM-' || LPAD(nextval('public.cleaning_team_id_seq')::text, 4, '0');
$function$;

CREATE TABLE IF NOT EXISTS public.cleaning_teams (
  team_id             TEXT        PRIMARY KEY
    DEFAULT public.next_cleaning_team_id(),
  team_name           VARCHAR(80) NOT NULL,
  description         TEXT,
  -- The team this one answers to. A team may be a subgroup of a bigger crew,
  -- which is what lets a Large-Scale job name the specialist subgroup.
  parent_team_id      TEXT
    REFERENCES public.cleaning_teams (team_id)
    ON UPDATE CASCADE ON DELETE SET NULL,

  is_deleted          BOOLEAN     NOT NULL DEFAULT false,
  deleted_at          TIMESTAMPTZ,

  created_by_admin_id VARCHAR(50),
  updated_by_admin_id VARCHAR(50),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT cleaning_teams_id_format_ck
    CHECK (team_id ~ '^TEAM-[0-9]{4}$'),

  CONSTRAINT cleaning_teams_name_ck
    CHECK (
      team_name = btrim(team_name)
      AND char_length(team_name) BETWEEN 2 AND 80
    )
);

CREATE INDEX IF NOT EXISTS idx_cleaning_teams_name
  ON public.cleaning_teams (team_name);

-- The membership table. A personnel account can sit on more than one team
-- (a driver can also be on the general crew), so the pair is the key rather
-- than the personnel id.
CREATE TABLE IF NOT EXISTS public.cleaning_team_members (
  team_id             TEXT        NOT NULL
    REFERENCES public.cleaning_teams (team_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  personnel_id        TEXT        NOT NULL
    REFERENCES public.personnel_accounts (personnel_id)
    ON UPDATE CASCADE ON DELETE CASCADE,

  added_by_admin_id   VARCHAR(50),
  added_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (team_id, personnel_id)
);

CREATE INDEX IF NOT EXISTS idx_cleaning_team_members_personnel
  ON public.cleaning_team_members (personnel_id);

-- 4. The assignment row carries the crew and the truck.
--
--    The cleaner app renders the task it is working on, so the team and the
--    vehicle have to travel with the assignment rather than be re-derived from
--    the report at read time.
ALTER TABLE personnel_assignments
  ADD COLUMN IF NOT EXISTS assigned_team_id text;

ALTER TABLE personnel_assignments
  ADD COLUMN IF NOT EXISTS assigned_vehicle_id varchar(8);

ALTER TABLE personnel_assignments
  ADD COLUMN IF NOT EXISTS waste_scale varchar(30);

-- The relationships are protected, not just documented. A report that points
-- at a crew or a truck that does not exist is a dispatch that cannot happen,
-- and it is much easier to catch here than on the field.
--
-- ON DELETE SET NULL because a team or a truck is removed softly: the row
-- stays, and a report that was worked by it keeps its history.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reports_assigned_team_fk'
  ) THEN
    ALTER TABLE reports
      ADD CONSTRAINT reports_assigned_team_fk
      FOREIGN KEY (assigned_team_id)
      REFERENCES public.cleaning_teams (team_id)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reports_assigned_vehicle_fk'
  ) THEN
    ALTER TABLE reports
      ADD CONSTRAINT reports_assigned_vehicle_fk
      FOREIGN KEY (assigned_vehicle_id)
      REFERENCES public.vehicles (vehicle_id)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'personnel_assignments_team_fk'
  ) THEN
    ALTER TABLE personnel_assignments
      ADD CONSTRAINT personnel_assignments_team_fk
      FOREIGN KEY (assigned_team_id)
      REFERENCES public.cleaning_teams (team_id)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'personnel_assignments_vehicle_fk'
  ) THEN
    ALTER TABLE personnel_assignments
      ADD CONSTRAINT personnel_assignments_vehicle_fk
      FOREIGN KEY (assigned_vehicle_id)
      REFERENCES public.vehicles (vehicle_id)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'personnel_assignments_waste_scale_ck'
  ) THEN
    ALTER TABLE personnel_assignments
      ADD CONSTRAINT personnel_assignments_waste_scale_ck
      CHECK (
        waste_scale IS NULL
        OR waste_scale IN ('Small-Scale Waste', 'Medium-Scale Waste', 'Large-Scale Waste')
      );
  END IF;
END
$$;

-- 5. A report can now be worked by more than one person at a time.
--
--    Migration 022 created a unique index that allowed only ONE live
--    assignment per report, because until now a report could only ever be
--    assigned to one cleaner. A Medium- or Large-Scale Waste needs the whole
--    crew, so that index has to become one per report AND person.
DROP INDEX IF EXISTS personnel_assignments_active_report_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS personnel_assignments_active_report_personnel_uidx
  ON personnel_assignments (report_id, personnel_id)
  WHERE status IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS');

-- 6. Backfill: every report filed before this migration is Small-Scale Waste,
--    because that is the only way a report could be handled before (one
--    person, no vehicle). Marking them keeps the administrator's assignment
--    screen from asking about a crew that was never there.
UPDATE reports
   SET waste_scale = 'Small-Scale Waste'
 WHERE waste_scale IS NULL;

UPDATE archived_reports
   SET waste_scale = 'Small-Scale Waste'
 WHERE waste_scale IS NULL;

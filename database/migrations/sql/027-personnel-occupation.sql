-- Migration 027: Personnel occupation and assigned vehicle.
--
-- Run with: npm run migrate:personnel-occupation
-- This migration is additive/idempotent and safe to re-run.
--
-- ---------------------------------------------------------------------------
-- Why this is needed
-- ---------------------------------------------------------------------------
-- The Admin app's Personnel screen now has an occupation dropdown on the
-- registration form, and the fleet list already exists (migration 025) but had
-- nothing on the other side of the join: no personnel row could say which truck
-- it drives. Every account registered before this migration is a Regular
-- cleaner, which is exactly right, so the backfill is the DEFAULT rather than a
-- rewrite.
--
-- The two columns answer two different questions and are deliberately not one:
--
--   occupation          What this person does. Regular walks the route, Driver
--                       also drives. Two values, because a role nobody can filter
--                       on is a role the fleet cannot be matched against.
--
--   assigned_vehicle_id Which truck this person drives. Nullable, because a
--                       Driver with no truck yet is a real state: the office
--                       hired the driver before a vehicle was free. The Admin
--                       form only forces a choice when the fleet actually has an
--                       available truck to offer, and a database constraint that
--                       demanded one here would refuse a perfectly valid hire.
--
-- NOTE: assigning a driver does NOT change the vehicle's status. Vehicle status
-- ('Available' / 'Assigned' / 'Maintenance') describes what the truck is doing
-- right now, and 'Assigned' there means out on a collection, which is driven by
-- report dispatch. Overloading it with "has a driver" would make a truck parked
-- in the depot read as Assigned on the fleet cards while it is doing nothing.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:personnel-occupation:v1')
);

-- ---------------------------------------------------------------------------
-- 1. occupation
-- ---------------------------------------------------------------------------
-- NOT NULL with a DEFAULT, matching how `status` and `role` are declared on
-- this table. Adding a column with a non-volatile constant default backfills
-- every existing row without a table rewrite, so the roster that already exists
-- becomes Regular without anyone touching it.
ALTER TABLE public.personnel_accounts
  ADD COLUMN IF NOT EXISTS occupation varchar(20) NOT NULL DEFAULT 'Regular';

COMMENT ON COLUMN public.personnel_accounts.occupation IS
  'What this personnel member does: ''Regular'' walks the collection route, ''Driver'' also drives one of the fleet vehicles. Existing accounts are backfilled as ''Regular''.';

-- The CHECK is dropped and recreated rather than altered: Postgres has no "add a
-- value to a CHECK" operation, and this constraint is the final authority on the
-- vocabulary, so it has to be restated in full. Existing rows satisfy it, which
-- is why adding it cannot fail on a populated table.
ALTER TABLE public.personnel_accounts
  DROP CONSTRAINT IF EXISTS personnel_accounts_occupation_ck;

ALTER TABLE public.personnel_accounts
  ADD CONSTRAINT personnel_accounts_occupation_ck
  CHECK (occupation IN ('Regular', 'Driver'));

-- ---------------------------------------------------------------------------
-- 2. assigned_vehicle_id
-- ---------------------------------------------------------------------------
-- No DEFAULT: "no truck" is the correct value for every existing account and for
-- every Regular cleaner, and a sentinel like '' would only turn one kind of
-- missing value into another.
ALTER TABLE public.personnel_accounts
  ADD COLUMN IF NOT EXISTS assigned_vehicle_id varchar(8);

COMMENT ON COLUMN public.personnel_accounts.assigned_vehicle_id IS
  'The fleet vehicle this personnel member drives. NULL for a Regular cleaner, and NULL for a Driver who has not been given a truck yet.';

-- A cleaner has no truck. This is the one half of the pair the database can
-- settle on its own, because it does not depend on whether the fleet currently
-- has anything to give: a Regular carrying a vehicle is a contradiction whoever
-- else is driving that truck. The other half (a Driver must have a truck) is
-- deliberately NOT constrained, per the note at the top.
ALTER TABLE public.personnel_accounts
  DROP CONSTRAINT IF EXISTS personnel_accounts_occupation_vehicle_ck;

ALTER TABLE public.personnel_accounts
  ADD CONSTRAINT personnel_accounts_occupation_vehicle_ck
  CHECK (occupation <> 'Regular' OR assigned_vehicle_id IS NULL);

-- ON DELETE SET NULL for the same reason the report assignment uses it: a truck
-- removed from the fleet must not take the driver's account with it. Because
-- vehicles are soft-deleted this fires only on a hard delete, and nulling the
-- column leaves a Driver who simply has no truck yet, which the occupation
-- constraint above still allows.
--
-- Added in a DO block so re-running the migration after the constraint already
-- exists cannot fail on the constraint name.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'personnel_accounts_assigned_vehicle_fk'
  ) THEN
    ALTER TABLE public.personnel_accounts
      ADD CONSTRAINT personnel_accounts_assigned_vehicle_fk
      FOREIGN KEY (assigned_vehicle_id)
      REFERENCES public.vehicles(vehicle_id)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. One driver per truck
-- ---------------------------------------------------------------------------
-- A garbage truck is driven by one person. Handing the same VEH-0001 to two
-- drivers would make "who is driving this" unanswerable on the personnel card,
-- so the database refuses it rather than letting the Admin form decide by
-- remembering.
--
-- A DISABLED account releases the truck, which is why the predicate covers both
-- enabled and live rows rather than just deleted ones. A paused account cannot
-- sign in and therefore cannot drive, so leaving it holding the vehicle would
-- stop an office with one truck from ever handing that truck to somebody else.
-- Re-enabling a driver who was reassigned while paused is the deliberate cost of
-- that choice, and it is reported as the same 409 as any other double booking
-- rather than as a constraint failure.
CREATE UNIQUE INDEX IF NOT EXISTS uq_personnel_assigned_vehicle
  ON public.personnel_accounts (assigned_vehicle_id)
  WHERE assigned_vehicle_id IS NOT NULL
    AND enabled = true
    AND deleted_at IS NULL;

-- Reading "which driver is on this truck" goes the other way round from the
-- uniqueness check above, and the fleet screen needs it per vehicle rather than
-- per personnel row.
CREATE INDEX IF NOT EXISTS idx_personnel_assigned_vehicle
  ON public.personnel_accounts (assigned_vehicle_id)
  WHERE assigned_vehicle_id IS NOT NULL
    AND enabled = true
    AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Nothing is rewritten
-- ---------------------------------------------------------------------------
-- Every existing account keeps its identity, assignments and credentials, and
-- simply reads as occupation = 'Regular' with no vehicle. The two columns, the
-- two CHECKs, the foreign key and the indexes are the whole change.
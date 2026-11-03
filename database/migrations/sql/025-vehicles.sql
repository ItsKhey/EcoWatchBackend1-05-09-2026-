-- Migration 025: Vehicle fleet.
-- Run with: npm run migrate:vehicles
-- This migration is safe to run repeatedly.

-- The fleet is the counterpart to the personnel roster: the Admin app's
-- Personnel screen now carries a Personnel/Vehicles selector, and each side has
-- its own counts, filters and cards. Nothing about personnel changes here.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:vehicles:v1')
);

-- Identifiers follow the same shape as personnel accounts so the two read
-- alike in a list: VEH-0001, VEH-0002, ... Four digits is deliberate, it caps
-- the fleet at 9,999 vehicles which is far beyond any barangay's need and keeps
-- the id a fixed-width VARCHAR the way personnel_id is.
CREATE SEQUENCE IF NOT EXISTS public.vehicle_id_seq
  AS integer
  START WITH 1
  MINVALUE 1
  MAXVALUE 9999
  CACHE 1
  NO CYCLE;

CREATE OR REPLACE FUNCTION public.next_vehicle_id()
RETURNS text
LANGUAGE sql
VOLATILE
AS $function$
  SELECT 'VEH-' || LPAD(nextval('public.vehicle_id_seq')::text, 4, '0');
$function$;

CREATE TABLE IF NOT EXISTS public.vehicles (
  vehicle_id varchar(8) PRIMARY KEY
    DEFAULT public.next_vehicle_id(),

  -- The plate is how a vehicle is recognised in the field, so it is the natural
  -- unique key. It is unique across the table rather than per status, because a
  -- number plate is not reissued for a different truck.
  plate_number varchar(20) NOT NULL,

  vehicle_type varchar(60) NOT NULL DEFAULT '',

  -- Free text on purpose. "1.5 tons", "500 kg", "2.5 m³" are all real answers and
  -- forcing one unit onto the column would make one of them a lie or an empty
  -- field. Stored as written so the details form round-trips exactly.
  rated_load_capacity varchar(40),

  -- One mutually exclusive status, matching the three cards the Admin screen
  -- shows: Total / Available / Assigned. Maintenance is its own status rather
  -- than a flag alongside Assigned so a truck under servicing can never also be
  -- counted as out on a collection.
  status varchar(20) NOT NULL DEFAULT 'Available',

  -- What the vehicle is currently on. Set when it is dispatched and cleared
  -- when the collection finishes, so 'Assigned' with nothing to show is a bug
  -- the details screen can surface rather than a normal state.
  current_report_id varchar(50),
  current_cluster_id varchar(20),
  assigned_at timestamptz,

  last_service_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT NOW(),

  notes text,

  is_deleted boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,

  created_by_admin_id varchar(50),
  updated_by_admin_id varchar(50),

  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT vehicles_id_format_ck
    CHECK (vehicle_id ~ '^VEH-[0-9]{4}$'),

  CONSTRAINT vehicles_status_ck
    CHECK (status IN ('Available', 'Assigned', 'Maintenance')),

  -- Plate numbers are matched case-insensitively all over the UI, so a plate
  -- that differs only by case would look like a free slot to a human while
  -- colliding on save. Storing it upper-cased makes the uniqueness honest.
  CONSTRAINT vehicles_plate_number_upper_ck
    CHECK (plate_number = upper(btrim(plate_number))),

  CONSTRAINT vehicles_plate_number_ck
    CHECK (
      plate_number = btrim(plate_number)
      AND char_length(plate_number) BETWEEN 2 AND 20
    ),

  CONSTRAINT vehicles_vehicle_type_ck
    CHECK (
      vehicle_type = btrim(vehicle_type)
      AND char_length(vehicle_type) <= 60
    ),

  CONSTRAINT vehicles_assigned_has_report_ck
    CHECK (status <> 'Assigned' OR current_report_id IS NOT NULL)
);

-- Plate uniqueness is enforced by a unique index rather than a UNIQUE constraint
-- so a soft-deleted vehicle can release its plate for reissue. A vehicle removed
-- from the fleet is still on the row, and without this its number plate would be
-- permanently unusable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicles_plate_number
  ON public.vehicles (plate_number)
  WHERE is_deleted = false;

-- The list screen is filtered by status and ordered by recent activity.
CREATE INDEX IF NOT EXISTS idx_vehicles_status
  ON public.vehicles (status, last_activity_at DESC)
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_vehicles_activity
  ON public.vehicles (last_activity_at DESC)
  WHERE is_deleted = false;

-- A vehicle dispatched to a report is found from that report, so the lookup
-- goes the other way round from the status index above.
CREATE INDEX IF NOT EXISTS idx_vehicles_current_report
  ON public.vehicles (current_report_id)
  WHERE is_deleted = false AND current_report_id IS NOT NULL;

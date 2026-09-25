-- Normalize legacy migrated admin IDs without changing resident IDs.
-- Run once against the production database before creating new personnel.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:admin-identifiers:v1')
);

DO $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM admins legacy
    JOIN admins canonical
      ON canonical.admin_id = regexp_replace(legacy.admin_id, '^RES-', 'ADM-')
    WHERE legacy.role = 'ADMIN'
      AND legacy.admin_id ~ '^RES-[A-Z0-9]{8}$'
      AND canonical.admin_id <> legacy.admin_id
  ) THEN
    RAISE EXCEPTION 'Cannot normalize admin IDs because an ADM ID already exists';
  END IF;
END
$function$;

UPDATE admins
SET admin_id = regexp_replace(admin_id, '^RES-', 'ADM-')
WHERE role = 'ADMIN'
  AND admin_id ~ '^RES-[A-Z0-9]{8}$';
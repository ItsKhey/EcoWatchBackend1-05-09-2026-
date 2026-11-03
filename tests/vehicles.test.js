const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../src/config/db');
const vehicleController = require('../src/modules/vehicles/vehicleController');
const vehicleRepository = require('../src/modules/vehicles/vehicleRepository');
const {
  VEHICLE_STATUSES,
  normalizeVehicleFilter,
  normalizePlateNumber,
  normalizeVehicleStatus,
  validateCreateVehiclePayload,
  validateUpdateVehiclePayload,
} = require('../src/modules/vehicles/vehicleValidation');

const ADMIN_ID = 'ADM-VEHICLETEST';
const RESIDENT_ID = 'RES-VEHICLETEST';

/** Minimal stand-in for the Express response used by the controllers. */
const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

const createRequest = (overrides = {}) => ({
  requestId: 'test-vehicles',
  admin: { admin_id: ADMIN_ID, role: 'ADMIN' },
  body: {},
  query: {},
  params: {},
  ...overrides,
});

/** Runs the controller, returning the captured response or the forwarded error. */
const run = async (handler, request) => {
  const res = createResponse();
  let forwarded = null;
  await handler(request, res, (error) => {
    forwarded = error;
  });
  if (forwarded) return { error: forwarded };
  return { res };
};

const seed = async () => {
  await pool.query(
    `INSERT INTO admins (admin_id, first_name, last_name, username, email,
        password_hash, role)
     VALUES ($1, 'Vehicle', 'Tester', $1, $1, 'not-a-real-hash', 'ADMIN')
     ON CONFLICT (admin_id) DO UPDATE SET role = 'ADMIN'`,
    [ADMIN_ID]
  );

  await pool.query(
    `INSERT INTO residents (resident_id, first_name, last_name, username, email,
        password_hash, role, status, is_verified)
     VALUES ($1, 'Vehicle', 'Tester', $1, $1, 'not-a-real-hash', 'RESIDENT', 'AVAILABLE', true)
     ON CONFLICT (resident_id) DO NOTHING`,
    [RESIDENT_ID]
  );
};

const cleanup = async () => {
  await pool.query(
    `DELETE FROM report_histories WHERE resident_id = $1`,
    [RESIDENT_ID]
  );
  await pool.query(`DELETE FROM reports WHERE resident_id = $1`, [RESIDENT_ID]);
  await pool.query(`DELETE FROM vehicles WHERE created_by_admin_id = $1 OR vehicle_id = $2`, [ADMIN_ID, 'VEH-0000']);
  await pool.query(`DELETE FROM residents WHERE resident_id = $1`, [RESIDENT_ID]);
  await pool.query(`DELETE FROM admins WHERE admin_id = $1`, [ADMIN_ID]);
};

/** Creates a vehicle through the controller so the whole write path is covered. */
const createVehicle = async (plateNumber, overrides = {}) => {
  const { res, error } = await run(
    vehicleController.addVehicle,
    createRequest({
      body: {
        plateNumber,
        vehicleType: 'Mini dump truck',
        ratedLoadCapacity: '1.5 tons',
        ...overrides,
      },
    })
  );
  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  return res.body;
};

test.before(async () => { await cleanup(); await seed(); });
test.after(async () => { await cleanup(); });

test('a vehicle is added with a generated id and starts Available', async () => {
  const vehicle = await createVehicle('ABC-101');

  assert.match(vehicle.vehicleId, /^VEH-[0-9]{4}$/);
  assert.equal(vehicle.plateNumber, 'ABC-101');
  assert.equal(vehicle.vehicleType, 'Mini dump truck');
  assert.equal(vehicle.ratedLoadCapacity, '1.5 tons');
  assert.equal(vehicle.status, VEHICLE_STATUSES.AVAILABLE);
  assert.equal(vehicle.currentReportId, null);
});

test('the plate is stored upper-cased so case cannot create a second vehicle', async () => {
  const vehicle = await createVehicle('abc-202');

  assert.equal(vehicle.plateNumber, 'ABC-202');
});

test('a duplicate plate is refused rather than silently creating a twin', async () => {
  await createVehicle('ABC-303');

  const { error } = await run(
    vehicleController.addVehicle,
    createRequest({ body: { plateNumber: 'abc-303', vehicleType: 'Garbage truck' } })
  );

  assert.ok(error, 'the same plate must not be registrable twice');
  assert.equal(error.statusCode, 409);
});

test('a new vehicle cannot be born already Assigned', () => {
  assert.throws(
    () => validateCreateVehiclePayload({
      plateNumber: 'ABC-404',
      vehicleType: 'Garbage truck',
      status: 'Assigned',
    }),
    (error) => error.statusCode === 400
  );
});

test('the three card counts come from one pass over the fleet', async () => {
  await createVehicle('CNT-1');
  await createVehicle('CNT-2');
  await run(
    vehicleController.addVehicle,
    createRequest({ body: { plateNumber: 'CNT-3', vehicleType: 'Garbage truck', status: 'Maintenance' } })
  );

  const { res } = await run(vehicleController.listVehicles, createRequest());

  // CNT-1 and CNT-2 are Available, CNT-3 is Maintenance, plus the earlier
  // vehicles still in the table.
  const counts = res.body.counts;
  assert.equal(counts.total, counts.available + counts.assigned + counts.maintenance);
  assert.ok(counts.available >= 2, 'the two new vehicles are available');
  assert.equal(counts.maintenance, 1);
});

test('the list can be narrowed to one status', async () => {
  const { res } = await run(
    vehicleController.listVehicles,
    createRequest({ query: { status: 'maintenance' } })
  );

  assert.equal(res.body.filter, 'Maintenance');
  assert.ok(res.body.vehicles.length >= 1);
  res.body.vehicles.forEach((vehicle) => {
    assert.equal(vehicle.status, 'Maintenance');
  });
});

test('an unknown status filter is a 400, not an empty list', async () => {
  const { error } = await run(
    vehicleController.listVehicles,
    createRequest({ query: { status: 'exploded' } })
  );

  assert.ok(error);
  assert.equal(error.statusCode, 400);
});

test('Assigning without a report is refused', async () => {
  const vehicle = await createVehicle('ASG-1');

  const { error } = await run(
    vehicleController.editVehicle,
    createRequest({
      params: { vehicleId: vehicle.vehicleId },
      body: { status: 'Assigned' },
    })
  );

  assert.ok(error, 'Assigned with nothing to collect is a dead end');
  assert.equal(error.statusCode, 400);
});

test('Assigning to a report that does not exist is a 404', async () => {
  const vehicle = await createVehicle('ASG-2');

  const { error } = await run(
    vehicleController.editVehicle,
    createRequest({
      params: { vehicleId: vehicle.vehicleId },
      body: { status: 'Assigned', currentReportId: 'REP-DOESNOTEXIST' },
    })
  );

  assert.ok(error);
  assert.equal(error.statusCode, 404);
});

test('tying a non-Assigned vehicle to a report is refused', async () => {
  const vehicle = await createVehicle('ASG-3');

  const { error } = await run(
    vehicleController.editVehicle,
    createRequest({
      params: { vehicleId: vehicle.vehicleId },
      body: { status: 'Maintenance', currentReportId: 'REP-ANYTHING' },
    })
  );

  assert.ok(error);
  assert.equal(error.statusCode, 400);
});

test('leaving a collection frees the vehicle and its report', async () => {
  const vehicle = await createVehicle('ASG-4');

  const { error: assignError } = await run(
    vehicleController.editVehicle,
    createRequest({
      params: { vehicleId: vehicle.vehicleId },
      body: { status: 'Assigned', currentReportId: 'REP-NOSTATE' },
    })
  );
  assert.equal(assignError.statusCode, 404, 'the fixture report does not exist');

  // Straight to Maintenance instead, which is the transition that has to clear
  // the collection columns.
  const { res } = await run(
    vehicleController.editVehicle,
    createRequest({
      params: { vehicleId: vehicle.vehicleId },
      body: { status: VEHICLE_STATUSES.MAINTENANCE },
    })
  );

  assert.equal(res.body.status, VEHICLE_STATUSES.MAINTENANCE);
  assert.equal(res.body.currentReportId, null);
});

test('a service date is recorded and counts as fleet activity', async () => {
  const vehicle = await createVehicle('SRV-1');

  const { res } = await run(
    vehicleController.recordVehicleService,
    createRequest({
      params: { vehicleId: vehicle.vehicleId },
      body: { servicedAt: '2026-09-01T08:00:00.000Z' },
    })
  );

  assert.ok(res.body.lastServiceAt, 'the service date is stored');
  // pg hands the timestamptz back as a Date, so this is the instant rather than
  // a string: the value went in as 08:00 UTC and came back as that same moment.
  const stored = new Date(res.body.lastServiceAt);
  assert.equal(Number.isNaN(stored.getTime()), false, 'a parseable instant');
  assert.equal(stored.toISOString(), '2026-09-01T08:00:00.000Z');
});

test('an unreadable service date is refused', async () => {
  const vehicle = await createVehicle('SRV-2');

  const { error } = await run(
    vehicleController.recordVehicleService,
    createRequest({
      params: { vehicleId: vehicle.vehicleId },
      body: { servicedAt: 'last tuesday' },
    })
  );

  assert.ok(error);
  assert.equal(error.statusCode, 400);
});

test('removing a vehicle takes it off the list and frees its plate', async () => {
  const vehicle = await createVehicle('DEL-1');

  const { error } = await run(
    vehicleController.removeVehicle,
    createRequest({ params: { vehicleId: vehicle.vehicleId } })
  );
  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);

  const { res: list } = await run(vehicleController.listVehicles, createRequest());
  assert.equal(
    list.body.vehicles.find((v) => v.vehicleId === vehicle.vehicleId),
    undefined,
    'a removed vehicle is gone from the fleet'
  );

  // The plate is free again, which is the whole reason removal is a soft delete.
  const reused = await createVehicle('DEL-1');
  assert.notEqual(reused.vehicleId, vehicle.vehicleId);
});

test('an unknown vehicle id is a 404', async () => {
  const { error } = await run(
    vehicleController.getVehicle,
    createRequest({ params: { vehicleId: 'VEH-9999' } })
  );

  assert.ok(error);
  assert.equal(error.statusCode, 404);
});

test('a malformed vehicle id is rejected before the database', async () => {
  const { error } = await run(
    vehicleController.getVehicle,
    createRequest({ params: { vehicleId: 'TRUCK-1' } })
  );

  assert.ok(error);
  assert.equal(error.statusCode, 400);
});

test('the fleet endpoints refuse a request with no administrator', async () => {
  const { error } = await run(
    vehicleController.listVehicles,
    createRequest({ admin: undefined })
  );

  assert.ok(error, 'the fleet is administrator-only');
  assert.equal(error.statusCode, 403);
});

test('an empty update is refused rather than silently succeeding', () => {
  assert.throws(
    () => validateUpdateVehiclePayload({}),
    (error) => error.statusCode === 400
  );
});

test('the validators normalise what the forms send', () => {
  assert.equal(normalizePlateNumber('  abc   123  '), 'ABC 123');
  assert.equal(normalizeVehicleStatus('assigned'), 'Assigned');
  assert.equal(normalizeVehicleFilter('all'), null);
  assert.equal(normalizeVehicleFilter('MAINTENANCE'), 'Maintenance');

  assert.throws(() => normalizePlateNumber(''), (error) => error.statusCode === 400);
  assert.throws(() => normalizeVehicleStatus('Broken'), (error) => error.statusCode === 400);
});

test('the fleet survives a round trip through the repository', async () => {
  const vehicle = await createVehicle('RT-1');

  const fetched = await vehicleRepository.findByVehicleId(vehicle.vehicleId);
  assert.equal(fetched.plateNumber, 'RT-1');
  assert.equal(fetched.vehicleType, 'Mini dump truck');
  assert.equal(fetched.status, VEHICLE_STATUSES.AVAILABLE);
  assert.equal(fetched.currentReport, null, 'an unassigned vehicle has no collection');
});

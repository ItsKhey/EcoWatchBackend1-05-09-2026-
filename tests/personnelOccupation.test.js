const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../src/config/db');
const personnelController = require('../src/modules/personnel/personnelController');
const personnelRepository = require('../src/modules/personnel/personnelRepository');
const vehicleController = require('../src/modules/vehicles/vehicleController');
const {
  PERSONNEL_OCCUPATIONS,
  validateCreatePayload,
  validateUpdatePayload,
  resolveOccupationAndVehicle,
} = require('../src/shared/personnelValidation');

const ADMIN_ID = 'ADM-PERSONNELTEST';
const VEHICLE_STATUSES = { AVAILABLE: 'Available', MAINTENANCE: 'Maintenance' };

/** Minimal stand-in for the Express response used by the controllers. */
const createResponse = () => ({
  statusCode: 200,
  body: null,
  set() {
    return this;
  },
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
  requestId: 'test-personnel-occupation',
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

/**
 * Registers a personnel account through the controller so the whole write path is
 * covered, including the occupation and vehicle checks the app now depends on.
 */
const createPersonnel = async (username, overrides = {}) => {
  const { res, error } = await run(
    personnelController.createPersonnel,
    createRequest({
      body: {
        firstName: 'Ana',
        lastName: 'Reyes',
        address: 'Quezon City',
        gmail: `${username}@gmail.com`,
        username,
        password: 'password123',
        phoneNumber: '09171234567',
        messengerLink: 'https://m.me/ana',
        ...overrides,
      },
    })
  );
  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  return res.body;
};

/** Registers a fleet vehicle so there is something to drive. */
const createVehicle = async (plateNumber, overrides = {}) => {
  const { res, error } = await run(
    vehicleController.addVehicle,
    createRequest({
      body: {
        plateNumber,
        vehicleType: 'Mini dump truck',
        ...overrides,
      },
    })
  );
  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  return res.body;
};

const usernameFor = (label) => `occ.${label}`;

const seed = async () => {
  await pool.query(
    `INSERT INTO admins (admin_id, first_name, last_name, username, email,
        password_hash, role)
     VALUES ($1, 'Personnel', 'Tester', $1, $1, 'not-a-real-hash', 'ADMIN')
     ON CONFLICT (admin_id) DO UPDATE SET role = 'ADMIN'`,
    [ADMIN_ID]
  );
};

/**
 * Removes everything these tests create.
 *
 * The personnel rows go first because they now hold a foreign key onto the
 * vehicles, and the history trail references the account by id.
 */
const cleanup = async () => {
  await pool.query(
    `DELETE FROM report_histories
     WHERE subject_type = 'PERSONNEL'
       AND subject_id IN (
         SELECT personnel_id FROM personnel_accounts WHERE username LIKE 'occ.%'
       )`
  );
  await pool.query(`DELETE FROM personnel_accounts WHERE username LIKE 'occ.%'`);
  await pool.query(`DELETE FROM vehicles WHERE created_by_admin_id = $1`, [ADMIN_ID]);
  await pool.query(`DELETE FROM admins WHERE admin_id = $1`, [ADMIN_ID]);
};

test.before(async () => { await cleanup(); await seed(); });
test.after(async () => { await cleanup(); });

test('an account created without an occupation is a Regular cleaner', async () => {
  const body = await createPersonnel(usernameFor('default'));

  assert.equal(body.personnel.occupation, PERSONNEL_OCCUPATIONS.REGULAR);
  assert.equal(body.personnel.assignedVehicleId, null);
  assert.equal(body.personnel.assignedVehicle, null);
});

test('the roster returns the occupation and the assigned vehicle', async () => {
  const vehicle = await createVehicle('OCC-1');
  await createPersonnel(usernameFor('driver'), {
    occupation: 'Driver',
    assignedVehicleId: vehicle.vehicleId,
  });

  const { res } = await run(
    personnelController.listPersonnel,
    createRequest({ query: { search: usernameFor('driver') } })
  );

  const driver = res.body.personnel.find(
    (person) => person.username === usernameFor('driver')
  );
  assert.ok(driver, 'the driver is in the roster');
  assert.equal(driver.occupation, PERSONNEL_OCCUPATIONS.DRIVER);
  assert.equal(driver.assignedVehicleId, vehicle.vehicleId);
  assert.equal(driver.assignedVehiclePlateNumber, 'OCC-1');
  assert.equal(driver.assignedVehicle.plateNumber, 'OCC-1');
  // The shorter spelling is what the Admin client reads.
  assert.equal(driver.vehicleId, vehicle.vehicleId);
});

test('a Regular cleaner is never shown a truck', async () => {
  const vehicle = await createVehicle('OCC-2');

  const { error } = await run(
    personnelController.createPersonnel,
    createRequest({
      body: {
        firstName: 'Ana',
        lastName: 'Reyes',
        address: 'Quezon City',
        gmail: 'occ.regular@gmail.com',
        username: 'occ.regular',
        password: 'password123',
        occupation: 'Regular',
        assignedVehicleId: vehicle.vehicleId,
      },
    })
  );

  assert.ok(error, 'a cleaner must not be able to hold a vehicle');
  assert.equal(error.statusCode, 400);
});

test('a Driver is refused a truck that is not in the fleet', async () => {
  const { error } = await run(
    personnelController.createPersonnel,
    createRequest({
      body: {
        firstName: 'Ana',
        lastName: 'Reyes',
        address: 'Quezon City',
        gmail: 'occ.ghost@gmail.com',
        username: 'occ.ghost',
        password: 'password123',
        occupation: 'Driver',
        assignedVehicleId: 'VEH-9999',
      },
    })
  );

  assert.ok(error, 'an unknown vehicle must not create an account');
  assert.equal(error.statusCode, 404);
});

test('a truck under maintenance cannot be handed to a driver', async () => {
  const vehicle = await createVehicle('OCC-3');
  await pool.query(
    `UPDATE vehicles SET status = $2 WHERE vehicle_id = $1`,
    [vehicle.vehicleId, VEHICLE_STATUSES.MAINTENANCE]
  );

  const { error } = await run(
    personnelController.createPersonnel,
    createRequest({
      body: {
        firstName: 'Ana',
        lastName: 'Reyes',
        address: 'Quezon City',
        gmail: 'occ.shop@gmail.com',
        username: 'occ.shop',
        password: 'password123',
        occupation: 'Driver',
        assignedVehicleId: vehicle.vehicleId,
      },
    })
  );

  assert.ok(error, 'a truck in the workshop is not drivable');
  assert.equal(error.statusCode, 409);
});

test('one truck cannot be given to two drivers', async () => {
  const vehicle = await createVehicle('OCC-4');
  await createPersonnel(usernameFor('first'), {
    occupation: 'Driver',
    assignedVehicleId: vehicle.vehicleId,
  });

  const { error } = await run(
    personnelController.createPersonnel,
    createRequest({
      body: {
        firstName: 'Mara',
        lastName: 'Santos',
        address: 'Caloocan',
        gmail: 'occ.second@gmail.com',
        username: 'occ.second',
        password: 'password123',
        occupation: 'Driver',
        assignedVehicleId: vehicle.vehicleId,
      },
    })
  );

  assert.ok(error, 'a truck has exactly one driver');
  assert.equal(error.statusCode, 409);
});

test('the unique index refuses a double booking even past the controller', async () => {
  const vehicle = await createVehicle('OCC-5');
  await createPersonnel(usernameFor('race'), {
    occupation: 'Driver',
    assignedVehicleId: vehicle.vehicleId,
  });

  // A second row written straight through the repository never reaches the
  // controller, so this is what proves the database is the final authority.
  await assert.rejects(
    () => personnelRepository.createPersonnel(
      {
        firstName: 'Ben',
        lastName: 'Cruz',
        address: 'Pasay',
        email: 'occ.race2@gmail.com',
        username: 'occ.race2',
        passwordHash: 'not-a-real-hash',
        occupation: 'Driver',
        assignedVehicleId: vehicle.vehicleId,
        createdByAdminId: ADMIN_ID,
      },
      pool
    )
  );
});

test('a disabled driver releases the truck for reassignment', async () => {
  const vehicle = await createVehicle('OCC-6');
  const first = await createPersonnel(usernameFor('paused'), {
    occupation: 'Driver',
    assignedVehicleId: vehicle.vehicleId,
  });

  await run(
    personnelController.disablePersonnel,
    createRequest({ params: { id: first.personnel.personnelId } })
  );

  // The office has one truck: a paused account cannot drive it, so refusing the
  // reassignment would leave the truck unusable.
  const second = await createPersonnel(usernameFor('tookover'), {
    occupation: 'Driver',
    assignedVehicleId: vehicle.vehicleId,
  });

  assert.equal(second.personnel.assignedVehicleId, vehicle.vehicleId);
});

test('a driver can be given a truck after the fact', async () => {
  const vehicle = await createVehicle('OCC-7');
  const created = await createPersonnel(usernameFor('later'), { occupation: 'Driver' });
  const personnelId = created.personnel.personnelId;

  assert.equal(created.personnel.assignedVehicleId, null);

  const { res, error } = await run(
    personnelController.editPersonnel,
    createRequest({
      params: { id: personnelId },
      body: { assignedVehicleId: vehicle.vehicleId },
    })
  );

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  assert.equal(res.body.personnel.occupation, PERSONNEL_OCCUPATIONS.DRIVER);
  assert.equal(res.body.personnel.assignedVehiclePlateNumber, 'OCC-7');
});

test('demoting a driver to Regular releases the truck', async () => {
  const vehicle = await createVehicle('OCC-8');
  const created = await createPersonnel(usernameFor('demote'), {
    occupation: 'Driver',
    assignedVehicleId: vehicle.vehicleId,
  });
  const personnelId = created.personnel.personnelId;

  const { res, error } = await run(
    personnelController.editPersonnel,
    createRequest({
      params: { id: personnelId },
      body: { occupation: 'Regular' },
    })
  );

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  assert.equal(res.body.personnel.occupation, PERSONNEL_OCCUPATIONS.REGULAR);
  assert.equal(res.body.personnel.assignedVehicleId, null);

  // The truck is speakable for again, which is the point of demoting.
  const next = await createPersonnel(usernameFor('demotetaker'), {
    occupation: 'Driver',
    assignedVehicleId: vehicle.vehicleId,
  });
  assert.equal(next.personnel.assignedVehicleId, vehicle.vehicleId);
});

test('demoting to Regular while keeping the truck is refused', async () => {
  const vehicle = await createVehicle('OCC-9');
  const created = await createPersonnel(usernameFor('contradiction'), {
    occupation: 'Driver',
    assignedVehicleId: vehicle.vehicleId,
  });

  const { error } = await run(
    personnelController.editPersonnel,
    createRequest({
      params: { id: created.personnel.personnelId },
      body: { occupation: 'Regular', assignedVehicleId: vehicle.vehicleId },
    })
  );

  assert.ok(error, 'a cleaner holding a truck is a contradiction');
  assert.equal(error.statusCode, 400);
});

test('an edit that mentions neither field leaves the occupation alone', async () => {
  const vehicle = await createVehicle('OCC-10');
  const created = await createPersonnel(usernameFor('untouched'), {
    occupation: 'Driver',
    assignedVehicleId: vehicle.vehicleId,
  });

  const { res, error } = await run(
    personnelController.editPersonnel,
    createRequest({
      params: { id: created.personnel.personnelId },
      body: { firstName: 'Ana Maria' },
    })
  );

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  assert.equal(res.body.personnel.occupation, PERSONNEL_OCCUPATIONS.DRIVER);
  assert.equal(res.body.personnel.assignedVehicleId, vehicle.vehicleId);
});

test('the validators normalise what the forms send', () => {
  assert.equal(resolveOccupationAndVehicle('driver', 'veh-0001').occupation, 'Driver');
  assert.equal(resolveOccupationAndVehicle('driver', 'veh-0001').assignedVehicleId, 'VEH-0001');
  // Absent means Regular, so a client that has not been updated keeps working.
  assert.equal(resolveOccupationAndVehicle(undefined, undefined).occupation, 'Regular');
  // Clearing a truck is a real edit rather than an invalid value.
  assert.equal(resolveOccupationAndVehicle('Driver', '').assignedVehicleId, null);

  assert.throws(
    () => resolveOccupationAndVehicle('Collector', null),
    (error) => error.statusCode === 400
  );
  assert.throws(
    () => resolveOccupationAndVehicle('Driver', 'TRUCK-1'),
    (error) => error.statusCode === 400
  );

  const created = validateCreatePayload({
    firstName: 'Ana',
    lastName: 'Reyes',
    address: 'Quezon City',
    gmail: 'ana@gmail.com',
    username: 'ana.reyes',
    password: 'password123',
    occupationType: 'Driver',
    vehicleId: 'VEH-0001',
  });
  assert.equal(created.occupation, 'Driver');
  assert.equal(created.assignedVehicleId, 'VEH-0001');

  // The app sends both spellings of each field, so agreeing ones are fine.
  const bothSpellings = validateCreatePayload({
    firstName: 'Ana',
    lastName: 'Reyes',
    address: 'Quezon City',
    gmail: 'ana@gmail.com',
    username: 'ana.reyes',
    password: 'password123',
    occupation: 'Driver',
    occupationType: 'Driver',
    assignedVehicleId: 'VEH-0001',
    vehicleId: 'VEH-0001',
  });
  assert.equal(bothSpellings.occupation, 'Driver');
  assert.equal(bothSpellings.assignedVehicleId, 'VEH-0001');

  // Disagreeing ones are not: resolving them by taking whichever came first
  // would store a truck the administrator never picked.
  assert.throws(
    () => validateCreatePayload({
      firstName: 'Ana',
      lastName: 'Reyes',
      address: 'Quezon City',
      gmail: 'ana@gmail.com',
      username: 'ana.reyes',
      password: 'password123',
      occupation: 'Driver',
      occupationType: 'Regular',
    }),
    (error) => error.statusCode === 400
  );
  assert.throws(
    () => validateCreatePayload({
      firstName: 'Ana',
      lastName: 'Reyes',
      address: 'Quezon City',
      gmail: 'ana@gmail.com',
      username: 'ana.reyes',
      password: 'password123',
      occupation: 'Driver',
      assignedVehicleId: 'VEH-0001',
      vehicleId: 'VEH-0002',
    }),
    (error) => error.statusCode === 400
  );

  // Only the vehicle sent: the occupation is left for the controller to keep.
  const updated = validateUpdatePayload({ assignedVehicleId: 'VEH-0002' });
  assert.equal(updated.assignedVehicleId, 'VEH-0002');
  assert.ok(!('occupation' in updated), 'occupation must not be written by a vehicle-only edit');
});
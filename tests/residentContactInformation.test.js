const test = require('node:test');
const assert = require('node:assert/strict');

const Module = require('node:module');
const { readFileSync } = require('fs');

const { requirePhoneNumber } = require('../src/shared/personnelValidation');

/*
 * Captured before any stubbing happens, because loadAuthController replaces
 * these modules in the require cache and a later require would read the stub.
 */
const {
  RESIDENT_UPDATABLE_FIELDS,
} = require('../src/modules/residents/residentRepository');
const {
  ADMIN_UPDATABLE_FIELDS,
} = require('../src/modules/admin/adminRepository');

/*
 * Contact information contract for the resident account.
 *
 * These assertions cover the two things the admin app's reporter Contact
 * Information card depends on: the keys the resident payload exposes, and the
 * repository allow-list that decides whether those columns can be written.
 *
 * The controller is loaded against stubs rather than required directly. Loading
 * the real one pulls in the database pool, Firebase and the token helpers, and
 * that shared module state makes unrelated suites in a full run report 401s
 * they did not cause.
 */

const stubModule = (relativePath, exports) => {
  const resolved = require.resolve(relativePath);
  const stub = new Module(resolved, null);
  stub.filename = resolved;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[resolved] = stub;
};

const noop = new Proxy({}, { get: () => async () => null });

/**
 * Loads authController with every side-effecting dependency replaced.
 *
 * utils/personnelValidation is deliberately NOT stubbed: it holds the contact
 * validators under test, and keeping it real is what lets this file catch a
 * broken export.
 */
const loadAuthController = () => {
  for (const dependency of [
    '../src/modules/residents/residentRepository',
    '../src/modules/admin/adminRepository',
    '../src/modules/auth/pendingRegistrationRepository',
    '../src/modules/auth/passwordResetRepository',
    '../src/modules/auth/firebaseAuthController',
    '../src/modules/auth/firebaseAuthService',
    '../src/shared/cloudinaryService',
    '../src/modules/auth/emailServices',
    '../src/shared/generateToken',
  ]) {
    stubModule(dependency, noop);
  }

  const controllerPath = require.resolve('../src/modules/auth/authController');
  delete require.cache[controllerPath];
  return require('../src/modules/auth/authController');
};

const residentRow = {
  resident_id: 'RES-CONTACT1',
  first_name: 'Juan',
  last_name: 'Dela Cruz',
  username: 'juan',
  email: 'juan@example.com',
  address: 'North Park',
  profile_image: '',
  role: 'RESIDENT',
  status: 'AVAILABLE',
  phone_number: '+63 917 000 0000',
  messenger_link: 'https://m.me/juan',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

test('the resident payload carries the contact fields the admin app renders', () => {
  const { mapResidentResponse } = loadAuthController();

  const mapped = mapResidentResponse(residentRow);

  // The admin app's reporter Contact Information card is fed entirely by these
  // two keys, so a rename here silently empties that card for every reporter.
  assert.equal(mapped.phoneNumber, '+63 917 000 0000');
  assert.equal(mapped.messengerLink, 'https://m.me/juan');
});

test('an unset contact field is an empty string rather than null', () => {
  const { mapResidentResponse } = loadAuthController();

  const mapped = mapResidentResponse({
    ...residentRow,
    messenger_link: null,
    phone_number: null,
  });

  // Empty rather than null to match every other field here; the Android row
  // treats both as "not provided".
  assert.equal(mapped.messengerLink, '');
  assert.equal(mapped.phoneNumber, '');
});

test('signup requires a phone number', () => {
  assert.throws(
    () => requirePhoneNumber(undefined),
    /Phone number is required/
  );
  assert.throws(
    () => requirePhoneNumber('   '),
    /Phone number is required/
  );
  assert.equal(requirePhoneNumber('09170000001'), '09170000001');
});

test('a signup phone number is validated before an account is staged', () => {
  assert.throws(() => requirePhoneNumber('123'), /Phone number format is invalid/);
  assert.throws(
    () => requirePhoneNumber('09170000001 ext 5'),
    /Phone number format is invalid/
  );
});

test('a resident can write their own messenger link', () => {
  // This allow-list is the only thing between a request body and an arbitrary
  // column write, and the messenger row depends on it being reachable.
  assert.equal(RESIDENT_UPDATABLE_FIELDS.messengerLink, 'messenger_link');
  assert.equal(RESIDENT_UPDATABLE_FIELDS.phoneNumber, 'phone_number');
});

test('an admin cannot write a messenger link because the column does not exist', () => {
  // The asymmetry is deliberate: admins have no messenger_link column, so adding
  // it here would only look supported while silently doing nothing.
  assert.equal(ADMIN_UPDATABLE_FIELDS.messengerLink, undefined);
  assert.equal(ADMIN_UPDATABLE_FIELDS.phoneNumber, 'phone_number');
});

test('the admin reader selects the columns the contact card renders', () => {
  // Both the reporter list and the reporter details screen read through this
  // field block; a missing column means an empty row for every reporter.
  const source = readFileSync(require.resolve('../src/modules/residents/residentRepository'), 'utf8');

  assert.match(source, /r\.phone_number/);
  assert.match(source, /r\.messenger_link/);
});

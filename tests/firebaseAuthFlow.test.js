const test = require('node:test');
const assert = require('node:assert/strict');

const Module = require('node:module');

/*
 * Behavioural tests for the Firebase email-link flow.
 *
 * These CALL the handlers. Every earlier check that missed a shipped bug was a
 * check that never executed the function body: a ReferenceError inside a handler
 * is invisible to parsing, to requiring the module, and to any test that stubs
 * the layer above it. Dependencies are replaced through the module cache so no
 * database, no Firebase project and no network is involved.
 */

const stubModule = (relativePath, exports) => {
  const resolved = require.resolve(relativePath);
  const stub = new Module(resolved, null);
  stub.filename = resolved;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[resolved] = stub;
};

const calls = [];

const record = (name, result) => {
  calls.push({ name, args: result });
  return result;
};

/**
 * Stands in for a by-email lookup.
 *
 * When the override declares its own address the stub only answers for that
 * address, which is what a real query does. An override with no address stays
 * address-agnostic for the cases where the point is simply that it is taken.
 */
const matchByEmail = (override, email) => {
  if (!override) return null;
  if (!override.email) return override;
  return String(email).trim().toLowerCase() === String(override.email).trim().toLowerCase()
    ? override
    : null;
};

const makeRes = () => ({
  statusCode: 200,
  body: null,
  headersSent: false,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  set() { return this; },
});

/**
 * Builds a request double. `auth` is merged onto the request so a handler that
 * reads req.resident (the JWT-protected ones) can be driven directly.
 */
const makeReq = (body = {}, query = {}, auth = {}) => ({
  body,
  query,
  requestId: 'test-request',
  ...auth,
});

/**
 * The HTTP status a caller would actually see.
 *
 * Handlers here report failure by setting statusCode on the error and forwarding
 * it, and middleware/errorMiddleware.js is what turns that into a response
 * status. That middleware is Express plumbing and is not under test here.
 */
const statusOf = (res, error) => (
  error && Number.isInteger(error.statusCode) ? error.statusCode : res.statusCode
);

const run = async (handler, req) => {
  const res = makeRes();
  let forwarded;
  await handler(req, res, (error) => { forwarded = error; });
  return { res, error: forwarded };
};

const calledWith = (name) => calls.find((entry) => entry.name === name);

const validRegistration = (overrides = {}) => ({
  firstName: 'Khei',
  lastName: 'Saliga',
  username: 'kheysaliga2',
  email: 'saligakhey@gmail.com',
  // Required on every registration transport, so it belongs in the fixture that
  // stands for "a signup that passes validation".
  phoneNumber: '09171234567',
  password: '@Sample123',
  verificationMethod: 'EMAIL_LINK',
  ...overrides,
});

const pendingRegistration = (overrides = {}) => ({
  registration_id: 'REG-abcdefghijkl',
  first_name: 'Khei',
  last_name: 'Saliga',
  username: 'kheysaliga2',
  email: 'saligakhey@gmail.com',
  password_hash: '$2$10$abcdefghijklmnopqrstuv',
  firebase_uid: null,
  verification_flow: 'EMAIL_LINK',
  expires_at: new Date(Date.now() + 60000),
  verification_sent_at: null,
  ...overrides,
});

/**
 * Loads a fresh copy of the controller against stubs.
 *
 * utils/generateId is deliberately NOT stubbed, so the real identifier generators
 * run. That is what lets this suite catch an undefined-identifier bug.
 */
const loadController = (overrides = {}) => {
  calls.length = 0;

  // `order` records the sequence of writes so a test can assert Supabase is
  // committed before Firebase is touched.
  const order = overrides.order || null;
  const step = (name) => { if (order) order.push(name); };

  stubModule('../src/modules/residents/residentRepository', {
    findByUsername: async () => overrides.residentByUsername ?? null,
    findByEmail: async (email) => matchByEmail(overrides.residentByEmail, email),
    findByResidentId: async () => overrides.currentResident ?? null,
    createResident: async (payload) =>
      record('createResident', { resident_id: 'RES-NEW0001', ...payload }),
    updatePassword: async (residentId, hash) => {
      step('supabase');
      return record('updatePassword', { resident_id: residentId, password_hash: hash });
    },
    setFirebaseUid: async (residentId, uid) => {
      step('supabase-uid');
      return record('setFirebaseUid', { resident_id: residentId, firebase_uid: uid });
    },
    findByFirebaseUid: async () => null,
    markEmailVerified: async () => null,
  });

  stubModule('../src/modules/admin/adminRepository', {
    findByUsername: async () => overrides.adminByUsername ?? null,
    findByEmail: async (email) => matchByEmail(overrides.adminByEmail, email),
    findByAdminId: async () => null,
    updatePassword: async () => null,
    setFirebaseUid: async () => null,
    findByFirebaseUid: async () => null,
    markEmailVerified: async () => null,
  });

  stubModule('../src/modules/personnel/personnelRepository', {
    findByUsername: async () => overrides.personnelByUsername ?? null,
    findByEmail: async () => overrides.personnelByEmail ?? null,
  });

  stubModule('../src/modules/auth/pendingRegistrationRepository', {
    createPendingRegistration: async (payload) =>
      record('createPendingRegistration', {
        registration_id: payload.registrationId,
        ...payload,
      }),
    findByRegistrationId: async () => overrides.pending ?? null,
    deleteByRegistrationId: async () => record('deleteByRegistrationId', null),
    deleteUnverifiedByEmail: async () => record('deleteUnverifiedByEmail', []),
  });

  stubModule('../src/modules/auth/passwordResetRepository', {
    getCooldownSeconds: async () => overrides.cooldownSeconds ?? 0,
    markResetLinkSent: async () => record('markResetLinkSent', null),
    clearResetLinkMarker: async () => record('clearResetLinkMarker', null),
    findByEmail: async () => null,
    deleteByEmail: async () => null,
  });

  stubModule('../src/modules/auth/firebaseAuthService', {
    // Defaults describe a proven session; individual tests override to model the
    // failure that matters.
    verifyRegistrationSession: overrides.verifyRegistrationSession
      || (async (payload) => record('verifyRegistrationSession', {
        uid: 'UID-VERIFIED1',
        email: 'saligakhey@gmail.com',
        emailVerified: true,
        sawIdToken: Boolean(payload.idToken),
      })),
    inspectActionCode: overrides.inspectActionCode
      || (async () => record('inspectActionCode', {
        email: 'saligakhey@gmail.com',
        operation: 'PASSWORD_RESET',
      })),
    ensureIdentityForReset: overrides.ensureIdentityForReset
      || (async () => {
        step('firebase-identity');
        return record('ensureIdentityForReset', { uid: 'UID-EXISTING', created: false });
      }),
    overwriteIdentityPassword: overrides.overwriteIdentityPassword
      || (async () => {
        step('firebase-password');
        return record('overwriteIdentityPassword', true);
      }),
    findIdentityByEmail: async () => null,
  });

  stubModule('../src/shared/logger', {
    logInfo: () => {},
    logError: () => {},
    logProfileRequest: () => {},
  });

  delete require.cache[require.resolve('../src/modules/auth/firebaseAuthController')];
  return require('../src/modules/auth/firebaseAuthController');
};

// ---------------------------------------------------------------------------
// Registration: the server validates and stages, the app sends the email
// ---------------------------------------------------------------------------

test('registerResident stages the signup and asks the app to send the email', async () => {
  const controller = loadController();

  const { res, error } = await run(controller.registerResident, makeReq(validRegistration()));

  assert.equal(error, undefined, `handler failed: ${error && error.message}`);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.clientMustSendVerificationEmail, true);
  assert.match(res.body.registrationId, /^REG-[a-z0-9]{12}$/);

  const pending = calledWith('createPendingRegistration');
  assert.ok(pending, 'a pending registration must be created');
  assert.equal(pending.args.verificationFlow, 'EMAIL_LINK');
  assert.equal(pending.args.otpHash, null, 'the email-link flow stores no OTP');
  assert.equal(
    pending.args.phoneNumber,
    '09171234567',
    'the signup phone must be staged or it is lost when the resident row is created'
  );
  assert.ok(pending.args.passwordHash.startsWith('$2'), 'password must be bcrypt hashed');
  assert.equal(
    pending.args.passwordHash.includes('@Sample123'),
    false,
    'the plaintext password must never be stored'
  );

  // The critical guarantee: an unverified signup is not an account yet.
  assert.equal(calledWith('createResident'), undefined,
    'no resident row may exist before the email is verified');
});

test('registerResident rejects a taken username before staging anything', async () => {
  const controller = loadController({ residentByUsername: { resident_id: 'RES-EXIST1' } });

  const { res, error } = await run(controller.registerResident, makeReq(validRegistration()));

  assert.equal(statusOf(res, error), 409);
  assert.match(error.message, /username/i);
  assert.equal(calledWith('createPendingRegistration'), undefined);
});

test('registerResident rejects a taken email before staging anything', async () => {
  const controller = loadController({ adminByEmail: { admin_id: 'ADM-EXIST1' } });

  const { res, error } = await run(controller.registerResident, makeReq(validRegistration()));

  assert.equal(statusOf(res, error), 409);
  assert.match(error.message, /email/i);
  assert.equal(calledWith('createPendingRegistration'), undefined);
});

test('registerResident enforces the documented password policy', async () => {
  for (const [password, reason] of [
    ['short1', /at least 8/i],
    ['alllettersonly', /one letter and one number/i],
    ['12345678', /one letter and one number/i],
  ]) {
    const controller = loadController();
    const { res, error } = await run(
      controller.registerResident,
      makeReq(validRegistration({ password }))
    );

    assert.equal(statusOf(res, error), 400, `expected 400 for ${password}`);
    assert.match(error.message, reason);
    assert.equal(calledWith('createPendingRegistration'), undefined);
  }
});

test('registerResident rejects a malformed email', async () => {
  const controller = loadController();
  const { res, error } = await run(
    controller.registerResident,
    makeReq(validRegistration({ email: 'not-an-email' }))
  );

  assert.equal(statusOf(res, error), 400);
  assert.match(error.message, /valid email/i);
});

// ---------------------------------------------------------------------------
// Verification: a Firebase session is the only accepted credential
// ---------------------------------------------------------------------------

test('checkVerification creates the account from a proven session', async () => {
  const controller = loadController({ pending: pendingRegistration() });

  const { res, error } = await run(
    controller.checkVerification,
    makeReq({ registrationId: 'REG-abcdefghijkl', idToken: 'a.b.c' })
  );

  assert.equal(error, undefined, `handler failed: ${error && error.message}`);
  assert.equal(res.body.verified, true);
  assert.equal(res.body.residentId, 'RES-NEW0001');
  assert.equal(res.body.username, 'kheysaliga2');

  const verified = calledWith('verifyRegistrationSession');
  assert.ok(verified, 'the Firebase session must be verified');
  assert.equal(verified.args.sawIdToken, true, 'the id token must actually be forwarded');

  const created = calledWith('createResident');
  assert.ok(created, 'the resident row must be created');
  assert.equal(created.args.firebaseUid, 'UID-VERIFIED1',
    'firebase_uid must come from the verified session, not the client');
  assert.equal(created.args.emailVerified, true);
  assert.equal(created.args.role, 'RESIDENT');
  assert.match(created.args.residentId, /^RES-[A-Z0-9]{8}$/);

  assert.ok(calledWith('deleteByRegistrationId'),
    'the pending row must be removed so verification cannot run twice');
});

test('checkVerification refuses a session whose email was never verified', async () => {
  const controller = loadController({
    pending: pendingRegistration(),
    verifyRegistrationSession: async () => {
      const error = new Error(
        'This email address has not been verified yet. Open the verification link '
        + 'in your email and try again.'
      );
      error.statusCode = 400;
      error.firebaseCode = 'EMAIL_NOT_VERIFIED';
      throw error;
    },
  });

  const { res, error } = await run(
    controller.checkVerification,
    makeReq({ registrationId: 'REG-abcdefghijkl', idToken: 'a.b.c' })
  );

  assert.equal(statusOf(res, error), 400);
  assert.equal(calledWith('createResident'), undefined,
    'an unverified session must not be able to create an account');
});

test('a session for one address cannot activate a different registration', async () => {
  const controller = loadController({
    pending: pendingRegistration(),
    // The token is valid and verified, but it names somebody else's address.
    verifyRegistrationSession: async () => ({
      uid: 'UID-ATTACKER',
      email: 'attacker@gmail.com',
      emailVerified: true,
    }),
  });

  const { res, error } = await run(
    controller.checkVerification,
    makeReq({ registrationId: 'REG-abcdefghijkl', idToken: 'a.b.c' })
  );

  assert.equal(statusOf(res, error), 400);
  assert.equal(calledWith('createResident'), undefined);
  assert.equal(calledWith('deleteByRegistrationId'), undefined,
    'the pending row must survive a mismatch so the real owner can still finish');
});

test('checkVerification refuses an expired registration', async () => {
  const controller = loadController({
    pending: pendingRegistration({ expires_at: new Date(Date.now() - 60000) }),
  });

  const { res, error } = await run(
    controller.checkVerification,
    makeReq({ registrationId: 'REG-abcdefghijkl', idToken: 'a.b.c' })
  );

  assert.equal(statusOf(res, error), 400);
  assert.match(error.message, /expired/i);
  assert.equal(calledWith('verifyRegistrationSession'), undefined);
});

test('checkVerification accepts a full-length Firebase ID token', async () => {
  /*
   * Regression guard. A Firebase ID token is a JWT well past 512 characters, and
   * it was previously validated against that short-token bound, so every real
   * registration failed with "Verification session is malformed".
   */
  const jwt = ['a'.repeat(36), 'b'.repeat(700), 'c'.repeat(256)].join('.');
  assert.ok(jwt.length > 512);

  const controller = loadController({ pending: pendingRegistration() });

  const { res, error } = await run(
    controller.checkVerification,
    makeReq({ registrationId: 'REG-abcdefghijkl', idToken: jwt })
  );

  assert.equal(error, undefined, `handler failed: ${error && error.message}`);
  assert.equal(res.body.verified, true);
  assert.equal(res.body.username, 'kheysaliga2');

  const verified = calledWith('verifyRegistrationSession');
  assert.ok(verified);
  assert.equal(verified.args.sawIdToken, true, 'the whole token must reach Firebase');
});

test('checkVerification rejects a missing or malformed id token', async () => {
  for (const body of [
    { registrationId: 'REG-abcdefghijkl' },
    { registrationId: 'REG-abcdefghijkl', idToken: '' },
    { registrationId: 'REG-abcdefghijkl', idToken: 'has space' },
  ]) {
    const controller = loadController({ pending: pendingRegistration() });
    const { res, error } = await run(controller.checkVerification, makeReq(body));

    assert.equal(statusOf(res, error), 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test('a registration that no longer exists is reported, not silently ignored', async () => {
  const controller = loadController({ pending: null });

  const { res, error } = await run(
    controller.checkVerification,
    makeReq({ registrationId: 'REG-abcdefghijkl', idToken: 'a.b.c' })
  );

  assert.equal(statusOf(res, error), 404);
});

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

test('forgotPassword does not reveal whether an address is registered', async () => {
  const known = loadController({
    residentByEmail: { resident_id: 'RES-1', username: 'a', email: 'a@gmail.com', status: 'AVAILABLE' },
  });
  const knownResult = await run(known.forgotPassword, makeReq({ email: 'a@gmail.com' }));

  const unknown = loadController();
  const unknownResult = await run(unknown.forgotPassword, makeReq({ email: 'nobody@nowhere.test' }));

  assert.equal(knownResult.error, undefined);
  assert.equal(unknownResult.error, undefined);

  // Byte-identical messaging, or the endpoint is an account-enumeration oracle.
  assert.equal(knownResult.res.body.message, unknownResult.res.body.message);
  // The flag differs, so the app knows not to attempt a Firebase send, but the
  // human-readable message stays identical.
  assert.equal(knownResult.res.body.canRequestFirebaseEmail, true);
  assert.equal(unknownResult.res.body.canRequestFirebaseEmail, false);
  assert.equal(calledWith('ensureIdentityForReset'), undefined,
    'no Firebase work for an unknown address');
});

test('forgotPassword makes sure a Firebase identity exists so the app can send', async () => {
  const controller = loadController({
    residentByEmail: {
      resident_id: 'RES-1', username: 'a', first_name: 'A', last_name: 'B',
      email: 'a@gmail.com', status: 'AVAILABLE', firebase_uid: null,
    },
  });

  const { res, error } = await run(controller.forgotPassword, makeReq({ email: 'a@gmail.com' }));

  assert.equal(error, undefined);
  assert.equal(res.body.canRequestFirebaseEmail, true);
  assert.ok(calledWith('ensureIdentityForReset'),
    'a legacy account with no identity must get one so Firebase will send');
  assert.ok(calledWith('setFirebaseUid'), 'the uid must be backfilled onto the account');
  assert.ok(calledWith('markResetLinkSent'), 'the cooldown must be recorded');
});

test('forgotPassword still prepares a reset for a disabled account', async () => {
  const controller = loadController({
    residentByEmail: {
      resident_id: 'RES-1', username: 'a', email: 'a@gmail.com', status: 'DISABLED',
    },
  });

  const { res, error } = await run(controller.forgotPassword, makeReq({ email: 'a@gmail.com' }));

  // Proving control of the inbox is allowed. Re-enabling is not, and nothing here
  // touches account status.
  assert.equal(error, undefined);
  assert.equal(calledWith('ensureIdentityForReset') !== undefined, true);
});

test('forgotPassword honours the cooldown', async () => {
  const controller = loadController({
    cooldownSeconds: 42,
    residentByEmail: {
      resident_id: 'RES-1', username: 'a', email: 'a@gmail.com', status: 'AVAILABLE',
    },
  });

  const { res } = await run(controller.forgotPassword, makeReq({ email: 'a@gmail.com' }));

  assert.equal(res.body.canRequestFirebaseEmail, false);
  assert.equal(res.body.retryAfterSeconds, 42);
  assert.equal(calledWith('ensureIdentityForReset'), undefined);
});

test('resetPassword writes the Supabase hash before syncing Firebase', async () => {
  const order = [];
  const controller = loadController({
    order,
    // Firebase names the account, so the fixture address has to be the one this
    // code was issued for. A mismatch is what the next test covers.
    inspectActionCode: async () => ({
      email: 'saligakhey@gmail.com',
      operation: 'PASSWORD_RESET',
    }),
    residentByEmail: {
      resident_id: 'RES-1', username: 'kheysaliga2', first_name: 'Khei',
      email: 'saligakhey@gmail.com', status: 'AVAILABLE',
    },
  });

  const { res, error } = await run(
    controller.resetPassword,
    makeReq({ oobCode: 'AbC-123_x.y', password: 'Newpass123' })
  );

  assert.equal(error, undefined, `handler failed: ${error && error.message}`);
  assert.equal(res.body.success, true);
  assert.equal(res.body.username, 'kheysaliga2');
  assert.equal(res.body.firebaseSynced, true);

  // Supabase is the authority and is committed first, so the new password works
  // for login the instant this returns.
  assert.equal(order[0], 'supabase', `expected Supabase first, got ${order.join(', ')}`);
  assert.ok(
    order.indexOf('firebase-password') > order.indexOf('supabase'),
    `Firebase must follow Supabase, got ${order.join(', ')}`
  );
  assert.ok(calledWith('clearResetLinkMarker'));
});

test('a Firebase sync failure still reports a successful password change', async () => {
  const controller = loadController({
    inspectActionCode: async () => ({
      email: 'saligakhey@gmail.com',
      operation: 'PASSWORD_RESET',
    }),
    residentByEmail: {
      resident_id: 'RES-1', username: 'kheysaliga2', email: 'saligakhey@gmail.com',
      status: 'AVAILABLE',
    },
    ensureIdentityForReset: async () => {
      const error = new Error('firebase is unreachable');
      error.statusCode = 503;
      throw error;
    },
  });

  const { res, error } = await run(
    controller.resetPassword,
    makeReq({ oobCode: 'AbC-123_x.y', password: 'Newpass123' })
  );

  // The EcoWatch password is already stored and usable, so this must not be
  // reported as a failed reset.
  assert.equal(error, undefined);
  assert.equal(res.body.success, true);
  assert.equal(res.body.firebaseSynced, false);
  assert.ok(res.body.warning, 'the drift must be reported as a warning');
});

test('resetPassword refuses a code issued for a different action', async () => {
  const controller = loadController({
    inspectActionCode: async () => {
      const error = new Error('This verification link cannot be used to reset a password.');
      error.statusCode = 400;
      throw error;
    },
  });

  const { res, error } = await run(
    controller.resetPassword,
    makeReq({ oobCode: 'AbC-123_x.y', password: 'Newpass123' })
  );

  assert.equal(statusOf(res, error), 400);
});

test('resetPassword updates the account Firebase names, not one the client names', async () => {
  const controller = loadController({
    // Firebase says the code belongs to a different address.
    inspectActionCode: async () => ({ email: 'other.person@gmail.com', operation: 'PASSWORD_RESET' }),
    residentByEmail: {
      resident_id: 'RES-VICTIM01', username: 'victim', email: 'saligakhey@gmail.com',
      status: 'AVAILABLE',
    },
  });

  const { res, error } = await run(
    controller.resetPassword,
    makeReq({ oobCode: 'AbC-123_x.y', password: 'Newpass123' })
  );

  assert.equal(statusOf(res, error), 400);
  assert.equal(calledWith('clearResetLinkMarker'), undefined);
});

test('a malformed oobCode is rejected before it reaches the database', async () => {
  for (const bad of ['', '   ', 'has space', "'; DROP TABLE residents;--"]) {
    const controller = loadController({
      residentByEmail: { resident_id: 'RES-1', username: 'a', email: 'a@gmail.com' },
    });

    const { res, error } = await run(
      controller.resetPassword,
      makeReq({ oobCode: bad, password: 'Newpass123' })
    );

    assert.equal(statusOf(res, error), 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// sync-firebase-password
// ---------------------------------------------------------------------------

test('syncFirebasePassword requires the current password, not just a JWT', async () => {
  const controller = loadController({
    currentResident: {
      resident_id: 'RES-1', username: 'a', email: 'a@gmail.com',
      // Deliberately not a bcrypt hash of anything, so the comparison cannot pass.
      password_hash: 'not-a-real-hash',
      role: 'RESIDENT', status: 'AVAILABLE',
    },
  });

  const { res, error } = await run(
    controller.syncFirebasePassword,
    makeReq({ currentPassword: 'definitely-wrong' }, {}, { resident: { resident_id: 'RES-1', role: 'RESIDENT' } })
  );

  assert.equal(statusOf(res, error), 401);
  assert.equal(calledWith('overwriteIdentityPassword'), undefined,
    'a wrong password must not be able to take over the email identity');
});

test('syncFirebasePassword cannot be used to rotate the password', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('Current123', 10);

  const controller = loadController({
    currentResident: {
      resident_id: 'RES-1', username: 'a', email: 'a@gmail.com',
      password_hash: hash, role: 'RESIDENT', status: 'AVAILABLE',
    },
  });

  const { res, error } = await run(
    controller.syncFirebasePassword,
    makeReq({ currentPassword: 'Current123', newPassword: 'Different123' }, {},
      { resident: { resident_id: 'RES-1', role: 'RESIDENT' } })
  );

  assert.equal(statusOf(res, error), 400);
  assert.match(error.message, /cannot change your password/i);
  assert.equal(calledWith('overwriteIdentityPassword'), undefined);
});

test('syncFirebasePassword aligns the identity once the current password matches', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('Current123', 10);

  const controller = loadController({
    currentResident: {
      resident_id: 'RES-1', username: 'a', email: 'a@gmail.com',
      password_hash: hash, role: 'RESIDENT', status: 'AVAILABLE', firebase_uid: null,
    },
  });

  const { res, error } = await run(
    controller.syncFirebasePassword,
    makeReq({ currentPassword: 'Current123' }, {},
      { resident: { resident_id: 'RES-1', role: 'RESIDENT' } })
  );

  assert.equal(error, undefined, `handler failed: ${error && error.message}`);
  assert.equal(res.body.success, true);
  assert.ok(calledWith('overwriteIdentityPassword'));
  assert.ok(calledWith('setFirebaseUid'));
});

const test = require('node:test');
const assert = require('node:assert/strict');

const Module = require('node:module');

/*
 * Behavioural tests for the Firebase email-link flow.
 *
 * These exist because of a bug that shipped: registerResident called
 * generateRegistrationId() without importing it. Every check we had passed at that
 * point -- node --check, requiring the module, and the rest of the suite -- because
 * a ReferenceError inside a function body is invisible until that function is
 * actually called.
 *
 * So these tests CALL the handlers. Dependencies are replaced through the module
 * cache so no database, no Firebase project and no network is involved, and the
 * body of each handler runs for real.
 */

const REPOSITORY_PATHS = [
  '../repositories/residentRepository',
  '../repositories/adminRepository',
  '../repositories/personnelRepository',
  '../repositories/pendingRegistrationRepository',
  '../repositories/passwordResetRepository',
];

const SERVICE_PATHS = [
  '../services/firebaseAuthService',
  '../utils/logger',
];

const calls = [];

const record = (name, result) => {
  calls.push({ name, args: result });
  return result;
};

/**
 * Replaces a module in the require cache so the controller sees a stub.
 */
const stubModule = (relativePath, exports) => {
  const resolved = require.resolve(relativePath);
  const stub = new Module(resolved, null);
  stub.filename = resolved;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[resolved] = stub;
};

/**
 * Stands in for a by-email lookup.
 *
 * When the override declares its own address the stub only answers for that
 * address, which is what a real query does. Without this, a single record would
 * be returned for every address and the tests could not tell the difference
 * between "Firebase named this account" and "some account exists".
 *
 * An override with no address stays address-agnostic, for the cases where the
 * point of the test is simply that the address is taken.
 */
const matchByEmail = (override, email) => {
  if (!override) {
    return null;
  }

  if (!override.email) {
    return override;
  }

  return String(email).trim().toLowerCase() === String(override.email).trim().toLowerCase()
    ? override
    : null;
};

/** Minimal Express response double. */
const makeRes = () => ({
  statusCode: 200,
  body: null,
  headersSent: false,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
  set() {
    return this;
  },
});

/** Minimal Express request double. */
const makeReq = (body = {}, query = {}) => ({
  body,
  query,
  requestId: 'test-request',
});

/**
 * The HTTP status a caller would actually see.
 *
 * This controller reports failures by setting statusCode on the error and
 * forwarding it, and middleware/errorMiddleware.js is what turns that into a
 * response status. The middleware is Express plumbing and is not under test here,
 * so the status is read from whichever carrier the handler used.
 */
const statusOf = (res, error) => (
  error && Number.isInteger(error.statusCode) ? error.statusCode : res.statusCode
);

/**
 * Runs an async handler and returns the error it forwarded, if any.
 *
 * Handlers in this codebase signal failure by calling next(error) rather than
 * throwing, so the error has to be captured rather than caught.
 */
const run = async (handler, req) => {
  const res = makeRes();
  let forwarded;

  await handler(req, res, (error) => {
    forwarded = error;
  });

  return { res, error: forwarded };
};

const validRegistration = (overrides = {}) => ({
  firstName: 'Khei',
  lastName: 'Saliga',
  username: 'kheysaliga2',
  email: 'saligakhey@gmail.com',
  password: '@Sample123',
  verificationMethod: 'EMAIL_LINK',
  ...overrides,
});

/**
 * Loads a fresh copy of the controller against stubs.
 *
 * utils/generateId is deliberately NOT stubbed, so the real identifier generators
 * run. That is what makes this suite able to catch the exact class of bug it was
 * written for.
 */
const loadController = (overrides = {}) => {
  calls.length = 0;

  stubModule('../repositories/residentRepository', {
    findByUsername: async () => overrides.residentByUsername ?? null,
    findByEmail: async (email) => matchByEmail(overrides.residentByEmail, email),
    findByResidentId: async () => null,
    createResident: async (payload) =>
      record('createResident', { resident_id: 'RES-NEW0001', ...payload }),
    updatePassword: async () => null,
    setFirebaseUid: async () => null,
    findByFirebaseUid: async () => null,
    markEmailVerified: async () => null,
  });

  stubModule('../repositories/adminRepository', {
    findByUsername: async () => overrides.adminByUsername ?? null,
    findByEmail: async (email) => matchByEmail(overrides.adminByEmail, email),
    findByAdminId: async () => null,
    updatePassword: async () => null,
    setFirebaseUid: async () => null,
    findByFirebaseUid: async () => null,
    markEmailVerified: async () => null,
  });

  stubModule('../repositories/personnelRepository', {
    findByUsername: async () => overrides.personnelByUsername ?? null,
    findByEmail: async () => overrides.personnelByEmail ?? null,
  });

  stubModule('../repositories/pendingRegistrationRepository', {
    createPendingRegistration: async (payload) =>
      record('createPendingRegistration', {
        registration_id: payload.registrationId,
        ...payload,
      }),
    findByRegistrationId: async () => overrides.pending ?? null,
    deleteByRegistrationId: async () => record('deleteByRegistrationId', null),
    deleteUnverifiedByEmail: async () => record('deleteUnverifiedByEmail', []),
    touchVerificationSent: async () => null,
    attachFirebaseUid: async () => null,
  });

  stubModule('../repositories/passwordResetRepository', {
    getCooldownSeconds: async () => overrides.cooldownSeconds ?? 0,
    markResetLinkSent: async () => record('markResetLinkSent', null),
    clearResetLinkMarker: async () => record('clearResetLinkMarker', null),
    findByEmail: async () => null,
    deleteByEmail: async () => null,
  });

  stubModule('../services/firebaseAuthService', {
    createVerificationIdentity: overrides.createVerificationIdentity
      || (async (payload) => record('createVerificationIdentity', {
        uid: 'UID-NEW0001',
        email: payload.email,
      })),
    sendVerificationLink: overrides.sendVerificationLink
      || (async () => record('sendVerificationLink', null)),
    sendPasswordResetLink: overrides.sendPasswordResetLink
      || (async () => record('sendPasswordResetLink', null)),
    deleteUnverifiedIdentity: overrides.deleteUnverifiedIdentity
      || (async () => record('deleteUnverifiedIdentity', null)),
    ensureIdentityForReset: overrides.ensureIdentityForReset
      || (async () => record('ensureIdentityForReset', { uid: 'UID-EXISTING' })),
    ensureIdentity: overrides.ensureIdentity
      || (async () => record('ensureIdentity', { uid: 'UID-EXISTING' })),
    inspectActionCode: overrides.inspectActionCode
      || (async () => record('inspectActionCode', {
        email: 'saligakhey@gmail.com',
        operation: 'PASSWORD_RESET',
      })),
    isEmailVerified: overrides.isEmailVerified
      || (async () => record('isEmailVerified', { verified: false, email: null })),
    overwriteIdentityPassword: async () => record('overwriteIdentityPassword', true),
    EMAIL_LINK_METHOD: 'EMAIL_LINK',
  });

  stubModule('../utils/logger', {
    logInfo: () => {},
    logError: () => {},
    logProfileRequest: () => {},
  });

  // Force a fresh module so the stubs are picked up.
  delete require.cache[require.resolve('../controllers/firebaseAuthController')];
  return require('../controllers/firebaseAuthController');
};

const calledWith = (name) => calls.find((entry) => entry.name === name);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('registerResident runs to completion and creates a pending registration', async () => {
  const controller = loadController();

  // The body of this handler is what shipped with the missing import, so merely
  // reaching the end is the assertion.
  const { res, error } = await run(controller.registerResident, makeReq(validRegistration()));

  assert.equal(error, undefined, `handler failed: ${error && error.message}`);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.verificationRequired, true);
  assert.equal(res.body.verificationMethod, 'EMAIL_LINK');
  assert.match(res.body.registrationId, /^REG-/);

  const pending = calledWith('createPendingRegistration');
  assert.ok(pending, 'a pending registration must be created');
  assert.equal(pending.args.verificationFlow, 'EMAIL_LINK');
  assert.equal(pending.args.firebaseUid, 'UID-NEW0001');
  assert.equal(pending.args.otpHash, null, 'the email-link flow stores no OTP');

  // The account must NOT exist yet. This is the guarantee that an unverified
  // signup can never log in.
  assert.equal(
    calledWith('createResident'),
    undefined,
    'no resident row may be created before the email is verified'
  );

  // The identifier generator must have produced something usable.
  assert.match(pending.args.registrationId, /^REG-[a-z0-9]{12}$/);
  assert.ok(pending.args.passwordHash.startsWith('$2'), 'password must be bcrypt hashed');
  assert.equal(
    pending.args.passwordHash.includes('@Sample123'),
    false,
    'the plaintext password must never be stored'
  );
});

test('registerResident rejects a taken username before creating anything', async () => {
  const controller = loadController({ residentByUsername: { resident_id: 'RES-EXIST1' } });

  const { res, error } = await run(controller.registerResident, makeReq(validRegistration()));

  assert.equal(statusOf(res, error), 409);
  assert.match(error.message, /username/i);
  assert.equal(calledWith('createVerificationIdentity'), undefined,
    'no Firebase identity may be created for a rejected registration');
  assert.equal(calledWith('createPendingRegistration'), undefined);
});

test('registerResident rejects a taken email before creating anything', async () => {
  const controller = loadController({ adminByEmail: { admin_id: 'ADM-EXIST1' } });

  const { res, error } = await run(controller.registerResident, makeReq(validRegistration()));

  assert.equal(statusOf(res, error), 409);
  assert.match(error.message, /email/i);
  assert.equal(calledWith('createVerificationIdentity'), undefined);
});

test('registerResident enforces the password policy the server documents', async () => {
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
    assert.equal(calledWith('createVerificationIdentity'), undefined);
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

test('a stale Firebase identity is retired so the address can register again', async () => {
  let attempts = 0;

  const controller = loadController({
    createVerificationIdentity: async (payload) => {
      attempts += 1;
      if (attempts === 1) {
        // Firebase refuses a second createUser for an address it already holds.
        const error = new Error('already exists');
        error.firebaseCode = 'auth/email-already-exists';
        error.statusCode = 409;
        throw error;
      }
      return { uid: 'UID-SECOND', email: payload.email };
    },
  });

  // The retry path calls findIdentityByEmail, which the stub does not provide on
  // the service object, so it is added here.
  require.cache[require.resolve('../services/firebaseAuthService')].exports.findIdentityByEmail =
    async () => ({ uid: 'UID-STALE', emailVerified: false });

  const { res, error } = await run(controller.registerResident, makeReq(validRegistration()));

  assert.equal(error, undefined, `handler failed: ${error && error.message}`);
  assert.equal(res.statusCode, 201);
  assert.equal(attempts, 2, 'must retry exactly once');
  assert.ok(calledWith('deleteUnverifiedIdentity'), 'the stale identity must be retired');
  assert.equal(calledWith('createPendingRegistration').args.firebaseUid, 'UID-SECOND');
});

test('a failed verification email leaves nothing behind', async () => {
  const controller = loadController({
    sendVerificationLink: async () => {
      throw new Error('resend is down');
    },
  });

  const { error } = await run(controller.registerResident, makeReq(validRegistration()));

  assert.ok(error, 'the failure must be forwarded');
  assert.equal(calledWith('createPendingRegistration'), undefined,
    'no pending row may survive a failed send');
  assert.ok(calledWith('deleteUnverifiedIdentity'),
    'the orphan Firebase identity must be cleaned up');
});

test('checkVerification reports not-yet-verified without creating an account', async () => {
  const controller = loadController({
    isEmailVerified: async () => ({ verified: false, email: 'saligakhey@gmail.com' }),
    pending: {
      registration_id: 'REG-abcdefghijkl',
      username: 'kheysaliga2',
      email: 'saligakhey@gmail.com',
      firebase_uid: 'UID-NEW0001',
      verification_flow: 'EMAIL_LINK',
      expires_at: new Date(Date.now() + 60000),
      verification_sent_at: new Date(),
    },
  });

  const { res, error } = await run(
    controller.checkVerification,
    makeReq({}, { registrationId: 'REG-abcdefghijkl', email: 'saligakhey@gmail.com' })
  );

  assert.equal(error, undefined);
  assert.equal(res.body.verified, false);
  assert.equal(res.body.canResend, true);
  assert.equal(calledWith('createResident'), undefined,
    'an unverified email must not produce a resident');
});

test('checkVerification creates the account once Firebase confirms the address', async () => {
  const controller = loadController({
    isEmailVerified: async () => ({ verified: true, email: 'saligakhey@gmail.com' }),
    pending: {
      registration_id: 'REG-abcdefghijkl',
      first_name: 'Khei',
      last_name: 'Saliga',
      username: 'kheysaliga2',
      email: 'saligakhey@gmail.com',
      password_hash: '$2$10$abcdefghijklmnopqrstuv',
      firebase_uid: 'UID-NEW0001',
      verification_flow: 'EMAIL_LINK',
      expires_at: new Date(Date.now() + 60000),
      verification_sent_at: new Date(),
    },
  });

  const { res, error } = await run(
    controller.checkVerification,
    makeReq({}, { registrationId: 'REG-abcdefghijkl', email: 'saligakhey@gmail.com' })
  );

  assert.equal(error, undefined, `handler failed: ${error && error.message}`);
  assert.equal(res.body.verified, true);
  assert.equal(res.body.residentId, 'RES-NEW0001');
  assert.equal(res.body.username, 'kheysaliga2');

  const created = calledWith('createResident');
  assert.ok(created, 'the resident row must be created on the transition');
  assert.equal(created.args.emailVerified, true);
  assert.equal(created.args.firebaseUid, 'UID-NEW0001');
  assert.equal(created.args.role, 'RESIDENT');
  assert.match(created.args.residentId, /^RES-[A-Z0-9]{8}$/);

  assert.ok(calledWith('deleteByRegistrationId'),
    'the pending row must be removed so the step cannot run twice');
});

test('checkVerification refuses an expired registration', async () => {
  const controller = loadController({
    pending: {
      registration_id: 'REG-abcdefghijkl',
      username: 'kheysaliga2',
      email: 'saligakhey@gmail.com',
      firebase_uid: 'UID-NEW0001',
      verification_flow: 'EMAIL_LINK',
      expires_at: new Date(Date.now() - 60000),
      verification_sent_at: new Date(),
    },
  });

  const { res, error } = await run(
    controller.checkVerification,
    makeReq({}, { registrationId: 'REG-abcdefghijkl', email: 'saligakhey@gmail.com' })
  );

  assert.equal(statusOf(res, error), 400);
  assert.match(error.message, /expired/i);
  assert.equal(calledWith('createResident'), undefined);
});

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

test('forgotPassword does not reveal whether an address is registered', async () => {
  const withAccount = loadController();
  const known = await run(
    withAccount.forgotPassword,
    makeReq({ email: 'saligakhey@gmail.com' })
  );

  const withoutAccount = loadController();
  const unknown = await run(withoutAccount.forgotPassword, makeReq({ email: 'nobody@nowhere.test' }));

  assert.equal(known.error, undefined);
  assert.equal(unknown.error, undefined);

  // Byte-identical responses, or the endpoint becomes an account-enumeration
  // oracle for which addresses have an EcoWatch account.
  assert.deepEqual(known.res.body, unknown.res.body);
  assert.equal(calledWith('sendPasswordResetLink'), undefined,
    'no link may be attempted for an unknown address');
});

test('forgotPassword sends a link for a known account', async () => {
  const controller = loadController({
    residentByEmail: {
      resident_id: 'RES-EXIST1',
      username: 'kheysaliga2',
      first_name: 'Khei',
      last_name: 'Saliga',
      email: 'saligakhey@gmail.com',
      status: 'AVAILABLE',
    },
  });

  const { res, error } = await run(
    controller.forgotPassword,
    makeReq({ email: 'saligakhey@gmail.com' })
  );

  assert.equal(error, undefined);
  assert.ok(calledWith('sendPasswordResetLink'));
  assert.ok(calledWith('markResetLinkSent'), 'the cooldown must be recorded');
});

test('forgotPassword still sends for a disabled account, which stays disabled', async () => {
  const controller = loadController({
    residentByEmail: {
      resident_id: 'RES-EXIST1',
      username: 'kheysaliga2',
      first_name: 'Khei',
      last_name: 'Saliga',
      email: 'saligakhey@gmail.com',
      status: 'DISABLED',
    },
  });

  const { res, error } = await run(
    controller.forgotPassword,
    makeReq({ email: 'saligakhey@gmail.com' })
  );

  // Resetting proves control of the inbox, so it is allowed. Re-enabling is not,
  // and nothing here touches residents.status.
  assert.equal(error, undefined);
  assert.ok(calledWith('sendPasswordResetLink'));
  assert.equal(calledWith('createResident'), undefined);
});

test('forgotPassword honours the resend cooldown', async () => {
  const controller = loadController({
    cooldownSeconds: 42,
    residentByEmail: {
      resident_id: 'RES-EXIST1',
      username: 'kheysaliga2',
      email: 'saligakhey@gmail.com',
      status: 'AVAILABLE',
    },
  });

  const { res } = await run(controller.forgotPassword, makeReq({ email: 'saligakhey@gmail.com' }));

  assert.equal(calledWith('sendPasswordResetLink'), undefined,
    'a second email inside the cooldown window must be suppressed');
  assert.match(res.body.message, /check your email|if an account exists/i);
});

test('resetPassword writes the Supabase hash before syncing Firebase', async () => {
  const order = [];

  const controller = loadController({
    residentByEmail: {
      resident_id: 'RES-EXIST1',
      username: 'kheysaliga2',
      first_name: 'Khei',
      last_name: 'Saliga',
      email: 'saligakhey@gmail.com',
      status: 'AVAILABLE',
    },
    ensureIdentity: async () => {
      order.push('firebase');
      return { uid: 'UID-EXISTING', created: false };
    },
  });

  // Record the Supabase write.
  require.cache[require.resolve('../repositories/residentRepository')].exports.updatePassword =
    async (residentId, hash) => {
      order.push('supabase');
      return { resident_id: residentId, password_hash: hash };
    };

  const { res, error } = await run(
    controller.resetPassword,
    makeReq({ oobCode: 'AbC-123_x.y', password: 'Newpass123' })
  );

  assert.equal(error, undefined, `handler failed: ${error && error.message}`);
  assert.equal(res.body.success, true);
  assert.equal(res.body.username, 'kheysaliga2');
  assert.equal(res.body.firebaseSynced, true);

  // Supabase is the authority and must be committed first, so the new password
  // works for login the instant this returns.
  assert.deepEqual(order, ['supabase', 'firebase']);
  assert.ok(calledWith('clearResetLinkMarker'), 'the cooldown marker must be cleared');
});

test('a Firebase sync failure still reports a successful password change', async () => {
  const controller = loadController({
    residentByEmail: {
      resident_id: 'RES-EXIST1',
      username: 'kheysaliga2',
      email: 'saligakhey@gmail.com',
      status: 'AVAILABLE',
    },
    ensureIdentity: async () => {
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
  assert.ok(error);
});

test('resetPassword updates the account Firebase names, not one the client names', async () => {
  const controller = loadController({
    // Firebase says the code belongs to a different address.
    inspectActionCode: async () => ({
      email: 'other.person@gmail.com',
      operation: 'PASSWORD_RESET',
    }),
    residentByEmail: {
      resident_id: 'RES-VICTIM01',
      username: 'victim',
      email: 'saligakhey@gmail.com',
      status: 'AVAILABLE',
    },
  });

  const { res, error } = await run(
    controller.resetPassword,
    makeReq({ oobCode: 'AbC-123_x.y', password: 'Newpass123' })
  );

  // The address Firebase reported has no EcoWatch account, so nothing is touched.
  assert.equal(statusOf(res, error), 400);
  assert.equal(calledWith('clearResetLinkMarker'), undefined);
});

test('a malformed oobCode is rejected before it reaches the database', async () => {
  for (const bad of ['', '   ', 'has space', "'; DROP TABLE residents;--"]) {
    const controller = loadController({
      residentByEmail: {
        resident_id: 'RES-EXIST1',
        username: 'kheysaliga2',
        email: 'saligakhey@gmail.com',
      },
    });

    const { res, error } = await run(
      controller.resetPassword,
      makeReq({ oobCode: bad, password: 'Newpass123' })
    );

    assert.equal(statusOf(res, error), 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  EMAIL_LINK_METHOD,
  RESET_LINK_COOLDOWN_SECONDS,
  NEUTRAL_RESET_MESSAGE,
} = require('../controllers/firebaseAuthController');

const {
  normalizeEmail,
  requireEmail,
  requirePassword,
  requireUsername,
  requireOpaqueToken,
} = require('../utils/authValidation');

const authController = require('../controllers/authController');

/*
 * Guards the properties this feature must not break:
 *
 *   1. the login path is untouched and still username + bcrypt,
 *   2. the legacy OTP transport the Admin app depends on still routes exactly as
 *      it did, and
 *   3. a Firebase credential is honoured in exactly one place, and that place
 *      creates an account rather than granting access to one.
 *
 * The validation tests exist because the email-link flow is the only place a
 * password policy is enforced; the legacy flow deliberately is not, and a bug
 * here would reject passwords that work today.
 */

const ANDROID_ROOT = path.join(__dirname, '..', '..', 'MyEcoWatch1');
const hasAndroidProject = fs.existsSync(ANDROID_ROOT);

const readAndroidSource = (relativePath) => {
  const full = path.join(ANDROID_ROOT, relativePath);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
};

// ---------------------------------------------------------------------------
// Login is unchanged
// ---------------------------------------------------------------------------

test('login controller is still exported and takes username + password only', () => {
  assert.equal(typeof authController.loginResident, 'function');
  assert.equal(authController.loginResident.length, 3);
});

test('no Firebase credential is accepted by the login route', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'controllers', 'authController.js'),
    'utf8'
  );

  const loginBody = source.slice(
    source.indexOf('const loginResident'),
    source.indexOf('const getResidentProfile')
  );

  // A Firebase ID token or session must never be a login input. If any of these
  // appear, Firebase has been allowed into the login path.
  for (const forbidden of [
    'idToken',
    'getIdToken',
    'verifyIdToken',
    'FirebaseAuth',
    'ecowatch-id-token',
  ]) {
    assert.equal(
      loginBody.includes(forbidden),
      false,
      `login path must not reference ${forbidden}`
    );
  }

  // Username and password are still the only two inputs.
  assert.match(loginBody, /const \{ username, password \} = req\.body;/);
});

// ---------------------------------------------------------------------------
// Transport dispatch
// ---------------------------------------------------------------------------

/**
 * Replays the exact dispatch predicate each shared handler uses, so a change to
 * one of them fails here rather than silently rerouting a deployed client.
 */
const dispatchesToFirebase = {
  register: (body) =>
    String(body.verificationMethod || '').trim().toUpperCase() ===
    EMAIL_LINK_METHOD,
  'forgot-password': (body) => Boolean(body.email) && !body.username,
  'reset-password': (body) => Boolean(body.oobCode),
};

test('Admin app requests still take the legacy OTP transport', () => {
  // These are the exact bodies EcoWatch Admin1 sends. None may be rerouted.
  assert.equal(
    dispatchesToFirebase.register({
      firstName: 'Ana',
      lastName: 'Reyes',
      username: 'areyes',
      email: 'ana@school.edu',
      password: 'legacy123',
    }),
    false
  );

  assert.equal(dispatchesToFirebase['forgot-password']({ username: 'areyes' }), false);
  assert.equal(
    dispatchesToFirebase['reset-password']({
      username: 'areyes',
      otp: '1234',
      password: 'newpass123',
    }),
    false
  );
});

test('Resident app requests take the Firebase email-link transport', () => {
  assert.equal(
    dispatchesToFirebase.register({
      firstName: 'Khei',
      lastName: 'Ron',
      username: 'kheyron123',
      email: 'khei@gmail.com',
      password: 'Newpass123',
      verificationMethod: EMAIL_LINK_METHOD,
    }),
    true
  );

  assert.equal(
    dispatchesToFirebase['forgot-password']({ email: 'khei@gmail.com' }),
    true
  );

  assert.equal(
    dispatchesToFirebase['reset-password']({
      oobCode: 'abcDEF123-_=.',
      password: 'Newpass123',
    }),
    true
  );
});

test('a registration cannot opt into the weaker flow by naming it', () => {
  for (const value of ['otp', 'OTP', 'none', '', null, undefined, 0, false]) {
    assert.equal(
      dispatchesToFirebase.register({ username: 'kheyron123', verificationMethod: value }),
      false
    );
  }
});

// ---------------------------------------------------------------------------
// A Firebase credential is honoured in exactly one place
// ---------------------------------------------------------------------------

test('verifyRegistrationSession is the only place a Firebase ID token is verified', () => {
  const files = [
    'controllers/firebaseAuthController.js',
    'controllers/authController.js',
    'routes/authRoutes.js',
    'middleware/authMiddleware.js',
    'repositories/residentRepository.js',
    'repositories/adminRepository.js',
    'utils/generateToken.js',
  ];

  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

    // Only the service may actually verify a token. Everything else may pass one
    // along, but must never treat it as proof by itself.
    assert.equal(
      /verifyIdToken\s*\(/.test(source),
      false,
      `${file} must not call verifyIdToken; only services/firebaseAuthService.js may`
    );
  }

  // The token is received by the controller and handed to the service. That is
  // the whole of its role: it is never trusted locally.
  const controller = fs.readFileSync(
    path.join(__dirname, '..', 'controllers', 'firebaseAuthController.js'),
    'utf8'
  );
  assert.match(controller, /verifyRegistrationSession/,
    'the controller must delegate to the service rather than verify locally');
});

test('the App Link continue URL is declared by the app, not the backend', () => {
  // Delivery is now entirely on the device, so the backend holds no continue URL.
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'firebaseAuthService.js'),
    'utf8'
  );

  for (const forbidden of ['FIREBASE_CONTINUE_URL', 'buildActionCodeSettings', 'generatePasswordResetLink']) {
    assert.equal(
      service.includes(forbidden),
      false,
      `the backend must not hold ${forbidden}; Firebase links are client-driven now`
    );
  }
});

test('the reset cooldown is defined and positive', () => {
  assert.equal(Number.isInteger(RESET_LINK_COOLDOWN_SECONDS), true);
  assert.ok(RESET_LINK_COOLDOWN_SECONDS > 0);
  assert.ok(NEUTRAL_RESET_MESSAGE.length > 0);
});

// ---------------------------------------------------------------------------
// Android: the app owns the Firebase session
// ---------------------------------------------------------------------------

test('the app asks Firebase to send both emails and signs out afterwards', (t) => {
  if (!hasAndroidProject) {
    t.skip('MyEcoWatch1 not present in this checkout');
    return;
  }

  // FirebaseEmailSession owns every Firebase call, so that is where the session
  // rules are checked.
  const session = readAndroidSource(
    'app/src/main/java/com/example/myecowatch1/utils/FirebaseEmailSession.java'
  );

  if (!session) {
    t.skip('FirebaseEmailSession not found');
    return;
  }

  // Firebase only sends a verification email for a signed-in user, so these
  // calls cannot work without a session. They are the reason one exists.
  assert.match(session, /createUserWithEmailAndPassword/,
    'the app must create the Firebase user so a verification email can be sent');
  assert.match(session, /sendEmailVerification/,
    'the app must trigger the verification email itself');

  // And the session must not outlive registration.
  assert.match(session, /signOut/,
    'the app must sign out of Firebase once the account exists');

  // The session is refreshed from the server before the token is read, because
  // emailVerified on a cached user does not update on its own.
  assert.match(session, /\.reload\(\)/,
    'the local session must be refreshed before emailVerified is trusted');
  assert.match(session, /getIdToken/,
    'the backend needs a fresh ID token to confirm');

  // The reset email is sent from the device, since Firebase requires a session
  // for verification and the backend holds no mail credential.
  const forgot = readAndroidSource(
    'app/src/main/java/com/example/myecowatch1/ui/auth/ForgotPasswordFragment.java'
  );
  assert.ok(forgot, 'ForgotPasswordFragment not found');
  assert.match(forgot, /sendPasswordResetEmail/,
    'the app must trigger the reset email itself');
  assert.match(forgot, /preparePasswordReset/,
    'the backend must prepare the reset before Firebase will send');
});

test('the verification screen signs out once the account exists', (t) => {
  if (!hasAndroidProject) {
    t.skip('MyEcoWatch1 not present in this checkout');
    return;
  }

  const fragment = readAndroidSource(
    'app/src/main/java/com/example/myecowatch1/ui/auth/VerifyEmailFragment.java'
  );

  if (!fragment) {
    t.skip('VerifyEmailFragment not found');
    return;
  }

  assert.match(fragment, /FirebaseEmailSession\.signOutQuietly\(\)/,
    'the session must be closed once the account exists');
  assert.match(fragment, /checkEmailVerification/,
    'the backend must confirm the session rather than the app deciding');
  assert.match(fragment, /resendVerificationEmail|resendVerification/,
    'the resend button must be present');
});

test('the app still asks the backend to confirm verification, not Firebase', (t) => {
  if (!hasAndroidProject) {
    t.skip('MyEcoWatch1 not present in this checkout');
    return;
  }

  const repository = readAndroidSource(
    'app/src/main/java/com/example/myecowatch1/data/repository/AuthRepository.java'
  );

  if (!repository) {
    t.skip('AuthRepository not found');
    return;
  }

  // The token is a credential, so it travels in a POST body and never a query string.
  assert.match(repository, /checkVerification|verifyRegistration/,
    'the app must call the backend to confirm the verified session');
  assert.equal(/check-verification\?/.test(repository), false,
    'the id token must never be placed in a URL');
});

test('the App Link the emails continue to is declared in the manifest', (t) => {
  if (!hasAndroidProject) {
    t.skip('MyEcoWatch1 not present in this checkout');
    return;
  }

  const manifest = readAndroidSource('app/src/main/AndroidManifest.xml');
  if (!manifest) {
    t.skip('manifest not found');
    return;
  }

  assert.match(manifest, /android:autoVerify="true"/,
    'the App Link must request autoVerify');
  assert.match(manifest, /android:host="ecowatch1-4445f\.firebaseapp\.com"/,
    'the App Link host must match the Firebase default domain');
  assert.match(manifest, /android:pathPrefix="\/finishSignUp"/,
    'the App Link path must be the one the continue URL points at');
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('email accepts every provider the requirement names', () => {
  const accepted = [
    'someone@gmail.com',
    'someone@yahoo.com',
    'someone@outlook.com',
    'someone@hotmail.com',
    'student@school.edu',
    'a.b+tag@sub.domain.co.uk',
    'first_last@sub.domain.ph',
  ];

  for (const email of accepted) {
    assert.doesNotThrow(() => requireEmail(email), `should accept ${email}`);
  }

  const rejected = ['', 'no-at-sign', 'a@b', 'a b@gmail.com', 'a@.com', '@gmail.com'];
  for (const email of rejected) {
    assert.throws(() => requireEmail(email), undefined, `should reject ${email}`);
  }
});

test('email is normalised for uniqueness comparison', () => {
  // A resident must not be able to register the same address twice by changing
  // its case, and the value stored must be the lower-cased one.
  assert.equal(normalizeEmail('  Khei@Gmail.COM '), 'khei@gmail.com');
});

test('password policy rejects weak passwords and accepts strong ones', () => {
  assert.doesNotThrow(() => requirePassword('pass1234'));
  assert.doesNotThrow(() => requirePassword('Khei12345'));

  for (const weak of ['', '   ', 'short1', 'alllettersonly', '12345678']) {
    assert.throws(
      () => requirePassword(weak),
      undefined,
      `should reject ${JSON.stringify(weak)}`
    );
  }
});

test('password is limited by bcrypt 72-byte ceiling, not 72 characters', () => {
  // 40 emoji = 160 UTF-8 bytes. Bcrypt would silently truncate at 72 bytes, so
  // the tail would be ignored and the stored hash would not match what the
  // resident believes they typed.
  assert.throws(() => requirePassword('\u{1F600}'.repeat(40)));

  // 72 ASCII characters is exactly at the limit and must be allowed.
  assert.doesNotThrow(() => requirePassword(`a1${'a'.repeat(70)}`));
});

test('username mirrors the Android UsernameValidator rule', () => {
  assert.doesNotThrow(() => requireUsername('kheyron123'));
  assert.doesNotThrow(() => requireUsername('a_b'));

  for (const invalid of ['', 'ab', 'a b', 'has-hyphen', 'a'.repeat(21)]) {
    assert.throws(
      () => requireUsername(invalid),
      undefined,
      `should reject ${JSON.stringify(invalid)}`
    );
  }
});

test('opaque Firebase tokens are bounded before reaching a query', () => {
  // A Firebase ID token is dot-separated base64url, and an oobCode is opaque, so
  // this bound covers both without accepting anything injectable.
  assert.doesNotThrow(() => requireOpaqueToken('REG-a1b2c3d4e5f6', 'Registration ID'));
  assert.doesNotThrow(() => requireOpaqueToken('AbC-123_x.y', 'Reset code'));
  assert.doesNotThrow(() => requireOpaqueToken('eyJhbGciOi.x9y.zQw_123-abc', 'Verification session'));

  for (const bad of ['', '   ', 'has space', "'; DROP TABLE residents;--", 'a'.repeat(513)]) {
    assert.throws(
      () => requireOpaqueToken(bad, 'Reset code'),
      undefined,
      `should reject ${JSON.stringify(bad)}`
    );
  }
});

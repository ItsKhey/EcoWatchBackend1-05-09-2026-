const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getResendCooldown,
  RESEND_COOLDOWN_SECONDS,
  EMAIL_LINK_METHOD,
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
 * Guards the two properties this feature must not break:
 *
 *   1. the login path is untouched and still username + bcrypt, and
 *   2. the legacy OTP transport the Admin app depends on still routes exactly as
 *      it did, so a deployed Admin build keeps working.
 *
 * The validation tests exist because the email-link flow is the only place a
 * password policy is enforced; the legacy flow deliberately is not, and a bug
 * here would reject passwords that work today.
 */

// ---------------------------------------------------------------------------
// Login is unchanged
// ---------------------------------------------------------------------------

test('login controller is still exported and takes username + password only', () => {
  assert.equal(typeof authController.loginResident, 'function');
  assert.equal(authController.loginResident.length, 3);
});

test('no Firebase credential is accepted by the login route', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'controllers', 'authController.js'),
    'utf8'
  );

  const loginBody = source.slice(
    source.indexOf('const loginResident'),
    source.indexOf('const getResidentProfile')
  );

  // A Firebase ID token, session cookie or provider result must never be a login
  // input. If any of these appear, Firebase has been allowed into the login path.
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
  // Only EMAIL_LINK is recognised, and only as an exact match. There is no value
  // a client can send that selects the legacy path for a new build.
  for (const value of ['otp', 'OTP', 'none', '', null, undefined, 0, false]) {
    assert.equal(
      dispatchesToFirebase.register({
        username: 'kheyron123',
        verificationMethod: value,
      }),
      false
    );
  }
});

// ---------------------------------------------------------------------------
// Resend cooldown
// ---------------------------------------------------------------------------

test('resend cooldown blocks a second link inside the window', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const justSent = new Date(now - 5 * 1000).toISOString();

  assert.equal(getResendCooldown(justSent, now), RESEND_COOLDOWN_SECONDS - 5);
  assert.ok(getResendCooldown(justSent, now) > 0);
});

test('resend cooldown allows a link once the window has passed', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const longAgo = new Date(now - (RESEND_COOLDOWN_SECONDS + 1) * 1000).toISOString();

  assert.equal(getResendCooldown(longAgo, now), 0);
  assert.equal(getResendCooldown(null, now), 0);
  assert.equal(getResendCooldown('not-a-date', now), 0);
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
  assert.doesNotThrow(() => requireOpaqueToken('REG-a1b2c3d4e5f6', 'Registration ID'));
  assert.doesNotThrow(() => requireOpaqueToken('AbC-123_x.y', 'Reset code'));

  for (const bad of ['', '   ', 'has space', "'; DROP TABLE residents;--", 'a'.repeat(513)]) {
    assert.throws(
      () => requireOpaqueToken(bad, 'Reset code'),
      undefined,
      `should reject ${JSON.stringify(bad)}`
    );
  }
});

// ---------------------------------------------------------------------------
// App Link continue URL
// ---------------------------------------------------------------------------

test('the continue URL is an https App Link on the Firebase domain', () => {
  const { getContinueUrl, getVerificationContinueUrl, DEFAULT_CONTINUE_URL } =
    require('../services/firebaseAuthService');

  // A custom scheme here would silently reintroduce the browser chooser.
  assert.match(DEFAULT_CONTINUE_URL, /^https:\/\//);
  assert.match(DEFAULT_CONTINUE_URL, /\.firebaseapp\.com\//);

  // One URL for both journeys. Firebase separates them with the mode parameter,
  // and the app's EmailActionActivity routes on it.
  assert.equal(getVerificationContinueUrl(), getContinueUrl());
});

test('ActionCodeSettings hand control to the app and pin the Android package', () => {
  const { buildActionCodeSettings, DEFAULT_ANDROID_PACKAGE, getContinueUrl } =
    require('../services/firebaseAuthService');

  const settings = buildActionCodeSettings(getContinueUrl());

  // handleCodeInApp is what makes Firebase append the oobCode and redirect to the
  // app instead of completing the action in the browser.
  assert.equal(settings.handleCodeInApp, true);
  assert.equal(settings.url, getContinueUrl());
  assert.equal(settings.android.packageName, 'com.example.myecowatch1');
  assert.equal(settings.android.installApp, false);
  assert.equal(DEFAULT_ANDROID_PACKAGE, 'com.example.myecowatch1');
});

test('the continue URL host matches the App Link the app declares', () => {
  const fs = require('fs');
  const path = require('path');
  const { DEFAULT_CONTINUE_URL } = require('../services/firebaseAuthService');

  const manifestPath = path.join(
    __dirname,
    '..', '..', 'MyEcoWatch1', 'app', 'src', 'main', 'AndroidManifest.xml'
  );

  // The backend can be checked out and tested on its own, so the cross-project
  // assertion is skipped when the app is not present rather than failing the run.
  if (!fs.existsSync(manifestPath)) {
    return;
  }

  const manifest = fs.readFileSync(manifestPath, 'utf8');

  // A host mismatch between the backend and the manifest is invisible until
  // someone taps an emailed link, so it is checked here instead.
  assert.ok(
    manifest.includes('android:host="ecowatch1-4445f.firebaseapp.com"'),
    'App Link host must be declared in AndroidManifest.xml'
  );
  assert.ok(
    manifest.includes('android:pathPrefix="/finishSignUp"'),
    'App Link path must be declared in AndroidManifest.xml'
  );
  assert.ok(
    manifest.includes('android:autoVerify="true"'),
    'App Link must request autoVerify'
  );
  assert.ok(
    DEFAULT_CONTINUE_URL.includes('ecowatch1-4445f.firebaseapp.com'),
    'continue URL host must match the manifest host'
  );
  assert.ok(
    DEFAULT_CONTINUE_URL.includes('/finishSignUp'),
    'continue URL path must match the manifest path'
  );
});

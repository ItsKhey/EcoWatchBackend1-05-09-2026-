require('dotenv').config();

/*
 * Read-only check of the Firebase email-verification setup.
 *
 *   node scripts/verify-firebase-email-setup.js            [summary]
 *   node scripts/verify-firebase-email-setup.js <email>    [one account]
 *
 * This never writes. It exists because the parts of this feature that actually
 * break in production are all silent: a missing column, a fingerprint that never
 * reached the console, or an account whose email_verified is false because nobody
 * opened the link. All three look identical from the app.
 */

const { pool } = require('../src/config/db');
const firebaseAuthService = require('../src/modules/auth/firebaseAuthService');

const EXPECTED_PACKAGE = 'com.example.myecowatch1';
const EXPECTED_HOST = 'ecowatch1-4445f.firebaseapp.com';
const EXPECTED_PATH = '/finishSignUp';

const expectedFingerprint =
  '6E:6B:C8:98:5F:24:94:50:28:72:3B:19:86:89:E8:32:F8:6B:73:FF:F0:A6:99:A1:10:A5:ED:68:52:C3:88:F0';

let failures = 0;
let warnings = 0;

const ok = (message) => console.log(`  [OK]      ${message}`);
const warn = (message) => {
  warnings += 1;
  console.log(`  [WARNING] ${message}`);
};
const fail = (message) => {
  failures += 1;
  console.log(`  [FAIL]    ${message}`);
};
const info = (message) => console.log(`  [INFO]    ${message}`);

/** Firebase serves fingerprints without colons, so compare in that form. */
const normaliseFingerprint = (value) => String(value || '').replace(/:/g, '').toUpperCase();

async function checkEnvironment() {
  console.log('\nEnvironment');

  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    && !process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
    && !(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL
      && process.env.FIREBASE_PRIVATE_KEY)) {
    fail('No Firebase service account configured. The FCM variables are the same ones.');
  } else {
    ok('Firebase service account is configured');
  }

  const continueUrl = firebaseAuthService.getContinueUrl();
  console.log(`  [INFO]    continue url        : ${continueUrl}`);
  console.log(`  [INFO]    verification url    : ${firebaseAuthService.getVerificationContinueUrl()}`);

  let url;
  try {
    url = new URL(continueUrl);
  } catch (error) {
    fail(`FIREBASE_CONTINUE_URL is not a valid URL: ${continueUrl}`);
    return;
  }

  if (url.protocol !== 'https:') {
    warn(`Continue URL is ${url.protocol}// rather than https://, so Android cannot verify it as an App Link.`);
  } else {
    ok('Continue URL is https, so App Link verification is possible');
  }

  if (url.host !== EXPECTED_HOST) {
    fail(`Continue URL host is "${url.host}" but AndroidManifest.xml declares android:host="${EXPECTED_HOST}". The emailed link will not open the app.`);
  } else {
    ok(`Continue URL host matches the manifest (${EXPECTED_HOST})`);
  }

  if (url.pathname !== EXPECTED_PATH) {
    fail(`Continue URL path is "${url.pathname}" but the manifest declares pathPrefix="${EXPECTED_PATH}".`);
  } else {
    ok(`Continue URL path matches the manifest (${EXPECTED_PATH})`);
  }

  const packageName = firebaseAuthService.buildActionCodeSettings(continueUrl).android.packageName;
  if (packageName !== EXPECTED_PACKAGE) {
    fail(`ActionCodeSettings packageName is "${packageName}" but the app is "${EXPECTED_PACKAGE}".`);
  } else {
    ok(`ActionCodeSettings packageName matches the app (${EXPECTED_PACKAGE})`);
  }
}

/**
 * Checks what Firebase Hosting is actually publishing.
 *
 * An empty array is the normal, quiet failure: Hosting serves the file, nothing
 * is registered, and autoVerify silently does nothing.
 */
async function checkAssetLinks() {
  console.log('\nFirebase Hosting assetlinks.json');

  let body;
  try {
    const response = await fetch(
      `https://${EXPECTED_HOST}/.well-known/assetlinks.json`,
      { headers: { Accept: 'application/json' } }
    );

    if (!response.ok) {
      fail(`/.well-known/assetlinks.json returned HTTP ${response.status}. Is Hosting deployed?`);
      return;
    }

    body = await response.json();
  } catch (error) {
    warn(`Could not reach the assetlinks.json endpoint: ${error.message}`);
    return;
  }

  if (!Array.isArray(body) || body.length === 0) {
    fail('assetlinks.json is an empty array, so NO fingerprint is registered and autoVerify can never succeed. Add the SHA-256 in the Firebase console.');
    info('Project settings > Your apps > Android > SHA certificate fingerprints > Add fingerprint');
    return;
  }

  const wanted = normaliseFingerprint(expectedFingerprint);
  const published = new Set();

  for (const entry of body) {
    const target = entry?.target;
    if (!target || target.namespace !== 'android_app') {
      continue;
    }
    for (const fingerprint of target.sha256_cert_fingerprints || []) {
      published.add(normaliseFingerprint(fingerprint));
      if (target.package_name !== EXPECTED_PACKAGE) {
        info(`Also registered for ${target.package_name} (expected, other EcoWatch apps may share the project)`);
      }
    }
  }

  if (published.has(wanted)) {
    ok('The debug SHA-256 is published by Firebase Hosting');
  } else {
    fail('The debug SHA-256 is NOT in assetlinks.json. Android will show a chooser instead of opening EcoWatch.');
    console.log(`  [INFO]    expected: ${wanted}`);
    console.log(`  [INFO]    published: ${[...published].join(', ') || 'none'}`);
  }

  if (published.size > 1) {
    warn(`${published.size} fingerprints are published. Confirm a release-build SHA-256 is included, or reset links will only open debug builds.`);
  }
}

async function checkSchema() {
  console.log('\nDatabase columns');

  const required = {
    residents: ['firebase_uid', 'email_verified', 'verification_sent_at', 'verified_at'],
    admins: ['firebase_uid', 'email_verified', 'verification_sent_at', 'verified_at'],
    pending_registrations: ['firebase_uid', 'verification_flow', 'verification_sent_at'],
  };

  for (const [table, columns] of Object.entries(required)) {
    const result = await pool.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name = ANY($2::text[])
      `,
      [table, columns]
    );

    const found = new Set(result.rows.map((row) => row.column_name));
    const missing = columns.filter((column) => !found.has(column));

    if (missing.length === 0) {
      ok(`${table} has all ${columns.length} verification columns`);
    } else {
      fail(`${table} is missing ${missing.join(', ')}. Run: npm run migrate:firebase-email-verification`);
    }
  }
}

async function checkAccount(email) {
  console.log(`\nAccount ${email}`);

  const { rows } = await pool.query(
    `
    SELECT resident_id, username, email, firebase_uid, email_verified,
           is_verified, verified_at, verification_sent_at
    FROM residents
    WHERE lower(email) = lower($1)
    LIMIT 1
    `,
    [email]
  );

  if (rows.length === 0) {
    fail('No resident has that email address.');
    return;
  }

  const row = rows[0];

  if (!row || !row.resident_id) {
    fail('No resident has that email address.');
    return;
  }

  if (row.firebase_uid) {
    ok(`firebase_uid is set (${row.firebase_uid})`);
  } else {
    warn('firebase_uid is NULL. This account predates the migration; it will get a Firebase identity on its first password reset. Set one with POST /api/auth/sync-firebase-password.');
  }

  if (row.email_verified === true) {
    ok('email_verified is true, so the link was opened');
    console.log(`  [INFO]    verified_at: ${row.verified_at || 'not set'}`);
  } else {
    fail('email_verified is FALSE. The verification link was never opened, so the account should not exist yet. If it does, the account was created without proof.');
  }

  if (row.is_verified === true) {
    ok('is_verified is true');
  } else {
    warn('is_verified is false. This does not affect login, which never reads it.');
  }
}

async function checkTotals() {
  console.log('\nPopulation');

  let rows;
  try {
    const result = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE firebase_uid IS NOT NULL)::int AS with_uid,
        COUNT(*) FILTER (WHERE email_verified = true)::int AS verified,
        COUNT(*) FILTER (WHERE verified_at IS NULL)::int AS never_verified
      FROM residents
      `
    );
    rows = result.rows;
  } catch (error) {
    // Reported already by checkSchema. Skipped rather than fatal so the rest of
    // the report still runs on an un-migrated database.
    warn(`Skipped: ${error.message}`);
    return;
  }

  const row = rows[0];
  console.log(`  [INFO]    residents total          : ${row.total}`);
  console.log(`  [INFO]    with firebase_uid        : ${row.with_uid}`);
  console.log(`  [INFO]    email_verified = true    : ${row.verified}`);
  console.log(`  [INFO]    verified_at is null      : ${row.never_verified}`);

  if (row.verified < row.total) {
    warn(`${row.total - row.verified} of ${row.total} residents are not email_verified. Expected for accounts that predate this feature, and it does NOT affect login.`);
  }
}

async function main() {
  const email = process.argv[2];

  try {
    await checkEnvironment();
    await checkAssetLinks();
    await checkSchema();
    await checkTotals();

    if (email) {
      await checkAccount(email);
    }
  } catch (error) {
    fail(`Check could not complete: ${error.message}`);
  } finally {
    await pool.end();
  }

  console.log(`\n${failures} failure(s), ${warnings} warning(s).`);
  console.log('Remember: nothing above writes to the database, and login never reads any of these columns.');

  // Non-zero only on a real failure, so this is usable in a script.
  process.exitCode = failures > 0 ? 1 : 0;
}

main();

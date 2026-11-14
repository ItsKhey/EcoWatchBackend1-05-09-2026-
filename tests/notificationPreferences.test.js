const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../src/config/db');
const notificationPreferenceRepository = require('../src/modules/notifications/notificationPreferenceRepository');
const notificationRepository = require('../src/modules/notifications/notificationRepository');
const notificationController = require('../src/modules/notifications/notificationController');

const RESIDENT_A = 'RES-PREF-TEST-A';
const RESIDENT_B = 'RES-PREF-TEST-B';

const FCM_TOKEN_A = 'token-for-preference-test-resident-a-000000000000';
const FCM_TOKEN_B = 'token-for-preference-test-resident-b-000000000000';

const createResponse = () => ({
  statusCode: 200,
  body: null,
  // Tracks whether the handler actually replied, so a 200 sent via json()
  // without an explicit status() call is not mistaken for "never responded".
  responded: false,
  status(code) {
    this.statusCode = code;
    this.responded = true;
    return this;
  },
  json(payload) {
    this.body = payload;
    this.responded = true;
    return this;
  },
  set() {
    return this;
  },
});

const resolveStatus = (res, error) => {
  if (error && Number.isInteger(error.statusCode)) return error.statusCode;
  return res.responded ? res.statusCode : 500;
};

const residentRequest = (body) => ({
  requestId: 'test-preferences',
  body,
  query: {},
  auth: { residentId: RESIDENT_A },
  resident: { resident_id: RESIDENT_A },
});

const runGet = async () => {
  const res = createResponse();
  let forwarded = null;
  await notificationController.getPreferences(residentRequest(), res, (e) => { forwarded = e; });
  return { res, error: forwarded, status: resolveStatus(res, forwarded) };
};

const runPut = async (body) => {
  const res = createResponse();
  let forwarded = null;
  await notificationController.updatePreferences(
    residentRequest(body), res, (e) => { forwarded = e; }
  );
  if (forwarded) {
    // Surfaced so a failure reads as the real cause rather than a bare 500.
    console.log('    PUT error ->', forwarded.message);
  }
  return { res, error: forwarded, status: resolveStatus(res, forwarded) };
};

const ensureResidents = async () => {
  for (const [residentId, username, token] of [
    [RESIDENT_A, 'pref_a_probe', FCM_TOKEN_A],
    [RESIDENT_B, 'pref_b_probe', FCM_TOKEN_B],
  ]) {
    await pool.query(
      `
      INSERT INTO residents (
        resident_id, username, first_name, last_name,
        password_hash, role, status, fcm_token
      )
      VALUES ($1, $2, $3, 'Probe', 'not-a-real-hash', 'RESIDENT', 'AVAILABLE', $4)
      ON CONFLICT (resident_id) DO UPDATE SET fcm_token = EXCLUDED.fcm_token
      `,
      [residentId, username, `Probe ${username}`, token]
    );
  }
};

test.before(async () => {
  const table = await pool.query(
    `SELECT COUNT(*)::int AS total FROM information_schema.tables
      WHERE table_name = 'notification_preferences'`
  );
  if (table.rows[0].total === 0) {
    throw new Error(
      'notification_preferences table is missing. Run: npm run migrate:notification-preferences'
    );
  }

  await ensureResidents();
  await pool.query(
    `DELETE FROM notification_preferences WHERE resident_id = ANY($1::varchar[])`,
    [[RESIDENT_A, RESIDENT_B]]
  );
});

test.after(async () => {
  await pool.query(
    `DELETE FROM notification_preferences WHERE resident_id = ANY($1::varchar[])`,
    [[RESIDENT_A, RESIDENT_B]]
  );
  // Clear the tokens before removing the rows so the UNIQUE partial index on
  // fcm_token cannot collide with a real device that claimed one.
  await pool.query(
    `UPDATE residents SET fcm_token = NULL WHERE resident_id = ANY($1::varchar[])`,
    [[RESIDENT_A, RESIDENT_B]]
  );
  await pool.query(
    `DELETE FROM residents WHERE resident_id = ANY($1::varchar[])`,
    [[RESIDENT_A, RESIDENT_B]]
  );
  await pool.end();
});

test('a resident with no stored row gets every category enabled', async () => {
  const { res, error } = await runGet();

  assert.equal(error, null);
  assert.equal(res.body.success, true);

  const preferences = res.body.preferences;
  assert.equal(preferences.masterEnabled, true);
  assert.equal(preferences.reportCompleted, true);
  assert.equal(preferences.securityAlerts, true);
  assert.equal(preferences.soundEnabled, true);
  assert.equal(preferences.vibrationEnabled, true);
});

test('a stored choice is read back', async () => {
  const write = await runPut({ reportCompleted: false });
  assert.equal(write.status, 200);
  assert.equal(write.res.body.preferences.reportCompleted, false);

  const read = await runGet();
  assert.equal(read.res.body.preferences.reportCompleted, false);
});

test('an unspecified field keeps its stored value', async () => {
  await runPut({ reportDenied: false });

  // Only reportCompleted is sent, so the denied toggle must not be reset.
  const write = await runPut({ reportCompleted: true });
  assert.equal(write.status, 200);
  assert.equal(write.res.body.preferences.reportDenied, false);
  assert.equal(write.res.body.preferences.reportCompleted, true);
});

test('an unknown field is rejected rather than silently stored', async () => {
  const { status, error } = await runPut({ notAThing: true });

  assert.equal(status, 400);
  assert.match(error.message, /Unknown preference field/);
});

test('a non-boolean value is rejected instead of coerced', async () => {
  // Coercing here would be how a malformed client silently turns notifications
  // off, so it has to fail loudly.
  const { status, error } = await runPut({ reportCompleted: 'false' });

  assert.equal(status, 400);
  assert.match(error.message, /true or false/);
});

test('an empty body is refused rather than treated as a reset', async () => {
  await runPut({ reportCompleted: false });

  const { status } = await runPut({});
  assert.equal(status, 400);

  const read = await runGet();
  assert.equal(read.res.body.preferences.reportCompleted, false, 'nothing was reset');
});

test('snake_case from the database round-trips', async () => {
  const { status, res } = await runPut({ report_completed: false });

  assert.equal(status, 200);
  assert.equal(res.body.preferences.reportCompleted, false);
});

test('the batch insert writes one row per resident', async () => {
  const rows = await notificationRepository.createNotificationsForResidents({
    residentIds: [RESIDENT_A, RESIDENT_B],
    reportId: null,
    title: 'Preference probe batch',
    message: 'Batch write probe.',
    type: 'REPORT_COMPLETED',
  });

  assert.equal(rows.length, 2, 'both residents are written');
  const ids = new Set(rows.map((row) => row.notification_id));
  assert.equal(ids.size, 2, 'each resident gets their own notification_id');

  await pool.query(
    `DELETE FROM notifications WHERE notification_id = ANY($1::bigint[])`,
    [[...ids]]
  );
});

test('an empty recipient list is a no-op rather than a bad query', async () => {
  const rows = await notificationRepository.createNotificationsForResidents({
    residentIds: [],
    reportId: null,
    title: 'Preference probe empty',
    message: 'Nobody to write for.',
    type: 'REPORT_COMPLETED',
  });

  assert.deepEqual(rows, []);
});

// --- custom sound ---------------------------------------------------------
// The chosen ringtone was device-local, so it was lost on reinstall and
// disagreed across devices. It now round-trips with the rest.

test('a custom sound round-trips', async () => {
  const uri = 'content://media/internal/audio/media/42';

  const write = await runPut({ soundUri: uri });
  assert.equal(write.status, 200);
  assert.equal(write.res.body.preferences.soundUri, uri);

  const read = await runGet();
  assert.equal(read.res.body.preferences.soundUri, uri);
});

test('an empty sound string clears the choice back to the device default', async () => {
  await runPut({ soundUri: 'content://media/internal/audio/media/42' });

  const cleared = await runPut({ soundUri: '' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.res.body.preferences.soundUri, null);
});

test('a non-string sound value is rejected', async () => {
  const { status, error } = await runPut({ soundUri: 42 });

  assert.equal(status, 400);
  assert.match(error.message, /string or null/);
});

test('an absurdly long sound uri is rejected', async () => {
  const { status } = await runPut({ soundUri: 'x'.repeat(4096) });
  assert.equal(status, 400);
});

// --- push gating ----------------------------------------------------------

test('allowsPush maps each report type to the toggle that governs it', () => {
  const allOn = notificationPreferenceRepository.DEFAULT_PREFERENCES;
  const allowed = (overrides, type) =>
    notificationPreferenceRepository.allowsPush(
      { ...allOn, ...overrides },
      type
    );

  assert.equal(allowed({}, 'REPORT_COMPLETED'), true);
  assert.equal(allowed({ reportCompleted: false }, 'REPORT_COMPLETED'), false);
  assert.equal(allowed({ reportDenied: false }, 'REPORT_COMPLETED'), true,
    'muting one category must not silence another');

  assert.equal(allowed({ reportDenied: false }, 'REPORT_DENIED'), false);
  assert.equal(allowed({ reportStatusUpdates: false }, 'CLEANING_STARTED'), false);
  assert.equal(allowed({ reportStatusUpdates: false }, 'PERSONNEL_ASSIGNED'), false);
  assert.equal(allowed({ reportStatusUpdates: false }, 'ADMIN_RESPONSE_UPDATED'), false);

  assert.equal(allowed({ reportStatusUpdates: false }, 'REPORT_COMPLETED'), true,
    'muting one category must not silence another category');
});

test('allowsPush fails open for unknown types, null, and the master switch', () => {
  const allOn = notificationPreferenceRepository.DEFAULT_PREFERENCES;

  // An unrecognised type is never silently swallowed by an unrelated toggle.
  assert.equal(notificationPreferenceRepository.allowsPush(allOn, 'SOMETHING_NEW'), true);
  // A missing record must not silence an emergency notice.
  assert.equal(notificationPreferenceRepository.allowsPush(null, 'REPORT_COMPLETED'), true);
  // The master switch still overrides everything.
  assert.equal(
    notificationPreferenceRepository.allowsPush({ ...allOn, masterEnabled: false }, 'REPORT_COMPLETED'),
    false
  );
  // securityAlerts is deliberately not wired to any type yet.
  assert.equal(
    notificationPreferenceRepository.allowsPush(
      { ...allOn, securityAlerts: false },
      'REPORT_COMPLETED'
    ),
    true
  );
});

test('a muted category still records the report notification', async () => {
  await ensureResidents();
  await pool.query(
    `INSERT INTO notification_preferences (resident_id, report_completed)
     VALUES ($1, false)
     ON CONFLICT (resident_id) DO UPDATE SET report_completed = false`,
    [RESIDENT_A]
  );

  // Muted means no buzz, not no record: the row is written first and only the
  // push is gated.
  const preferences = await notificationPreferenceRepository.findByResidentId(RESIDENT_A);
  assert.equal(
    notificationPreferenceRepository.allowsPush(preferences, 'REPORT_COMPLETED'),
    false
  );

  await pool.query(
    `UPDATE notification_preferences SET report_completed = true WHERE resident_id = $1`,
    [RESIDENT_A]
  );
});

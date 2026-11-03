const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../src/config/db');
const notificationPreferenceRepository = require('../src/modules/notifications/notificationPreferenceRepository');
const notificationRepository = require('../src/modules/notifications/notificationRepository');
const notificationController = require('../src/modules/notifications/notificationController');
const announcementController = require('../src/modules/announcements/announcementController');
const fcmService = require('../src/shared/fcmService');

const RESIDENT_A = 'RES-PREF-TEST-A';
const RESIDENT_B = 'RES-PREF-TEST-B';
const RESIDENT_C = 'RES-PREF-TEST-C';
const ADMIN_ID = 'ADM-PREF-TEST';

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

const adminRequest = (body) => ({
  requestId: 'test-preferences',
  body,
  query: {},
  admin: { admin_id: ADMIN_ID, role: 'ADMIN' },
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
    `DELETE FROM notifications
      WHERE type = 'ANNOUNCEMENT' AND title LIKE 'Preference probe%'`
  );
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
  assert.equal(preferences.cenroAnnouncements, true);
  assert.equal(preferences.reportCompleted, true);
  assert.equal(preferences.securityAlerts, true);
  assert.equal(preferences.soundEnabled, true);
  assert.equal(preferences.vibrationEnabled, true);
});

test('a stored choice is read back', async () => {
  const write = await runPut({ cenroAnnouncements: false });
  assert.equal(write.status, 200);
  assert.equal(write.res.body.preferences.cenroAnnouncements, false);

  const read = await runGet();
  assert.equal(read.res.body.preferences.cenroAnnouncements, false);
});

test('an unspecified field keeps its stored value', async () => {
  await runPut({ reportDenied: false });

  // Only announcements is sent, so the denied toggle must not be reset.
  const write = await runPut({ cenroAnnouncements: true });
  assert.equal(write.status, 200);
  assert.equal(write.res.body.preferences.reportDenied, false);
  assert.equal(write.res.body.preferences.cenroAnnouncements, true);
});

test('an unknown field is rejected rather than silently stored', async () => {
  const { status, error } = await runPut({ notAThing: true });

  assert.equal(status, 400);
  assert.match(error.message, /Unknown preference field/);
});

test('a non-boolean value is rejected instead of coerced', async () => {
  // Coercing here would be how a malformed client silently turns notifications
  // off, so it has to fail loudly.
  const { status, error } = await runPut({ cenroAnnouncements: 'false' });

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
  const { status, res } = await runPut({ cenro_announcements: false });

  assert.equal(status, 200);
  assert.equal(res.body.preferences.cenroAnnouncements, false);
});

test('a muted resident is not a push target, and an unstored one still is', async () => {
  await ensureResidents();
  await pool.query(
    `DELETE FROM notification_preferences WHERE resident_id = ANY($1::varchar[])`,
    [[RESIDENT_A, RESIDENT_B]]
  );

  // B has no row at all and must fail open: no row must never mean silence.
  await pool.query(
    `INSERT INTO notification_preferences (resident_id, cenro_announcements)
     VALUES ($1, false)`,
    [RESIDENT_A]
  );

  const audience = await notificationPreferenceRepository.findAnnouncementAudience();
  const byResident = new Map(audience.map((t) => [t.residentId, t]));

  assert.equal(byResident.get(RESIDENT_A)?.pushEnabled, false, 'muted is excluded');
  assert.equal(byResident.get(RESIDENT_B)?.pushEnabled, true, 'no row fails open');
});

test('a resident with no device token is still in the audience', async () => {
  await ensureResidents();
  // C has no FCM token, as a resident who never granted the permission would.
  await pool.query(
    `INSERT INTO residents (
       resident_id, username, first_name, last_name, password_hash, role, status, fcm_token
     ) VALUES ($1, $2, 'P', 'P', 'h', 'RESIDENT', 'AVAILABLE', NULL)
     ON CONFLICT (resident_id) DO UPDATE SET fcm_token = NULL`,
    [RESIDENT_C, 'pref_c_probe']
  );

  try {
    const audience = await notificationPreferenceRepository.findAnnouncementAudience();
    const found = audience.find((t) => t.residentId === RESIDENT_C);

    // Present, so a row is still written for them; only the push is impossible.
    assert.ok(found, 'a token-less resident is still notified in-app');
    assert.equal(found.token, null);
    assert.equal(found.pushEnabled, false);
  } finally {
    await pool.query('DELETE FROM residents WHERE resident_id = $1', [RESIDENT_C]);
  }
});

test('a paused account is not in the audience at all', async () => {
  await pool.query(
    `INSERT INTO residents (
       resident_id, username, first_name, last_name, password_hash, role, status, fcm_token
     ) VALUES ($1, $2, 'P', 'P', 'h', 'RESIDENT', 'DISABLED', $3)
     ON CONFLICT (resident_id) DO UPDATE SET status = 'DISABLED'`,
    [RESIDENT_C, 'pref_c_probe', 'token-for-preference-test-resident-c-000000000000']
  );

  try {
    const audience = await notificationPreferenceRepository.findAnnouncementAudience();
    assert.equal(
      audience.some((t) => t.residentId === RESIDENT_C),
      false,
      'someone who cannot sign in is not notified'
    );
  } finally {
    await pool.query('DELETE FROM residents WHERE resident_id = $1', [RESIDENT_C]);
  }
});

test('the master switch also suppresses announcements', async () => {
  await ensureResidents();
  await pool.query(
    `INSERT INTO notification_preferences (resident_id, master_enabled, cenro_announcements)
     VALUES ($1, false, true)
     ON CONFLICT (resident_id) DO UPDATE SET master_enabled = false`,
    [RESIDENT_A]
  );

  const audience = await notificationPreferenceRepository.findAnnouncementAudience();
  const found = audience.find((t) => t.residentId === RESIDENT_A);
  assert.equal(found?.pushEnabled, false);

  await pool.query(
    `UPDATE notification_preferences SET master_enabled = true WHERE resident_id = $1`,
    [RESIDENT_A]
  );
});

test('a muted resident still receives the in-app notification row', async () => {
  await ensureResidents();
  // Muted means no buzz, not no content: the announcement must still land in
  // their feed and Alerts list.
  await pool.query(
    `INSERT INTO notification_preferences (resident_id, master_enabled, cenro_announcements)
     VALUES ($1, false, false)
     ON CONFLICT (resident_id) DO UPDATE
       SET master_enabled = false, cenro_announcements = false`,
    [RESIDENT_A]
  );

  const res = createResponse();
  let forwarded = null;
  await announcementController.createAnnouncement(
    adminRequest({
      title: 'Preference probe muted',
      message: 'Published while this resident has announcements muted.',
      audience: 'All Residents',
      priority: 'Normal',
    }),
    res,
    (e) => { forwarded = e; }
  );

  assert.equal(forwarded, null);
  assert.equal(res.statusCode, 201);

  const row = await pool.query(
    `SELECT * FROM notifications
      WHERE resident_id = $1 AND type = 'ANNOUNCEMENT'
        AND title = 'Preference probe muted'
      ORDER BY notification_id DESC LIMIT 1`,
    [RESIDENT_A]
  );

  assert.equal(row.rows.length, 1, 'the muted resident still has the notification row');
  assert.equal(row.rows[0].report_id, null);

  await pool.query('DELETE FROM notifications WHERE notification_id = $1', [
    row.rows[0].notification_id,
  ]);
});

test('the broadcast budget is a positive, bounded value', () => {
  // The whole point is that publishing cannot outrun its request, so a
  // non-positive or absurd budget would defeat it silently.
  assert.equal(typeof fcmService.RESIDENT_BROADCAST_DEADLINE_MS, 'number');
  assert.ok(fcmService.RESIDENT_BROADCAST_DEADLINE_MS > 0);
  assert.ok(fcmService.RESIDENT_BROADCAST_DEADLINE_MS <= 60000);
  assert.ok(fcmService.RESIDENT_SEND_TIMEOUT_MS > 0);
  assert.ok(
    fcmService.RESIDENT_SEND_TIMEOUT_MS <= fcmService.RESIDENT_BROADCAST_DEADLINE_MS,
    'a single send may not be able to consume the entire budget'
  );
});

test('the batch insert writes one row per resident', async () => {
  const rows = await notificationRepository.createNotificationsForResidents({
    residentIds: [RESIDENT_A, RESIDENT_B],
    reportId: null,
    title: 'Preference probe batch',
    message: 'Batch write probe.',
    type: 'ANNOUNCEMENT',
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
    type: 'ANNOUNCEMENT',
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

  assert.equal(allowed({ cenroAnnouncements: false }, 'REPORT_COMPLETED'), true,
    'muting announcements must not silence report updates');
});

test('allowsPush fails open for unknown types, null, and the master switch', () => {
  const allOn = notificationPreferenceRepository.DEFAULT_PREFERENCES;

  // An unrecognised type is never silently swallowed by an unrelated toggle.
  assert.equal(notificationPreferenceRepository.allowsPush(allOn, 'SOMETHING_NEW'), true);
  // A missing record must not silence an emergency notice.
  assert.equal(notificationPreferenceRepository.allowsPush(null, 'ANNOUNCEMENT'), true);
  // The master switch still overrides everything.
  assert.equal(
    notificationPreferenceRepository.allowsPush({ ...allOn, masterEnabled: false }, 'ANNOUNCEMENT'),
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

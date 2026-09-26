const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../config/db');
const adminNotificationPreferenceRepository = require('../repositories/adminNotificationPreferenceRepository');
const notificationController = require('../controllers/notificationController');
const announcementController = require('../controllers/announcementController');
const announcementRepository = require('../repositories/announcementRepository');

const ADMIN_ID = 'ADM-PREF-TEST';
const ADMIN_ALT = 'ADM-PREF-TEST-ALT';

const FCM_TOKEN = 'token-for-admin-preference-test-000000000000';
const FCM_TOKEN_ALT = 'token-for-admin-preference-test-alt-0000000000';

const createResponse = () => ({
  statusCode: 200,
  body: null,
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

const adminRequest = (body) => ({
  requestId: 'test-admin-preferences',
  body,
  query: {},
  admin: { admin_id: ADMIN_ID, role: 'ADMIN' },
});

const runGet = async () => {
  const res = createResponse();
  let forwarded = null;
  await notificationController.getAdminPreferences(adminRequest(), res, (e) => { forwarded = e; });
  return { res, error: forwarded, status: resolveStatus(res, forwarded) };
};

const runPut = async (body) => {
  const res = createResponse();
  let forwarded = null;
  await notificationController.updateAdminPreferences(
    adminRequest(body), res, (e) => { forwarded = e; }
  );
  return { res, error: forwarded, status: resolveStatus(res, forwarded) };
};

const runDelete = async (announcementId) => {
  const res = createResponse();
  let forwarded = null;
  await announcementController.deleteAnnouncement(
    {
      requestId: 'test-announcement-delete',
      params: { announcementId },
      admin: { admin_id: ADMIN_ID, role: 'ADMIN' },
    },
    res,
    (e) => { forwarded = e; }
  );
  return { res, error: forwarded, status: resolveStatus(res, forwarded) };
};

const ensureAdmins = async () => {
  for (const [adminId, username, token] of [
    [ADMIN_ID, 'adm_pref_probe', FCM_TOKEN],
    [ADMIN_ALT, 'adm_pref_alt_probe', FCM_TOKEN_ALT],
  ]) {
    await pool.query(
      `
      INSERT INTO admins (admin_id, username, first_name, last_name, password_hash, role, fcm_token)
      VALUES ($1, $2, 'Probe', 'Probe', 'not-a-real-hash', 'ADMIN', $3)
      ON CONFLICT (admin_id) DO UPDATE SET fcm_token = EXCLUDED.fcm_token
      `,
      [adminId, username, token]
    );
  }
};

test.before(async () => {
  const table = await pool.query(
    `SELECT COUNT(*)::int AS total FROM information_schema.tables
      WHERE table_name = 'admin_notification_preferences'`
  );
  if (table.rows[0].total === 0) {
    throw new Error(
      'admin_notification_preferences is missing. Run: npm run migrate:notification-preferences-followup'
    );
  }

  await ensureAdmins();
  await pool.query(
    `DELETE FROM admin_notification_preferences WHERE admin_id = ANY($1::varchar[])`,
    [[ADMIN_ID, ADMIN_ALT]]
  );
});

test.after(async () => {
  await pool.query(
    `DELETE FROM announcements WHERE created_by_admin_id = $1`,
    [ADMIN_ID]
  );
  await pool.query(
    `DELETE FROM admin_notification_preferences WHERE admin_id = ANY($1::varchar[])`,
    [[ADMIN_ID, ADMIN_ALT]]
  );
  await pool.query(
    `UPDATE admins SET fcm_token = NULL WHERE admin_id = ANY($1::varchar[])`,
    [[ADMIN_ID, ADMIN_ALT]]
  );
  await pool.query(
    `DELETE FROM admins WHERE admin_id = ANY($1::varchar[])`,
    [[ADMIN_ID, ADMIN_ALT]]
  );
  await pool.end();
});

test('an administrator with no stored row gets everything enabled', async () => {
  const { res, error } = await runGet();

  assert.equal(error, null);
  assert.equal(res.body.success, true);
  assert.equal(res.body.preferences.masterEnabled, true);
  assert.equal(res.body.preferences.highPriorityReports, true);
  assert.equal(res.body.preferences.personnelAccepted, true);
});

test('an administrator choice is written and read back', async () => {
  const write = await runPut({ highPriorityReports: false });
  assert.equal(write.status, 200);
  assert.equal(write.res.body.preferences.highPriorityReports, false);

  const read = await runGet();
  assert.equal(read.res.body.preferences.highPriorityReports, false);
});

test('an unspecified admin field keeps its stored value', async () => {
  await runPut({ personnelAccepted: false });

  const write = await runPut({ highPriorityReports: true });
  assert.equal(write.res.body.preferences.personnelAccepted, false);
});

test('an unknown admin field is rejected', async () => {
  const { status, error } = await runPut({ notAThing: true });
  assert.equal(status, 400);
  assert.match(error.message, /Unknown preference field/);
});

test('a non-boolean admin value is rejected rather than coerced', async () => {
  const { status } = await runPut({ highPriorityReports: 'false' });
  assert.equal(status, 400);
});

test('an admin custom sound round-trips', async () => {
  const uri = 'content://media/internal/audio/media/7';

  const write = await runPut({ soundUri: uri });
  assert.equal(write.status, 200);
  assert.equal(write.res.body.preferences.soundUri, uri);

  const read = await runGet();
  assert.equal(read.res.body.preferences.soundUri, uri);
});

test('admin allowsPush maps the new-report type and fails open otherwise', () => {
  const allOn = adminNotificationPreferenceRepository.DEFAULT_PREFERENCES;
  const allowed = (overrides, type) =>
    adminNotificationPreferenceRepository.allowsPush({ ...allOn, ...overrides }, type);

  assert.equal(allowed({}, 'NEW_REPORT'), true);
  assert.equal(allowed({ highPriorityReports: false }, 'NEW_REPORT'), false);
  assert.equal(allowed({ masterEnabled: false }, 'NEW_REPORT'), false);
  // Unmapped types are not swallowed by an unrelated toggle.
  assert.equal(allowed({ highPriorityReports: false }, 'SOMETHING_NEW'), true);
  assert.equal(adminNotificationPreferenceRepository.allowsPush(null, 'NEW_REPORT'), true);
});

test('a muted administrator is excluded from the broadcast targets', async () => {
  await ensureAdmins();
  await pool.query(
    `DELETE FROM admin_notification_preferences WHERE admin_id = ANY($1::varchar[])`,
    [[ADMIN_ID, ADMIN_ALT]]
  );
  await pool.query(
    `INSERT INTO admin_notification_preferences (admin_id, high_priority_reports)
     VALUES ($1, false)`,
    [ADMIN_ID]
  );

  const targets = await adminNotificationPreferenceRepository.findBroadcastTargets();
  const byAdmin = new Map(targets.map((t) => [t.adminId, t]));

  assert.equal(byAdmin.get(ADMIN_ID)?.pushEnabled, false, 'muted is excluded');
  assert.equal(byAdmin.get(ADMIN_ALT)?.pushEnabled, true, 'no row fails open');
});

// --- announcement deletion ------------------------------------------------

test('an administrator can permanently delete an announcement', async () => {
  const res = createResponse();
  let forwarded = null;
  await announcementController.createAnnouncement(
    {
      requestId: 'test-delete',
      body: {
        title: 'Delete probe',
        message: 'Published so it can be taken back down.',
        audience: 'All Residents',
        priority: 'Normal',
        // No timer, which is exactly the case that previously had no way out.
        expiresInDays: 0,
      },
      query: {},
      admin: { admin_id: ADMIN_ID, role: 'ADMIN' },
    },
    res,
    (e) => { forwarded = e; }
  );

  assert.equal(forwarded, null);
  const announcementId = res.body.announcement.announcementId;
  assert.ok(announcementRepository.findById(announcementId));

  const removal = await runDelete(announcementId);
  assert.equal(removal.status, 200);
  assert.equal(removal.res.body.deleted, true);

  // Gone at the storage layer, not merely hidden from a read.
  const row = await pool.query('SELECT * FROM announcements WHERE id = $1', [announcementId]);
  assert.equal(row.rows.length, 0);
});

test('deleting an unknown announcement is a 404', async () => {
  const { status, error } = await runDelete('999999999');
  assert.equal(status, 404);
  assert.match(error.message, /not found/i);
});

test('a malformed announcement id is a 400, not a database error', async () => {
  // Without this guard the cast reaches Postgres and surfaces as a 500.
  for (const bad of ['abc', '1;DROP TABLE announcements', '-1', '']) {
    const { status } = await runDelete(bad);
    assert.equal(status, 400, `expected 400 for "${bad}"`);
  }
});

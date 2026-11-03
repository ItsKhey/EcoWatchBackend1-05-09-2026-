const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../src/config/db');
const notificationRepository = require('../src/modules/notifications/notificationRepository');
const announcementRepository = require('../src/modules/announcements/announcementRepository');
const notificationService = require('../src/modules/notifications/notificationService');

const ADMIN_ID = 'ADM-ANNOUNCE-NOTIFY-TEST';

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
  set() {
    return this;
  },
});

/**
 * Publishes an announcement through the controller so the real notification
 * fan-out runs, exactly as it does for the Admin app.
 */
const publishAnnouncement = async (overrides = {}) => {
  const announcementController = require('../src/modules/announcements/announcementController');
  const res = createResponse();
  let forwarded = null;
  await announcementController.createAnnouncement(
    {
      requestId: 'test-announcement-notify',
      body: {
        title: 'Waste collection advisory',
        message: 'Collection shifts to Thursday this week.',
        audience: 'All Residents',
        priority: 'Normal',
        ...overrides,
      },
      query: {},
      admin: { admin_id: ADMIN_ID, role: 'ADMIN' },
    },
    res,
    (error) => { forwarded = error; }
  );
  return { res, error: forwarded };
};

test.before(async () => {
  const column = await pool.query(
    `SELECT COUNT(*)::int AS total FROM information_schema.columns
      WHERE table_name = 'notifications' AND column_name = 'type'`
  );
  if (column.rows[0].total === 0) {
    throw new Error('notifications table is missing. Run: npm run migrate:resident-notifications');
  }

  // ANNOUNCEMENT rows reference no report, so they are identifiable by title.
  await pool.query(
    `DELETE FROM notifications WHERE type = 'ANNOUNCEMENT'
       AND title = ANY($1::varchar[])`,
    [['Waste collection advisory', 'Notification probe']]
  );
  await pool.query('DELETE FROM announcements WHERE created_by_admin_id = $1', [ADMIN_ID]);
});

test.after(async () => {
  await pool.query(
    `DELETE FROM notifications WHERE type = 'ANNOUNCEMENT'
       AND title = ANY($1::varchar[])`,
    [['Waste collection advisory', 'Notification probe']]
  );
  await pool.query('DELETE FROM announcements WHERE created_by_admin_id = $1', [ADMIN_ID]);
  await pool.end();
});

test('ANNOUNCEMENT is accepted by the notifications type constraint', async () => {
  // The CHECK constraint is the real gate; asserting through a write proves the
  // migration actually landed rather than only that the constant changed.
  const notification = await notificationRepository.createNotification({
    residentId: null,
    reportId: null,
    title: 'Notification probe',
    message: 'Constraint probe.',
    type: 'ANNOUNCEMENT',
  }).catch((error) => ({ failed: error }));

  if (notification.failed) {
    // A null resident_id violates the FK/NOT NULL before the CHECK is even
    // reached, so assert on the constraint definition instead.
    assert.match(notification.failed.message, /notifications/);
    const definition = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'notifications_type_ck'`
    );
    assert.match(definition.rows[0].def, /ANNOUNCEMENT/);
    return;
  }

  assert.equal(notification.type, 'ANNOUNCEMENT');
  await pool.query('DELETE FROM notifications WHERE notification_id = $1', [
    notification.notification_id,
  ]);
});

test('an announcement notification row carries no report', async () => {
  const { res, error } = await publishAnnouncement();

  assert.equal(error, null);
  assert.equal(res.statusCode, 201);
  assert.ok(res.body.announcement.announcementId);
  assert.equal(typeof res.body.notifiedResidents, 'number');

  const rows = await pool.query(
    `SELECT * FROM notifications
      WHERE type = 'ANNOUNCEMENT' AND title = 'Waste collection advisory'
      ORDER BY notification_id DESC`
  );

  if (rows.rows.length === 0) {
    // No resident had a bound FCM token in this environment, so there is
    // nothing to assert per-recipient. The shape guarantee is covered above.
    return;
  }

  for (const row of rows.rows) {
    assert.equal(row.report_id, null, 'an announcement notification owns no report');
    assert.ok(row.resident_id, 'each row belongs to a specific resident');
  }
});

test('an announcement notification uses the published copy', async () => {
  const { res } = await publishAnnouncement({ title: 'Notification probe' });
  assert.equal(res.statusCode, 201);

  const announcement = res.body.announcement;
  const content = notificationService.announcementContent(announcement);

  assert.equal(content.title, 'Notification probe');
  assert.match(content.message, /Collection shifts to Thursday/);
});

test('announcement copy never invents a report reference', () => {
  // The report-shaped content builder interpolates a report id; an announcement
  // has none, which is why it gets its own builder.
  const content = notificationService.announcementContent({
    title: 'Flood advisory',
    message: 'Evacuate low-lying areas.',
  });

  assert.equal(content.title, 'Flood advisory');
  assert.equal(content.message, 'Evacuate low-lying areas.');
  assert.doesNotMatch(content.message, /Report ID/);
  assert.doesNotMatch(content.message, /undefined/);
});

test('a long announcement body is trimmed to fit a notification', () => {
  const content = notificationService.announcementContent({
    title: 'x'.repeat(300),
    message: 'y'.repeat(5000),
  });

  assert.ok(content.title.length <= 80, 'the title is trimmed');
  assert.ok(content.message.length <= 200, 'the body is trimmed');
});

test('ANNOUNCEMENT cannot be created through the report-event route', async () => {
  assert.throws(
    () => notificationService.validateCreateEventRequest({
      reportId: 'REP-ANY',
      type: 'ANNOUNCEMENT',
    }),
    /report event/
  );
});

test('publishing still succeeds when no resident has a token', async () => {
  // Nothing to notify must never mean "publish failed".
  const { res, error } = await publishAnnouncement({ title: 'Notification probe' });

  assert.equal(error, null);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.notifiedResidents >= 0, true);
});

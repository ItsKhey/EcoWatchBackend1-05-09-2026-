require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { pool } = require('../src/config/db');
const generateToken = require('../src/shared/generateToken');

/**
 * Exercises the real route stack over a real socket.
 *
 * The controller-level tests prove the logic; these prove the guards. The
 * resident/admin preference split and the delete endpoint are only meaningful
 * if an unauthenticated or wrong-role caller is actually turned away, which a
 * fabricated request object would not demonstrate.
 */
const buildApp = () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/announcements', require('../src/modules/announcements/announcementRoutes'));
  app.use('/api/notifications', require('../src/modules/notifications/notificationRoutes'));
  app.use(require('../src/middleware/errorMiddleware').errorHandler);
  return app;
};

const startServer = (app) =>
  new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

const request = (server, { method, path, token, body }) =>
  new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body === undefined ? null : JSON.stringify(body);

    const options = {
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(payload
          ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }
          : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };

    const req = http.request(options, (response) => {
      let raw = '';
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch (error) {
          parsed = null;
        }
        resolve({ status: response.statusCode, body: parsed });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const RESIDENT_ID = 'RES-ROUTE-PREF-TEST';

let server;
let residentToken;
let adminToken;
/** Resolved from the live table in `before`, since the tests need a real admin. */
let adminId;

test.before(async () => {
  const preferences = await pool.query(
    `SELECT COUNT(*)::int AS total FROM information_schema.tables
      WHERE table_name = 'notification_preferences'`
  );
  if (preferences.rows[0].total === 0) {
    throw new Error(
      'notification_preferences is missing. Run: npm run migrate:notification-preferences'
    );
  }

  await pool.query(
    `INSERT INTO residents (
       resident_id, username, first_name, last_name, password_hash, role, status
     ) VALUES ($1, $2, 'Route', 'Probe', 'not-a-real-hash', 'RESIDENT', 'AVAILABLE')
     ON CONFLICT (resident_id) DO NOTHING`,
    [RESIDENT_ID, 'route_pref_probe']
  );

  const admin = await pool.query(
    `SELECT admin_id FROM admins WHERE lower(trim(COALESCE(role,'ADMIN'))) = 'admin' LIMIT 1`
  );
  adminId = admin.rows[0]?.admin_id || null;
  if (!adminId) throw new Error('no administrator account is available to test with');

  residentToken = generateToken(RESIDENT_ID, { role: 'RESIDENT', resident_id: RESIDENT_ID });
  adminToken = generateToken(adminId, { role: 'ADMIN', admin_id: adminId });

  server = await startServer(buildApp());
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.query(
    'DELETE FROM notification_preferences WHERE resident_id = $1',
    [RESIDENT_ID]
  );
  if (adminId) {
    await pool.query(
      'DELETE FROM admin_notification_preferences WHERE admin_id = $1',
      [adminId]
    );
  }
  await pool.query('DELETE FROM announcements WHERE created_by_admin_id = $1', [adminId]);
  await pool.query('DELETE FROM residents WHERE resident_id = $1', [RESIDENT_ID]);
  await pool.end();
});

// --- resident preferences -------------------------------------------------

test('a resident can read and write their own preferences', async () => {
  const read = await request(server, {
    method: 'GET',
    path: '/api/notifications/preferences',
    token: residentToken,
  });
  assert.equal(read.status, 200);
  assert.equal(read.body.success, true);
  assert.equal(read.body.preferences.masterEnabled, true);

  const write = await request(server, {
    method: 'PUT',
    path: '/api/notifications/preferences',
    token: residentToken,
    body: { cenroAnnouncements: false },
  });
  assert.equal(write.status, 200);
  assert.equal(write.body.preferences.cenroAnnouncements, false);
});

test('resident preferences reject an unauthenticated caller', async () => {
  const read = await request(server, { method: 'GET', path: '/api/notifications/preferences' });
  assert.ok(read.status === 401 || read.status === 403, `got ${read.status}`);
});

test('a non-boolean preference is a 400 over HTTP', async () => {
  const write = await request(server, {
    method: 'PUT',
    path: '/api/notifications/preferences',
    token: residentToken,
    body: { cenroAnnouncements: 'nope' },
  });
  assert.equal(write.status, 400);
});

// --- admin preferences ----------------------------------------------------

test('an administrator can read and write their own preferences', async () => {
  const read = await request(server, {
    method: 'GET',
    path: '/api/notifications/admin-preferences',
    token: adminToken,
  });
  assert.equal(read.status, 200);

  const write = await request(server, {
    method: 'PUT',
    path: '/api/notifications/admin-preferences',
    token: adminToken,
    body: { highPriorityReports: false },
  });
  assert.equal(write.status, 200);
  assert.equal(write.body.preferences.highPriorityReports, false);
});

test('a resident token cannot reach the admin preference endpoints', async () => {
  // The whole reason the two are split: otherwise a resident could mute an
  // administrator's alerts.
  const read = await request(server, {
    method: 'GET',
    path: '/api/notifications/admin-preferences',
    token: residentToken,
  });
  assert.ok(read.status === 401 || read.status === 403, `got ${read.status}`);

  const write = await request(server, {
    method: 'PUT',
    path: '/api/notifications/admin-preferences',
    token: residentToken,
    body: { highPriorityReports: false },
  });
  assert.ok(write.status === 401 || write.status === 403, `got ${write.status}`);
});

test('admin preferences reject an unauthenticated caller', async () => {
  const read = await request(server, {
    method: 'GET',
    path: '/api/notifications/admin-preferences',
  });
  assert.ok(read.status === 401 || read.status === 403, `got ${read.status}`);
});

// --- announcement deletion ------------------------------------------------

const publishOne = async () => {
  const created = await request(server, {
    method: 'POST',
    path: '/api/announcements',
    token: adminToken,
    body: {
      title: 'Route delete probe',
      message: 'Published so the delete route has something to remove.',
      audience: 'All Residents',
      priority: 'Normal',
      expiresInDays: 0,
    },
  });
  assert.equal(created.status, 201);
  return created.body.announcement.announcementId;
};

test('an administrator can permanently delete an announcement over HTTP', async () => {
  const announcementId = await publishOne();

  const removed = await request(server, {
    method: 'DELETE',
    path: `/api/announcements/${announcementId}`,
    token: adminToken,
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, true);

  const row = await pool.query('SELECT * FROM announcements WHERE id = $1', [announcementId]);
  assert.equal(row.rows.length, 0);
});

test('a resident token cannot delete an announcement', async () => {
  const announcementId = await publishOne();

  const removed = await request(server, {
    method: 'DELETE',
    path: `/api/announcements/${announcementId}`,
    token: residentToken,
  });
  assert.ok(removed.status === 401 || removed.status === 403, `got ${removed.status}`);

  // The guard must have actually protected the row.
  const row = await pool.query('SELECT * FROM announcements WHERE id = $1', [announcementId]);
  assert.equal(row.rows.length, 1, 'the announcement survives a resident delete attempt');
});

test('an unauthenticated caller cannot delete an announcement', async () => {
  const announcementId = await publishOne();

  const removed = await request(server, {
    method: 'DELETE',
    path: `/api/announcements/${announcementId}`,
  });
  assert.ok(removed.status === 401 || removed.status === 403, `got ${removed.status}`);

  const row = await pool.query('SELECT * FROM announcements WHERE id = $1', [announcementId]);
  assert.equal(row.rows.length, 1);
});

test('the delete route does not shadow the resident feed route', async () => {
  // ":announcementId" would match "my-announcements" if it were declared first,
  // turning the resident feed into a 400. This pins the ordering.
  const feed = await request(server, {
    method: 'GET',
    path: '/api/announcements/my-announcements',
    token: residentToken,
  });
  assert.equal(feed.status, 200);
  assert.ok(Array.isArray(feed.body.announcements));
});

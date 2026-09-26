require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { pool } = require('../config/db');
const generateToken = require('../utils/generateToken');
const announcementRepository = require('../repositories/announcementRepository');
const announcementController = require('../controllers/announcementController');

const RESIDENT_A = 'RES-DELIVER-A';
const RESIDENT_B = 'RES-DELIVER-B';
const ADMIN_ID = 'ADM-DELIVER';

const seedResident = async (residentId) => {
  await pool.query(
    `INSERT INTO residents (
         resident_id, first_name, last_name, username, email, password_hash,
         role, status, is_verified, address
       )
     VALUES ($1, 'Deliver', 'Tester', $1, $1, 'not-a-real-hash', 'RESIDENT', 'AVAILABLE', true, 'Barangay 7')
     ON CONFLICT (resident_id) DO UPDATE
       SET role = 'RESIDENT', status = 'AVAILABLE', address = 'Barangay 7'`,
    [residentId]
  );
};

const seedAdmin = async () => {
  const result = await pool.query(
    `INSERT INTO admins (
         admin_id, first_name, last_name, username, email, password_hash, role
       )
     VALUES ($1, 'Deliver', 'Admin', $1, $1, 'not-a-real-hash', 'ADMIN')
     ON CONFLICT (admin_id) DO UPDATE SET role = 'ADMIN'
     RETURNING admin_id`,
    [ADMIN_ID]
  );
  return result.rows[0].admin_id;
};

const buildApp = () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/announcements', require('../routes/announcementRoutes'));
  app.use(require('../middleware/errorMiddleware').errorHandler);
  return app;
};

const startServer = (app) =>
  new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

const getAnnouncements = (server, token) =>
  new Promise((resolve, reject) => {
    const { port } = server.address();
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/announcements/my-announcements',
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (response) => {
        let raw = '';
        response.on('data', (chunk) => { raw += chunk; });
        response.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (error) {
            parsed = null;
          }
          resolve({ status: response.statusCode, body: parsed, raw });
        });
      }
    );
    request.on('error', reject);
    request.end();
  });

const postAnnouncement = (server, token, body) =>
  new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/announcements',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${token}`,
        },
      },
      (response) => {
        let raw = '';
        response.on('data', (chunk) => { raw += chunk; });
        response.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (error) {
            parsed = null;
          }
          resolve({ status: response.statusCode, body: parsed, raw });
        });
      }
    );
    request.on('error', reject);
    request.write(payload);
    request.end();
  });

test.before(async () => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total FROM information_schema.tables
      WHERE table_name = 'announcements'`
  );
  if (result.rows[0].total === 0) {
    throw new Error('announcements table is missing. Run: npm run migrate:announcements');
  }
  await cleanup();
});

test.after(async () => {
  await cleanup();
  await pool.end();
});

async function cleanup() {
  await pool.query('DELETE FROM announcements WHERE created_by_admin_id = $1', [ADMIN_ID]);
  await pool.query('DELETE FROM residents WHERE resident_id = ANY($1)', [
    [RESIDENT_A, RESIDENT_B],
  ]);
  await pool.query('DELETE FROM admins WHERE admin_id = $1', [ADMIN_ID]);
}

test('a published announcement reaches the resident feed', async () => {
  await seedResident(RESIDENT_A);
  const adminId = await seedAdmin();

  const app = buildApp();
  const server = await startServer(app);

  try {
    const adminToken = generateToken(adminId, { role: 'ADMIN', admin_id: adminId });
    const published = await postAnnouncement(server, adminToken, {
      title: 'Waste collection schedule',
      message: 'Collection moves to Wednesday this week.',
      audience: 'All Residents',
      priority: 'Important',
    });
    assert.equal(published.status, 201);

    const residentToken = generateToken(RESIDENT_A, {
      role: 'RESIDENT',
      resident_id: RESIDENT_A,
    });
    const feed = await getAnnouncements(server, residentToken);

    assert.equal(feed.status, 200);
    assert.equal(feed.body.success, true);
    assert.ok(Array.isArray(feed.body.announcements));
    assert.ok(feed.body.announcements.length > 0, 'the resident sees the announcement');

    const match = feed.body.announcements.find(
      (entry) => entry.title === 'Waste collection schedule'
    );
    assert.ok(match, 'the published announcement is in the resident feed');
    assert.equal(match.message, 'Collection moves to Wednesday this week.');
    assert.equal(match.priority, 'IMPORTANT');
    assert.equal(match.audience, 'ALL_RESIDENTS');
    assert.ok(match.createdAt, 'the resident feed carries the server timestamp');
  } finally {
    server.close();
  }
});

test('an announcement reaches every resident', async () => {
  await seedResident(RESIDENT_A);
  await seedResident(RESIDENT_B);
  const adminId = await seedAdmin();

  const app = buildApp();
  const server = await startServer(app);

  try {
    const adminToken = generateToken(adminId, { role: 'ADMIN', admin_id: adminId });
    await postAnnouncement(server, adminToken, {
      title: 'City-wide advisory',
      message: 'Everyone should be notified.',
      audience: 'All Residents',
    });

    for (const residentId of [RESIDENT_A, RESIDENT_B]) {
      const token = generateToken(residentId, { role: 'RESIDENT', resident_id: residentId });
      const feed = await getAnnouncements(server, token);
      assert.equal(feed.status, 200);
      const match = feed.body.announcements.find((entry) => entry.title === 'City-wide advisory');
      assert.ok(match, `${residentId} must receive the broadcast`);
    }
  } finally {
    server.close();
  }
});

test('the resident feed is newest first', async () => {
  await seedResident(RESIDENT_A);
  const adminId = await seedAdmin();

  for (const title of ['First notice', 'Second notice', 'Third notice']) {
    await announcementRepository.createAnnouncement({
      title,
      message: 'Body',
      audience: 'ALL_RESIDENTS',
      priority: 'NORMAL',
      createdByAdminId: adminId,
    });
  }

  const feed = await announcementRepository.findForResident(RESIDENT_A, { limit: 20, offset: 0 });
  const titles = feed.map((entry) => entry.title);

  // Assert the relative order of the rows this test created rather than their
  // absolute place in the feed. Every announcement test file inserts into the
  // same table and node runs the files concurrently, so claiming the first slots
  // makes this depend on which other suite happened to be writing at the time.
  const newest = titles.indexOf('Third notice');
  const middle = titles.indexOf('Second notice');
  const oldest = titles.indexOf('First notice');

  assert.ok(newest !== -1, 'the newest notice is in the feed');
  assert.ok(middle !== -1, 'the second notice is in the feed');
  assert.ok(oldest !== -1, 'the oldest notice is in the feed');
  assert.ok(newest < middle, 'the newest notice is listed first');
  assert.ok(middle < oldest, 'the older notice is listed after it');
});

test('an admin cannot read the resident feed', async () => {
  const adminId = await seedAdmin();
  const app = buildApp();
  const server = await startServer(app);

  try {
    const adminToken = generateToken(adminId, { role: 'ADMIN', admin_id: adminId });
    const response = await getAnnouncements(server, adminToken);
    assert.equal(response.status, 403);
  } finally {
    server.close();
  }
});

test('the resident feed requires a session', async () => {
  const app = buildApp();
  const server = await startServer(app);

  try {
    const response = await getAnnouncements(server, null);
    assert.equal(response.status, 401);
  } finally {
    server.close();
  }
});

test('the resident feed clamps hostile paging values', async () => {
  await seedResident(RESIDENT_A);
  const app = buildApp();
  const server = await startServer(app);

  try {
    const token = generateToken(RESIDENT_A, { role: 'RESIDENT', resident_id: RESIDENT_A });
    const { port } = server.address();

    const response = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/announcements/my-announcements?limit=9999&offset=-5',
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        }
      );
      request.on('error', reject);
      request.end();
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.limit, 50);
    assert.equal(response.body.offset, 0);
  } finally {
    server.close();
  }
});

test('a narrowed audience never reaches a resident feed', async () => {
  await seedResident(RESIDENT_A);

  // Written directly to prove the visibility rule, not just the publish guard.
  await pool.query(
    `INSERT INTO announcements (title, message, audience, priority, created_by_admin_id)
     VALUES ('Scoped notice', 'Should not appear.', 'BARANGAY', 'NORMAL', $1)`,
    [ADMIN_ID]
  );
  await pool.query(
    `INSERT INTO announcements (title, message, audience, priority, created_by_admin_id)
     VALUES ('Targeted notice', 'Should not appear.', 'SELECTED_RESIDENTS', 'NORMAL', $1)`,
    [ADMIN_ID]
  );

  const feed = await announcementRepository.findForResident(RESIDENT_A, { limit: 50, offset: 0 });
  const titles = feed.map((entry) => entry.title);

  assert.ok(!titles.includes('Scoped notice'));
  assert.ok(!titles.includes('Targeted notice'));
});

test('the module surface stays stable', () => {
  assert.equal(typeof announcementController.getMyAnnouncements, 'function');
  assert.equal(typeof announcementRepository.findForResident, 'function');
});

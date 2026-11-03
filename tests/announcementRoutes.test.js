require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { pool } = require('../src/config/db');
const generateToken = require('../src/shared/generateToken');
const announcementController = require('../src/modules/announcements/announcementController');
const { protect, protectResident } = require('../src/middleware/authMiddleware');
const { admin } = require('../src/middleware/adminMiddleware');

/**
 * Exercises the real route stack over a real socket, so the admin-only guard
 * is proven for a genuine resident token and not just for a fabricated
 * request object.
 */
const buildApp = () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  // The real stack mounts the error handler last; without it every thrown
  // error would surface as an HTML stack page and the status codes would be
  // unobservable.
  app.use('/api/announcements', require('../src/modules/announcements/announcementRoutes'));
  app.use(require('../src/middleware/errorMiddleware').errorHandler);
  return app;
};

const startServer = (app) =>
  new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
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
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

const validAnnouncement = {
  title: 'Route level announcement',
  message: 'Sent through the real route stack.',
  audience: 'All Residents',
  priority: 'Normal',
};

test('the announcement route requires authentication', async () => {
  const app = buildApp();
  const server = await startServer(app);

  try {
    const response = await postAnnouncement(server, null, validAnnouncement);
    assert.equal(response.status, 401);
  } finally {
    server.close();
  }
});

/** Seeds a real admin row so a genuine admin JWT resolves through protect(). */
const seedAdmin = async (adminId) => {
  const result = await pool.query(
    `INSERT INTO admins (
         admin_id, first_name, last_name, username, email, password_hash, role
       )
     VALUES ($1, 'Route', 'Admin', $1, $1, 'not-a-real-hash', 'ADMIN')
     ON CONFLICT (admin_id) DO UPDATE SET role = 'ADMIN'
     RETURNING admin_id`,
    [adminId]
  );
  return result;
};

const removeAdmin = async (adminId) => {
  await pool.query('DELETE FROM admins WHERE admin_id = $1', [adminId]);
};

test('a resident token cannot publish an announcement', async () => {
  const residentId = 'RES-ROUTE-TEST';
  const adminId = 'ADM-ROUTE-TEST';

  const resident = await pool.query(
    `INSERT INTO residents (
         resident_id, first_name, last_name, username, email, password_hash,
         role, status, is_verified
       )
     VALUES ($1, 'Route', 'Tester', $1, $1, 'not-a-real-hash', 'RESIDENT', 'AVAILABLE', true)
     ON CONFLICT (resident_id) DO UPDATE SET role = 'RESIDENT', status = 'AVAILABLE'
     RETURNING resident_id`,
    [residentId]
  );
  const adminRow = await seedAdmin(adminId);

  const app = buildApp();
  const server = await startServer(app);

  try {
    // pg returns the snake_case column name, not the camelCase alias.
    const residentToken = generateToken(resident.rows[0].resident_id, {
      role: 'RESIDENT',
      resident_id: residentId,
    });
    const residentResponse = await postAnnouncement(server, residentToken, validAnnouncement);
    assert.equal(residentResponse.status, 403);

    // The same payload must succeed for a real admin token, which proves the
    // 403 above came from the role guard rather than from a broken request.
    const adminToken = generateToken(adminRow.rows[0].admin_id, { role: 'ADMIN', admin_id: adminId });
    const adminResponse = await postAnnouncement(server, adminToken, validAnnouncement);

    assert.equal(adminResponse.status, 201);
    assert.equal(adminResponse.body.announcement.createdByAdminId, adminId);
  } finally {
    server.close();
    await pool.query('DELETE FROM announcements WHERE created_by_admin_id = $1', [adminId]);
    await pool.query('DELETE FROM residents WHERE resident_id = $1', [residentId]);
    await removeAdmin(adminId);
  }
});

test('the route rejects an invalid announcement payload', async () => {
  const adminId = 'ADM-ROUTE-TEST-2';
  const adminRow = await seedAdmin(adminId);

  const app = buildApp();
  const server = await startServer(app);

  try {
    const adminToken = generateToken(adminRow.rows[0].admin_id, { role: 'ADMIN', admin_id: adminId });

    const missingMessage = await postAnnouncement(server, adminToken, {
      title: 'No body',
      audience: 'All Residents',
    });
    assert.equal(missingMessage.status, 400);
    assert.match(missingMessage.body.message, /message is required/i);

    const futureAudience = await postAnnouncement(server, adminToken, {
      title: 'Scoped',
      message: 'Should be refused.',
      audience: 'Specific Barangay',
    });
    assert.equal(futureAudience.status, 400);
  } finally {
    server.close();
    await pool.query('DELETE FROM announcements WHERE created_by_admin_id = $1', [adminId]);
    await removeAdmin(adminId);
  }
});

test('the module surface stays stable', () => {
  assert.equal(typeof announcementController.createAnnouncement, 'function');
  assert.equal(typeof announcementController.listAnnouncements, 'function');
  assert.equal(typeof protect, 'function');
  assert.equal(typeof protectResident, 'function');
  assert.equal(typeof admin, 'function');
});

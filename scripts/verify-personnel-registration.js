require('dotenv').config();

const assert = require('assert');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

(async () => {
const root = require('path').resolve(__dirname, '..');
const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const pool = new Pool({
  connectionString: process.env.SUPABASE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let serverProcess;
let personnelId;

const cleanup = async () => {
  if (personnelId) {
    const result = await pool.query(
      'DELETE FROM personnel_accounts WHERE personnel_id = $1 RETURNING personnel_id',
      [personnelId]
    );
    assert.strictEqual(result.rowCount, 1, 'Temporary personnel account was not cleaned up');
    personnelId = undefined;
  }
};

const stopServer = () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
  }
};

try {
  assert(process.env.SUPABASE_DATABASE_URL, 'SUPABASE_DATABASE_URL is required');
  assert(process.env.JWT_SECRET, 'JWT_SECRET is required');

  const adminResult = await pool.query(
    `SELECT admin_id, role
     FROM admins
     WHERE role = 'ADMIN'
     ORDER BY created_at ASC
     LIMIT 1`
  );
  assert(adminResult.rowCount > 0, 'An existing admin account is required for the protected route test');

  const adminId = adminResult.rows[0].admin_id;
  assert.strictEqual(adminResult.rows[0].role, 'ADMIN', 'Selected account is not an ADMIN');
  const adminToken = jwt.sign(
    { id: adminId, role: 'ADMIN' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );
  const decodedAdminToken = jwt.verify(adminToken, process.env.JWT_SECRET);
  assert.strictEqual(decodedAdminToken.id, adminId, 'Admin JWT id is incorrect');
  assert.strictEqual(decodedAdminToken.role, 'ADMIN', 'Admin JWT role is incorrect');

  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverError = '';
  serverProcess.stderr.on('data', (chunk) => {
    serverError += chunk.toString();
  });
  serverProcess.on('error', (error) => {
    serverError += error.message;
  });

  await waitForServer(`${baseUrl}/api/health`);
  assert(!serverError, `Server failed to start: ${serverError.slice(0, 500)}`);

  const suffix = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const username = `phase2a_${suffix}`;
  const gmail = `phase2a_${suffix}@gmail.com`;
  const password = `Phase2A!${crypto.randomBytes(12).toString('hex')}`;

  const createResponse = await fetch(`${baseUrl}/api/admin/personnel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      firstName: 'Phase',
      lastName: 'Test',
      address: 'Integration Test Address',
      gmail,
      username,
      password,
      createdByAdminId: 'RES-FORGED',
    }),
  });
  const createBody = await readJson(createResponse);
  assert.strictEqual(createResponse.status, 201, `Create failed: ${JSON.stringify(createBody)}`);
  assert(createBody.personnel?.personnelId, 'Create response did not return personnelId');
  assert(createBody.personnel?.username === username, 'Create response account details are incorrect');
  assert(!JSON.stringify(createBody).includes('password_hash'), 'Create response exposed password_hash');
  personnelId = createBody.personnel.personnelId;

  const storedResult = await pool.query(
    `SELECT personnel_id, password_hash, created_by_admin_id, updated_by_admin_id
     FROM personnel_accounts
     WHERE personnel_id = $1`,
    [personnelId]
  );
  assert.strictEqual(storedResult.rowCount, 1, 'Created personnel row was not found');
  const storedHash = storedResult.rows[0].password_hash;
  assert(typeof storedHash === 'string' && storedHash.length > 0, 'password_hash was NULL or empty');
  assert.notStrictEqual(storedHash, password, 'password_hash contains the plaintext password');
  assert(await bcrypt.compare(password, storedHash), 'Stored password_hash does not match the password');
  assert.strictEqual(
    storedResult.rows[0].created_by_admin_id,
    adminId,
    'created_by_admin_id did not come from the authenticated admin'
  );
  assert.strictEqual(
    storedResult.rows[0].updated_by_admin_id,
    adminId,
    'updated_by_admin_id did not come from the authenticated admin'
  );
  assert(
    /^ADM-/i.test(storedResult.rows[0].created_by_admin_id),
    `created_by_admin_id is not an admin ID: ${storedResult.rows[0].created_by_admin_id}`
  );
  assert(
    /^ADM-/i.test(storedResult.rows[0].updated_by_admin_id),
    `updated_by_admin_id is not an admin ID: ${storedResult.rows[0].updated_by_admin_id}`
  );

  const loginResponse = await fetch(`${baseUrl}/api/personnel/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const loginBody = await readJson(loginResponse);
  assert.strictEqual(loginResponse.status, 200, `Personnel login failed: ${JSON.stringify(loginBody)}`);
  assert(loginBody.token, 'Personnel login did not return a token');
  assert.strictEqual(loginBody.personnel?.personnelId, personnelId, 'Logged-in personnel ID is incorrect');
  assert(!JSON.stringify(loginBody).includes('password_hash'), 'Login response exposed password_hash');

  console.log(`PASS create: ${createResponse.status}`);
  console.log(`PASS generated personnel ID: ${personnelId}`);
  console.log(`PASS admin JWT identity: ${adminId} / ADMIN`);
  console.log(`PASS audit columns: ${adminId} / ${adminId}`);
  console.log('PASS password_hash populated and bcrypt-compatible');
  console.log(`PASS personnel login: ${loginResponse.status}`);
  console.log('PASS response payloads omit password_hash');
} finally {
  try {
    await cleanup();
    if (personnelId === undefined) {
      console.log('PASS temporary test account cleaned up');
    }
  } finally {
    stopServer();
    await pool.end();
  }
}
})().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
});

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const selectedPort = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(selectedPort));
    });
  });
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for the Render-style API server');
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    return { rawResponse: text };
  }
}

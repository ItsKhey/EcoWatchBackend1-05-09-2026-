const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../config/db');
const reportRepository = require('../repositories/reportRepository');
const historyRepository = require('../repositories/historyRepository');
const reportController = require('../controllers/reportController');
const { extractPublicId } = require('../services/cloudinaryService');

const RESIDENT_ID = 'RES-EDIT-TEST';
const OTHER_RESIDENT_ID = 'RES-EDIT-OTHER';

/** Minimal stand-in for the Express response used by the controller. */
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

const createRequest = ({ reportId, residentId, body, file = undefined }) => ({
  requestId: 'test-edit-request',
  params: { id: reportId },
  body: body || {},
  file,
  resident: { residentId, role: 'RESIDENT' },
});

/** Runs the controller and returns the captured response, failing on next(). */
const runUpdate = async (request) => {
  const res = createResponse();
  let forwarded = null;
  await reportController.updateReport(request, res, (error) => {
    forwarded = error;
  });
  if (forwarded) throw forwarded;
  return res;
};

/**
 * Mirrors the status the error middleware will actually send, so the tests
 * assert the HTTP contract rather than an internal bookkeeping detail.
 */
const resolveStatus = (res, error) => {
  if (error && Number.isInteger(error.statusCode)) return error.statusCode;
  return res.statusCode === 200 ? 500 : res.statusCode;
};

const seedResident = (residentId) => pool.query(
  `INSERT INTO residents (
       resident_id, first_name, last_name, username, email,
       password_hash, role, status, is_verified
     )
   VALUES ($1, 'Edit', 'Tester', $1, $1, 'not-a-real-hash', 'RESIDENT', 'AVAILABLE', true)
   ON CONFLICT (resident_id) DO NOTHING`,
  [residentId]
);

const seedReport = async (overrides = {}) => {
  const residentId = overrides.residentId || RESIDENT_ID;
  await seedResident(residentId);

  const reportId = overrides.reportId
    || `REP-EDIT${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

  return reportRepository.createReport({
    reportId,
    residentId,
    title: 'Original title',
    category: 'Recyclable',
    description: 'Original description',
    latitude: 14.5995,
    longitude: 120.9842,
    imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png',
    ...overrides,
  });
};

const cleanup = async (reportId) => {
  await pool.query('DELETE FROM report_histories WHERE report_id = $1', [reportId]);
  await pool.query('DELETE FROM reports WHERE report_id = $1', [reportId]);
};

test.after(async () => {
  await pool.query('DELETE FROM report_histories WHERE resident_id = ANY($1)', [
    [RESIDENT_ID, OTHER_RESIDENT_ID],
  ]);
  await pool.query('DELETE FROM reports WHERE resident_id = ANY($1)', [
    [RESIDENT_ID, OTHER_RESIDENT_ID],
  ]);
  await pool.query('DELETE FROM residents WHERE resident_id = ANY($1)', [
    [RESIDENT_ID, OTHER_RESIDENT_ID],
  ]);
  await pool.end();
});

test('a title edit is persisted and leaves one grouped history entry', async () => {
  const seeded = await seedReport();
  const createdAt = seeded.created_at;

  try {
    const res = await runUpdate(createRequest({
      reportId: seeded.report_id,
      residentId: RESIDENT_ID,
      body: {
        title: 'Updated title',
        category: seeded.category,
        description: seeded.description,
        latitude: String(seeded.latitude),
        longitude: String(seeded.longitude),
      },
    }));

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.title, 'Updated title');
    assert.deepEqual(res.body.changedFields, ['title']);

    // The stored row, not just the response, reflects the edit.
    const stored = await reportRepository.findByReportId(seeded.report_id);
    assert.equal(stored.title, 'Updated title');

    // Identity and creation time are preserved; only updatedAt moved.
    assert.equal(stored.report_id, seeded.report_id);
    assert.equal(stored.resident_id, RESIDENT_ID);
    assert.equal(new Date(stored.created_at).getTime(), new Date(createdAt).getTime());
    assert.ok(
      new Date(stored.updated_at).getTime() >= new Date(createdAt).getTime(),
      'updated_at must be refreshed by the edit'
    );

    const history = await historyRepository.findByReportId(seeded.report_id);
    const updates = history.filter((entry) => entry.action === 'UPDATED');
    assert.equal(updates.length, 1, 'exactly one history entry per edit');
    assert.equal(updates[0].description, 'Updated report title.');
    assert.equal(updates[0].resident_id, RESIDENT_ID);
    assert.equal(updates[0].report_id, seeded.report_id);
    assert.ok(updates[0].timestamp, 'the edit records its own timestamp');
  } finally {
    await cleanup(seeded.report_id);
  }
});

test('several changed fields produce a single grouped history entry', async () => {
  const seeded = await seedReport();

  try {
    const res = await runUpdate(createRequest({
      reportId: seeded.report_id,
      residentId: RESIDENT_ID,
      body: {
        title: 'Grouped title',
        category: 'Hazardous',
        description: 'Grouped description',
        latitude: '14.6000',
        longitude: '120.9900',
      },
    }));

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.changedFields, ['title', 'category', 'location', 'description']);

    const stored = await reportRepository.findByReportId(seeded.report_id);
    assert.equal(stored.title, 'Grouped title');
    assert.equal(stored.category, 'Hazardous');
    assert.equal(stored.description, 'Grouped description');
    assert.equal(stored.latitude, 14.6);
    assert.equal(stored.longitude, 120.99);

    const history = await historyRepository.findByReportId(seeded.report_id);
    const updates = history.filter((entry) => entry.action === 'UPDATED');
    assert.equal(updates.length, 1, 'a grouped edit still writes one entry');
    assert.equal(
      updates[0].description,
      'Updated report title, waste type, location and description.'
    );

    // An edit is not a status transition, so it must not be counted as one by
    // the Completed/Denied history filters.
    assert.equal(updates[0].old_status, null);
    assert.equal(updates[0].new_status, null);
  } finally {
    await cleanup(seeded.report_id);
  }
});

test('an edit that changes nothing records no history and no timestamp bump', async () => {
  const seeded = await seedReport();

  try {
    await reportRepository.updateReport(seeded.report_id, {});
    const before = await reportRepository.findByReportId(seeded.report_id);
    const updatedAtBefore = before.updated_at;

    const res = await runUpdate(createRequest({
      reportId: seeded.report_id,
      residentId: RESIDENT_ID,
      body: {
        title: before.title,
        category: before.category,
        description: before.description,
        latitude: String(before.latitude),
        longitude: String(before.longitude),
      },
    }));

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.changedFields, []);

    const after = await reportRepository.findByReportId(seeded.report_id);
    assert.equal(
      new Date(after.updated_at).getTime(),
      new Date(updatedAtBefore).getTime(),
      'a no-op edit must not move updated_at'
    );

    const history = await historyRepository.findByReportId(seeded.report_id);
    assert.equal(history.filter((entry) => entry.action === 'UPDATED').length, 0);
  } finally {
    await cleanup(seeded.report_id);
  }
});

test('the description can be cleared on purpose', async () => {
  const seeded = await seedReport({ description: 'Please remove this pile.' });

  try {
    const res = await runUpdate(createRequest({
      reportId: seeded.report_id,
      residentId: RESIDENT_ID,
      body: {
        title: seeded.title,
        category: seeded.category,
        description: '',
        latitude: String(seeded.latitude),
        longitude: String(seeded.longitude),
      },
    }));

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.changedFields, ['description']);

    const stored = await reportRepository.findByReportId(seeded.report_id);
    assert.equal(stored.description, '');

    const history = await historyRepository.findByReportId(seeded.report_id);
    const updates = history.filter((entry) => entry.action === 'UPDATED');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].description, 'Updated description.');
  } finally {
    await cleanup(seeded.report_id);
  }
});

test('an omitted location is preserved rather than reset to zero', async () => {
  const seeded = await seedReport({ latitude: null, longitude: null });

  try {
    const res = await runUpdate(createRequest({
      reportId: seeded.report_id,
      residentId: RESIDENT_ID,
      body: { title: 'Title only edit', category: seeded.category },
    }));

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.changedFields, ['title']);

    const stored = await reportRepository.findByReportId(seeded.report_id);
    assert.equal(stored.latitude, null);
    assert.equal(stored.longitude, null);
  } finally {
    await cleanup(seeded.report_id);
  }
});

test('a report owned by another resident is not editable', async () => {
  const seeded = await seedReport({ residentId: OTHER_RESIDENT_ID });

  try {
    const res = createResponse();
    let forwarded = null;
    await reportController.updateReport(
      createRequest({
        reportId: seeded.report_id,
        residentId: RESIDENT_ID,
        body: { title: 'Hijacked title' },
      }),
      res,
      (error) => { forwarded = error; }
    );

    assert.equal(resolveStatus(res, forwarded), 404);
    assert.ok(forwarded, 'the failure is forwarded to the error middleware');

    const stored = await reportRepository.findByReportId(seeded.report_id);
    assert.equal(stored.title, seeded.title, 'the stored report is untouched');
  } finally {
    await cleanup(seeded.report_id);
  }
});

test('administrator-owned fields cannot be smuggled through a report edit', async () => {
  const seeded = await seedReport();

  try {
    const res = createResponse();
    let forwarded = null;
    await reportController.updateReport(
      createRequest({
        reportId: seeded.report_id,
        residentId: RESIDENT_ID,
        body: { title: 'New title', status: 'Completed' },
      }),
      res,
      (error) => { forwarded = error; }
    );

    assert.equal(resolveStatus(res, forwarded), 400);
    assert.match(forwarded.message, /administrator-owned/);

    const stored = await reportRepository.findByReportId(seeded.report_id);
    assert.equal(stored.status, seeded.status, 'status stays administrator-owned');
  } finally {
    await cleanup(seeded.report_id);
  }
});

test('a client-supplied image_url is ignored in favour of the uploaded photo', async () => {
  const seeded = await seedReport();

  try {
    const res = await runUpdate(createRequest({
      reportId: seeded.report_id,
      residentId: RESIDENT_ID,
      body: {
        title: seeded.title,
        category: seeded.category,
        description: seeded.description,
        latitude: String(seeded.latitude),
        longitude: String(seeded.longitude),
        image_url: 'https://attacker.example.com/evil.png',
      },
    }));

    assert.equal(res.statusCode, 200);

    const stored = await reportRepository.findByReportId(seeded.report_id);
    assert.equal(
      stored.image_url,
      seeded.image_url,
      'a client cannot repoint the stored photo'
    );
  } finally {
    await cleanup(seeded.report_id);
  }
});

test('history is returned newest first for the History screen', async () => {
  const seeded = await seedReport();

  try {
    for (const title of ['First edit', 'Second edit', 'Third edit']) {
      await runUpdate(createRequest({
        reportId: seeded.report_id,
        residentId: RESIDENT_ID,
        body: { title },
      }));
    }

    const history = await historyRepository.findByReportId(seeded.report_id);
    const updates = history.filter((entry) => entry.action === 'UPDATED');

    assert.equal(updates.length, 3);
    const timestamps = updates.map((entry) => new Date(entry.timestamp).getTime());
    const sortedDesc = [...timestamps].sort((a, b) => b - a);
    assert.deepEqual(timestamps, sortedDesc, 'newest edit first');
    assert.match(updates[0].description, /^Updated report title\./);
  } finally {
    await cleanup(seeded.report_id);
  }
});

test('the replaced photo public id is recovered for cleanup', () => {
  assert.equal(
    extractPublicId(
      'https://res.cloudinary.com/ecowatch/image/upload/v1712345678/ecowatch/reports/photo.jpg'
    ),
    'ecowatch/reports/photo'
  );

  assert.equal(
    extractPublicId('https://res.cloudinary.com/ecowatch/image/upload/ecowatch/reports/a.b.png'),
    'ecowatch/reports/a.b'
  );

  // Anything that is not a Cloudinary delivery URL is never destroyed.
  assert.equal(extractPublicId('https://attacker.example.com/evil.png'), null);
  assert.equal(extractPublicId(''), null);
  assert.equal(extractPublicId(null), null);
});

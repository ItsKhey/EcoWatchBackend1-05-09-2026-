const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../config/db');
const announcementRepository = require('../repositories/announcementRepository');
const announcementController = require('../controllers/announcementController');

const ADMIN_ID = 'ADM-ANNOUNCE-TEST';

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

const createRequest = ({ body, query = {} } = {}) => ({
  requestId: 'test-announcement-request',
  body,
  query,
  admin: { admin_id: ADMIN_ID, role: 'ADMIN' },
});

/** Mirrors how the error middleware resolves the status actually sent. */
const resolveStatus = (res, error) => {
  if (error && Number.isInteger(error.statusCode)) return error.statusCode;
  return res.statusCode === 200 ? 500 : res.statusCode;
};

const runCreate = async (body) => {
  const res = createResponse();
  let forwarded = null;
  await announcementController.createAnnouncement(
    createRequest({ body }),
    res,
    (error) => { forwarded = error; }
  );
  return { res, error: forwarded };
};

test.before(async () => {
  // The table must exist before the suite runs. This keeps the test honest
  // about the migration being applied rather than silently passing.
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total FROM information_schema.tables
      WHERE table_name = 'announcements'`
  );
  if (result.rows[0].total === 0) {
    throw new Error('announcements table is missing. Run: npm run migrate:announcements');
  }
  await pool.query('DELETE FROM announcements WHERE created_by_admin_id = $1', [ADMIN_ID]);
});

test.after(async () => {
  await pool.query('DELETE FROM announcements WHERE created_by_admin_id = $1', [ADMIN_ID]);
  await pool.end();
});

test('a normal announcement is persisted and attributed to the admin', async () => {
  const { res, error } = await runCreate({
    title: '  Heavy rain advisory  ',
    message: 'Collection schedules may shift. Please secure loose waste.',
    audience: 'All Residents',
    priority: 'Normal',
  });

  assert.equal(error, null);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);

  const announcement = res.body.announcement;
  assert.ok(announcement.announcementId, 'a server id is returned');
  assert.equal(announcement.title, 'Heavy rain advisory');
  assert.equal(announcement.audience, 'ALL_RESIDENTS');
  assert.equal(announcement.priority, 'NORMAL');
  assert.equal(announcement.createdByAdminId, ADMIN_ID);
  assert.deepEqual(announcement.targetResidentIds, []);
  assert.equal(announcement.barangay, null);

  // The row really exists server-side, not just in the response.
  const stored = await announcementRepository.findById(announcement.announcementId);
  assert.equal(stored.title, 'Heavy rain advisory');
  assert.ok(stored.createdAt, 'the publish time is recorded by the server');
});

test('an important announcement round-trips through the database', async () => {
  const { res } = await runCreate({
    title: 'Coastal cleanup drive',
    message: 'Volunteers are requested on Saturday.',
    audience: 'ALL_RESIDENTS',
    priority: 'Important',
  });

  assert.equal(res.statusCode, 201);

  const stored = await announcementRepository.findById(res.body.announcement.announcementId);
  assert.equal(stored.priority, 'IMPORTANT');
});

test('announcements are listed newest first', async () => {
  const first = await runCreate({
    title: 'First notice',
    message: 'One',
    audience: 'All Residents',
  });
  const second = await runCreate({
    title: 'Second notice',
    message: 'Two',
    audience: 'All Residents',
  });

  const listed = await announcementRepository.findAll({ limit: 2, offset: 0 });
  assert.equal(listed[0].title, 'Second notice');
  assert.equal(listed[1].title, 'First notice');

  const timestamps = listed.map((entry) => new Date(entry.createdAt).getTime());
  assert.ok(timestamps[0] >= timestamps[1], 'newest first');

  assert.equal(first.res.statusCode, 201);
  assert.equal(second.res.statusCode, 201);
});

test('a title is required and length-checked', async () => {
  const missing = await runCreate({
    message: 'No title supplied',
    audience: 'All Residents',
  });
  assert.equal(resolveStatus(missing.res, missing.error), 400);
  assert.match(missing.error.message, /title is required/i);

  const blank = await runCreate({
    title: '   ',
    message: 'Blank title',
    audience: 'All Residents',
  });
  assert.equal(resolveStatus(blank.res, blank.error), 400);

  const tooLong = await runCreate({
    title: 'x'.repeat(151),
    message: 'Over the title limit',
    audience: 'All Residents',
  });
  assert.equal(resolveStatus(tooLong.res, tooLong.error), 400);
});

test('a message is required', async () => {
  const { res, error } = await runCreate({
    title: 'Notice with no body',
    audience: 'All Residents',
  });

  assert.equal(resolveStatus(res, error), 400);
  assert.match(error.message, /message is required/i);
});

test('a multi-line message is preserved', async () => {
  const message = 'Line one\nLine two\n\nLine four';
  const { res } = await runCreate({
    title: 'Multi-line notice',
    message,
    audience: 'All Residents',
  });

  assert.equal(res.statusCode, 201);
  const stored = await announcementRepository.findById(res.body.announcement.announcementId);
  assert.equal(stored.message, message);
});

test('an unknown audience is rejected', async () => {
  const { res, error } = await runCreate({
    title: 'Bad audience',
    message: 'Nobody should get this',
    audience: 'Everyone Everywhere',
  });

  assert.equal(resolveStatus(res, error), 400);
  assert.match(error.message, /audience/i);
});

test('the future-ready narrowed audiences are refused rather than faked', async () => {
  // Storing these would publish an announcement that silently reaches nobody.
  for (const audience of ['Specific Barangay', 'Selected Residents']) {
    const { res, error } = await runCreate({
      title: `Scoped notice (${audience})`,
      message: 'Should not be accepted yet.',
      audience,
    });

    assert.equal(resolveStatus(res, error), 400, `${audience} must be refused`);
    assert.match(error.message, /all residents/i);
  }
});

test('a narrowed target cannot be smuggled into a broadcast', async () => {
  const withBarangay = await runCreate({
    title: 'Broadcast with a barangay',
    message: 'Inconsistent payload.',
    audience: 'All Residents',
    barangay: 'Barangay 12',
  });
  assert.equal(resolveStatus(withBarangay.res, withBarangay.error), 400);

  const withResidents = await runCreate({
    title: 'Broadcast with residents',
    message: 'Inconsistent payload.',
    audience: 'All Residents',
    targetResidentIds: ['RES-ABC123'],
  });
  assert.equal(resolveStatus(withResidents.res, withResidents.error), 400);
});

test('an unknown priority is rejected', async () => {
  const { res, error } = await runCreate({
    title: 'Bad priority',
    message: 'Unknown severity.',
    audience: 'All Residents',
    priority: 'Catastrophic',
  });

  assert.equal(resolveStatus(res, error), 400);
  assert.match(error.message, /priority/i);
});

test('priority defaults to NORMAL when omitted', async () => {
  const { res } = await runCreate({
    title: 'No priority given',
    message: 'Should default.',
    audience: 'All Residents',
  });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.announcement.priority, 'NORMAL');
});

test('a non-object body is rejected', async () => {
  for (const body of [null, 'a string', 42, ['an', 'array']]) {
    const { res, error } = await runCreate(body);
    assert.equal(resolveStatus(res, error), 400, `body ${JSON.stringify(body)} must be refused`);
  }
});

test('an announcement cannot be published without an admin identity', async () => {
  const res = createResponse();
  let forwarded = null;
  await announcementController.createAnnouncement(
    { requestId: 'test', body: { title: 'x', message: 'y', audience: 'All Residents' }, admin: null },
    res,
    (error) => { forwarded = error; }
  );

  assert.equal(resolveStatus(res, forwarded), 403);
});

test('the list endpoint reports the real total', async () => {
  const before = await announcementRepository.countAll();
  await runCreate({
    title: 'Counted notice',
    message: 'Adds one row.',
    audience: 'All Residents',
  });

  const res = createResponse();
  let forwarded = null;
  await announcementController.listAnnouncements(createRequest({ query: { limit: '5' } }), res, (error) => {
    forwarded = error;
  });

  assert.equal(forwarded, null);
  assert.equal(res.body.success, true);
  assert.equal(res.body.total, before + 1);
  assert.ok(Array.isArray(res.body.announcements));
  assert.ok(res.body.announcements.length <= 5);
});

test('the list endpoint clamps hostile paging values', async () => {
  const res = createResponse();
  let forwarded = null;
  await announcementController.listAnnouncements(
    createRequest({ query: { limit: '99999', offset: '-4' } }),
    res,
    (error) => { forwarded = error; }
  );

  assert.equal(forwarded, null);
  assert.equal(res.body.limit, 100);
  assert.equal(res.body.offset, 0);
});

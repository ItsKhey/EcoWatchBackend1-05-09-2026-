const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../config/db');
const announcementRepository = require('../repositories/announcementRepository');
const announcementController = require('../controllers/announcementController');
const { deleteExpiredAnnouncements } = require('../services/announcementCleanupService');

const ADMIN_ID = 'ADM-ANNOUNCE-EXPIRY-TEST';
const RESIDENT_ID = 'RES-ANNOUNCE-EXPIRY-TEST';

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
  requestId: 'test-announcement-expiry',
  body,
  query,
  admin: { admin_id: ADMIN_ID, role: 'ADMIN' },
});

const createResidentRequest = (query = {}) => ({
  requestId: 'test-announcement-expiry-resident',
  query,
  resident: { residentId: RESIDENT_ID },
});

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
  return { res, error: forwarded, status: resolveStatus(res, forwarded) };
};

const runResidentFeed = async () => {
  const res = createResponse();
  let forwarded = null;
  await announcementController.getMyAnnouncements(
    createResidentRequest(),
    res,
    (error) => { forwarded = error; }
  );
  return { res, error: forwarded };
};

/**
 * Backdates a published announcement so its deadline has already passed.
 *
 * <p>Rewriting created_at as well as expires_at keeps the two consistent, which
 * is what a real row published in the past would look like.
 */
const backdatePastDeadline = async (announcementId) => {
  await pool.query(
    `UPDATE announcements
        SET created_at = NOW() - INTERVAL '10 days',
            expires_at = NOW() - INTERVAL '3 days'
      WHERE id = $1`,
    [announcementId]
  );
};

test.before(async () => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total FROM information_schema.tables
      WHERE table_name = 'announcements'`
  );
  if (result.rows[0].total === 0) {
    throw new Error('announcements table is missing. Run: npm run migrate:announcements');
  }

  // The expiry column is a separate migration, so its absence must be a loud
  // failure rather than a suite that quietly skips every assertion below.
  const column = await pool.query(
    `SELECT COUNT(*)::int AS total FROM information_schema.columns
      WHERE table_name = 'announcements' AND column_name = 'expires_at'`
  );
  if (column.rows[0].total === 0) {
    throw new Error(
      'announcements.expires_at is missing. Run: npm run migrate:announcement-expiry'
    );
  }

  await pool.query('DELETE FROM announcements WHERE created_by_admin_id = $1', [ADMIN_ID]);
});

test.after(async () => {
  await pool.query('DELETE FROM announcements WHERE created_by_admin_id = $1', [ADMIN_ID]);
  await pool.end();
});

test('an announcement is published with a deadline by default', async () => {
  const { res, error } = await runCreate({
    title: 'Default window notice',
    message: 'No expiry was chosen by the caller.',
    audience: 'All Residents',
    priority: 'Normal',
  });

  assert.equal(error, null);
  assert.equal(res.statusCode, 201);

  const announcement = res.body.announcement;
  assert.ok(announcement.expiresAt, 'a deadline is recorded by default');

  const stored = await announcementRepository.findById(announcement.announcementId);
  const createdAt = new Date(stored.createdAt);
  const expiresAt = new Date(stored.expiresAt);
  const days = Math.round((expiresAt - createdAt) / (24 * 60 * 60 * 1000));

  assert.equal(days, announcementController.DEFAULT_EXPIRY_DAYS);
});

test('the administrator chooses the lifetime window', async () => {
  const { res } = await runCreate({
    title: 'Same day advisory',
    message: 'Collection resumes this afternoon.',
    audience: 'All Residents',
    priority: 'Normal',
    expiresInDays: 1,
  });

  const stored = await announcementRepository.findById(res.body.announcement.announcementId);
  const days = Math.round(
    (new Date(stored.expiresAt) - new Date(stored.createdAt)) / (24 * 60 * 60 * 1000)
  );

  assert.equal(days, 1);
});

test('a longer window is honoured', async () => {
  const { res } = await runCreate({
    title: 'Extended advisory',
    message: 'Stays up for a month.',
    audience: 'All Residents',
    priority: 'Normal',
    expiresInDays: 30,
  });

  const stored = await announcementRepository.findById(res.body.announcement.announcementId);
  const days = Math.round(
    (new Date(stored.expiresAt) - new Date(stored.createdAt)) / (24 * 60 * 60 * 1000)
  );

  assert.equal(days, 30);
});

test('"never expires" stores no deadline at all', async () => {
  const { res } = await runCreate({
    title: 'Permanent notice',
    message: 'Stays published indefinitely.',
    audience: 'All Residents',
    priority: 'Normal',
    expiresInDays: 0,
  });

  assert.equal(res.body.announcement.expiresAt, null);

  const stored = await announcementRepository.findById(res.body.announcement.announcementId);
  assert.equal(stored.expiresAt, null);
});

test('an announcement without a deadline is never reaped', async () => {
  const { res } = await runCreate({
    title: 'Never reaped',
    message: 'No timer on this one.',
    audience: 'All Residents',
    priority: 'Normal',
    expiresInDays: 0,
  });
  const announcementId = res.body.announcement.announcementId;

  // Age the row well past any window, leaving only the NULL deadline to protect it.
  await pool.query(
    `UPDATE announcements SET created_at = NOW() - INTERVAL '400 days' WHERE id = $1`,
    [announcementId]
  );

  await deleteExpiredAnnouncements();

  const stored = await announcementRepository.findById(announcementId);
  assert.ok(stored, 'a row with no deadline survives the cleanup job');
});

test('a window outside the allowlist is refused rather than clamped', async () => {
  const { status, error } = await runCreate({
    title: 'Sneaky window',
    message: 'Asks for a year.',
    audience: 'All Residents',
    priority: 'Normal',
    expiresInDays: 365,
  });

  assert.equal(status, 400);
  assert.match(error.message, /Expiry window/i);
});

test('a non-numeric window is refused instead of silently read as a number', async () => {
  const { status } = await runCreate({
    title: 'Wordy window',
    message: 'Asks for "7days".',
    audience: 'All Residents',
    priority: 'Normal',
    expiresInDays: '7days',
  });

  assert.equal(status, 400);
});

test('an expired announcement disappears from the resident feed immediately', async () => {
  const { res } = await runCreate({
    title: 'Lapsed notice',
    message: 'Published long enough ago to have lapsed.',
    audience: 'All Residents',
    priority: 'Normal',
    expiresInDays: 7,
  });
  const announcementId = res.body.announcement.announcementId;

  // Visible while the deadline is in the future.
  const before = await runResidentFeed();
  assert.ok(
    before.res.body.announcements.some((row) => row.announcementId === announcementId),
    'a live announcement reaches the resident'
  );

  await backdatePastDeadline(announcementId);

  // The read filter, not the nightly job, is what makes this exact.
  const after = await runResidentFeed();
  assert.ok(
    !after.res.body.announcements.some((row) => row.announcementId === announcementId),
    'a lapsed announcement stops reaching the resident'
  );
});

test('an expired announcement also disappears from the administrator list', async () => {
  const { res } = await runCreate({
    title: 'Admin side lapse',
    message: 'Lapsed for the administrator too.',
    audience: 'All Residents',
    priority: 'Normal',
    expiresInDays: 7,
  });
  const announcementId = res.body.announcement.announcementId;

  await backdatePastDeadline(announcementId);

  const list = await announcementRepository.findAll({ limit: 100, offset: 0 });
  assert.ok(
    !list.some((row) => row.announcementId === announcementId),
    'the administrator no longer lists a lapsed announcement'
  );
});

test('an Important announcement follows the same window as a Normal one', async () => {
  const { res } = await runCreate({
    title: 'Urgent but expiring',
    message: 'Priority does not buy extra time.',
    audience: 'All Residents',
    priority: 'Important',
    expiresInDays: 1,
  });
  const announcementId = res.body.announcement.announcementId;

  assert.equal(res.body.announcement.priority, 'IMPORTANT');

  await backdatePastDeadline(announcementId);

  const after = await runResidentFeed();
  assert.ok(
    !after.res.body.announcements.some((row) => row.announcementId === announcementId),
    'an Important announcement expires exactly like a Normal one'
  );
});

test('the cleanup job permanently deletes lapsed announcements', async () => {
  const kept = await runCreate({
    title: 'Still current',
    message: 'Deadline has not passed.',
    audience: 'All Residents',
    priority: 'Normal',
    expiresInDays: 7,
  });
  const gone = await runCreate({
    title: 'Past its deadline',
    message: 'Deadline has passed.',
    audience: 'All Residents',
    priority: 'Normal',
    expiresInDays: 7,
  });

  await backdatePastDeadline(gone.res.body.announcement.announcementId);

  const { deleted } = await deleteExpiredAnnouncements();
  assert.ok(deleted >= 1, 'the job reports what it removed');

  // Permanent means gone at the storage layer, not merely filtered from a read.
  const survivor = await announcementRepository.findById(kept.res.body.announcement.announcementId);
  assert.ok(survivor, 'a live announcement is untouched');

  const reaped = await pool.query('SELECT * FROM announcements WHERE id = $1', [
    gone.res.body.announcement.announcementId,
  ]);
  assert.equal(reaped.rows.length, 0, 'the lapsed row is deleted from the table');
});

test('a republish between the scan and the delete is not reaped', async () => {
  const { res } = await runCreate({
    title: 'Race guard',
    message: 'Extended after it was already scanned.',
    audience: 'All Residents',
    priority: 'Normal',
    expiresInDays: 7,
  });
  const announcementId = res.body.announcement.announcementId;

  await backdatePastDeadline(announcementId);

  // Simulate the row being given a new deadline after findExpired() ran.
  const announcementRepositoryWithStaleScan = {
    findExpired: () => announcementRepository.findExpired(),
    deleteExpired: () => announcementRepository.deleteExpired(),
  };
  await announcementRepositoryWithStaleScan.findExpired();
  await pool.query(
    `UPDATE announcements SET expires_at = NOW() + INTERVAL '7 days' WHERE id = $1`,
    [announcementId]
  );
  await announcementRepositoryWithStaleScan.deleteExpired();

  const stored = await announcementRepository.findById(announcementId);
  assert.ok(stored, 'a row that was extended survives the delete');
});

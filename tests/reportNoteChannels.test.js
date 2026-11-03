const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../src/config/db');
const adminController = require('../src/modules/admin/adminController');
const reportController = require('../src/modules/reports/reportController');
const reportRepository = require('../src/modules/reports/reportRepository');
const notificationRepository = require('../src/modules/notifications/notificationRepository');
const personnelAssignmentService = require('../src/modules/personnel/personnelAssignmentService');

/**
 * Proves the audience split between the three note channels.
 *
 * A report carries three different conversations and only two of them are the
 * resident's business:
 *
 *   reports.admin_response            the official answer the resident reads
 *   reports.personnel_note            internal notes for the assigned cleaner
 *   personnel_assignments.completion_notes   what the cleaner did, shared back
 *
 * The regression this guards against is the old behaviour: requesting a revision
 * wrote the reviewer's note into `admin_response` and raised a resident
 * notification, so the reporter read internal review feedback that was never
 * meant for them.
 */

const ADMIN_ID = 'ADM-NOTECHANNEL';
const RESIDENT_ID = 'RES-NOTECHANNEL';
const PERSONNEL_ID = 'PERS-9101';
/** A cleaner can hold only one live report, so the revision scenario needs its own. */
const REVISION_PERSONNEL_ID = 'PERS-9102';
const REPORT_ID = 'REP-NOTECHANNEL';
const REVISION_REPORT_ID = 'REP-NOTECHANGE2';

const IMAGE_URL =
  'https://res.cloudinary.com/demo/image/upload/v1712345678/ecowatch/reports/original.png';

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  // Admin list endpoints mark their responses no-store; the stub only has to
  // accept the header so the handler runs.
  set() {
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

const runController = async (handler, req) => {
  const res = createResponse();
  let forwarded = null;
  await handler(req, res, (error) => {
    forwarded = error;
  });
  if (forwarded) return { error: forwarded };
  return { res };
};

const seed = async () => {
  await pool.query(
    `INSERT INTO admins (admin_id, first_name, last_name, username, email,
        password_hash, role)
     VALUES ($1, 'Note', 'Channel', $1, $1, 'not-a-real-hash', 'ADMIN')
     ON CONFLICT (admin_id) DO UPDATE SET role = 'ADMIN'`,
    [ADMIN_ID]
  );

  await pool.query(
    `INSERT INTO residents (resident_id, first_name, last_name, username, email,
        password_hash, role, status, is_verified)
     VALUES ($1, 'Note', 'Reporter', $1, $1, 'not-a-real-hash', 'RESIDENT', 'AVAILABLE', true)
     ON CONFLICT (resident_id) DO NOTHING`,
    [RESIDENT_ID]
  );

  await pool.query(
    `INSERT INTO personnel_accounts (personnel_id, first_name, last_name, username, email,
        password_hash, role, status, is_cleaning)
     VALUES ($1, 'Clean', 'Channel', $2, $3, 'not-a-real-hash', 'PERSONNEL', 'OFFLINE', false)
     ON CONFLICT (personnel_id) DO NOTHING`,
    [PERSONNEL_ID, 'notechannelcleaner', 'notechannelcleaner@gmail.com']
  );

  await pool.query(
    `INSERT INTO personnel_accounts (personnel_id, first_name, last_name, username, email,
        password_hash, role, status, is_cleaning)
     VALUES ($1, 'Clean', 'Revise', $2, $3, 'not-a-real-hash', 'PERSONNEL', 'OFFLINE', false)
     ON CONFLICT (personnel_id) DO NOTHING`,
    [REVISION_PERSONNEL_ID, 'notechannelreviser', 'notechannelreviser@gmail.com']
  );

  await reportRepository.createReport({
    reportId: REPORT_ID,
    residentId: RESIDENT_ID,
    title: 'Note channel report',
    category: 'Recyclable',
    description: 'Note channel fixture',
    latitude: 14.5995,
    longitude: 120.9842,
    imageUrl: IMAGE_URL,
  });

  await reportRepository.createReport({
    reportId: REVISION_REPORT_ID,
    residentId: RESIDENT_ID,
    title: 'Revision note report',
    category: 'Recyclable',
    description: 'Revision note fixture',
    latitude: 14.5995,
    longitude: 120.9842,
    imageUrl: IMAGE_URL,
  });
};

const cleanup = async () => {
  await pool.query(
    `DELETE FROM report_histories WHERE resident_id = $1 OR report_id IN ($2, $3)`,
    [RESIDENT_ID, REPORT_ID, REVISION_REPORT_ID]
  );
  await pool.query(
    `DELETE FROM reports WHERE report_id IN ($1, $2)`,
    [REPORT_ID, REVISION_REPORT_ID]
  );
  await pool.query(
    `DELETE FROM personnel_accounts WHERE personnel_id = ANY($1)`,
    [[PERSONNEL_ID, REVISION_PERSONNEL_ID]]
  );
  await pool.query(`DELETE FROM residents WHERE resident_id = $1`, [RESIDENT_ID]);
  await pool.query(`DELETE FROM admins WHERE admin_id = $1`, [ADMIN_ID]);
};

test.before(async () => {
  await cleanup();
  await seed();
});

test.after(async () => {
  await cleanup();
});

test('an assignment stores the personnel note beside, not inside, the resident response', async () => {
  const { res, error } = await runController(
    adminController.assignPersonnel,
    {
      requestId: 'test-note-assign',
      params: { id: REPORT_ID },
      body: {
        personnelId: PERSONNEL_ID,
        adminResponse: 'We will collect this tomorrow.',
        personnelNote: 'Use the west gate; the east one is locked.',
      },
      admin: { admin_id: ADMIN_ID, role: 'ADMIN' },
    }
  );

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  assert.equal(res.body.success, true);

  const row = await pool.query(
    `SELECT admin_response, personnel_note FROM reports WHERE report_id = $1`,
    [REPORT_ID]
  );
  assert.equal(row.rows[0].admin_response, 'We will collect this tomorrow.');
  assert.equal(
    row.rows[0].personnel_note,
    'Use the west gate; the east one is locked.'
  );

  // The administrator sees both, and can tell them apart.
  assert.equal(res.body.adminResponse, 'We will collect this tomorrow.');
  assert.equal(res.body.personnelNote, 'Use the west gate; the east one is locked.');
  assert.equal(
    res.body.assignment.personnelNote,
    'Use the west gate; the east one is locked.'
  );
});

test('the resident payload never carries the administrator note for the cleaner', async () => {
  const { res, error } = await runController(reportController.getMyReports, {
    requestId: 'test-note-resident',
    resident: { residentId: RESIDENT_ID },
  });

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);

  const report = res.body.find((entry) => entry.reportId === REPORT_ID);
  assert.ok(report, 'the seeded report must come back in the resident list');

  assert.equal(report.adminResponse, 'We will collect this tomorrow.');
  assert.equal(report.personnelNote, undefined);
  assert.equal(report.personnel_note, undefined);
  assert.equal(
    JSON.stringify(res.body).includes('the east one is locked'),
    false,
    'the personnel-only note must not appear anywhere in the resident payload'
  );
});

test('the assigned cleaner reads the personnel note on their task', async () => {
  const assignment = await pool.query(
    `SELECT assignment_id FROM personnel_assignments
      WHERE report_id = $1 AND personnel_id = $2
      LIMIT 1`,
    [REPORT_ID, PERSONNEL_ID]
  );
  const assignmentId = assignment.rows[0].assignment_id;

  const task = await personnelAssignmentService.getTask(PERSONNEL_ID, assignmentId);

  assert.equal(
    task.report.personnelNote,
    'Use the west gate; the east one is locked.'
  );
  // The cleaner also sees the resident-facing answer, which is legitimate: it
  // tells them what was promised to the person who filed the report.
  assert.equal(task.report.adminResponse, 'We will collect this tomorrow.');
});

test('requesting a revision keeps the note away from the resident', async () => {
  // Put the second report into the review state the command requires, with the
  // cleaner already marked COMPLETED and a resident response already written.
  await pool.query(
    `UPDATE reports
        SET status = 'Under Review',
            admin_response = 'The crew has been dispatched.',
            assigned_personnel_id = $2,
            assigned_by_admin_id = $3,
            assigned_at = NOW()
      WHERE report_id = $1`,
    [REVISION_REPORT_ID, REVISION_PERSONNEL_ID, ADMIN_ID]
  );
  await pool.query(
    `INSERT INTO personnel_assignments (
        report_id, personnel_id, status, assigned_by_admin_id, completed_at
     ) VALUES ($1, $2, 'COMPLETED', $3, NOW())
     ON CONFLICT DO NOTHING`,
    [REVISION_REPORT_ID, REVISION_PERSONNEL_ID, ADMIN_ID]
  );

  const before = await notificationRepository.findAllByResidentId(RESIDENT_ID);

  const { res, error } = await runController(
    adminController.reviseReportCompletion,
    {
      requestId: 'test-note-revise',
      params: { id: REVISION_REPORT_ID },
      body: {
        adminResponse: 'The after photos do not show the drain being cleared.',
      },
      admin: { admin_id: ADMIN_ID, role: 'ADMIN' },
    }
  );

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  assert.equal(res.body.success, true);

  const row = await pool.query(
    `SELECT status, admin_response, personnel_note FROM reports WHERE report_id = $1`,
    [REVISION_REPORT_ID]
  );

  // The work went back to the cleaner...
  assert.equal(row.rows[0].status, 'In Progress');
  // ...the reviewer's note landed in the personnel-only channel...
  assert.equal(
    row.rows[0].personnel_note,
    'The after photos do not show the drain being cleared.'
  );
  // ...and the resident-facing answer they were already given is untouched.
  assert.equal(row.rows[0].admin_response, 'The crew has been dispatched.');

  // No resident-visible history claims the admin replied.
  const history = await pool.query(
    `SELECT COUNT(*)::int AS total
       FROM report_histories
      WHERE report_id = $1 AND action = 'ADMIN_RESPONSE_UPDATED'`,
    [REVISION_REPORT_ID]
  );
  assert.equal(
    history.rows[0].total,
    0,
    'requesting a revision must not write a resident-visible response history'
  );

  // And the resident was not notified about a response they never received.
  const after = await notificationRepository.findAllByResidentId(RESIDENT_ID);
  const newNotifications = after.filter(
    (row) => !before.some((existing) => existing.notification_id === row.notification_id)
  );
  assert.equal(
    newNotifications.some((row) =>
      String(row.message || '').includes('the drain being cleared')
    ),
    false,
    'the revision note must never appear in a resident notification'
  );
});

test('the resident sees the cleaner completion note as personnelResponse', async () => {
  const assignment = await pool.query(
    `SELECT assignment_id FROM personnel_assignments
      WHERE report_id = $1 AND personnel_id = $2
      LIMIT 1`,
    [REPORT_ID, PERSONNEL_ID]
  );
  const assignmentId = assignment.rows[0].assignment_id;

  await pool.query(
    `UPDATE personnel_assignments
        SET status = 'COMPLETED',
            completed_at = NOW(),
            completion_notes = 'Swept the plaza and cleared the drain cover.'
      WHERE assignment_id = $1`,
    [assignmentId]
  );

  const { res, error } = await runController(reportController.getMyReports, {
    requestId: 'test-note-personnel-response',
    resident: { residentId: RESIDENT_ID },
  });

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);

  const report = res.body.find((entry) => entry.reportId === REPORT_ID);
  assert.equal(
    report.personnelResponse,
    'Swept the plaza and cleared the drain cover.'
  );
  // The two channels stay separate even on the same payload.
  assert.equal(report.adminResponse, 'We will collect this tomorrow.');
  assert.equal(report.personnelNote, undefined);
});

test('the admin list carries the cleaner note and names who cleaned it', async () => {
  const { res, error } = await runController(adminController.getAllReports, {
    requestId: 'test-note-admin-completion',
    admin: { admin_id: ADMIN_ID, role: 'ADMIN' },
    query: {},
  });

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);

  const report = res.body.find((entry) => entry.reportId === REPORT_ID);
  assert.ok(report, 'the report must come back in the admin list');

  // The cleaner talking back, which the admin is the only one who needs here.
  assert.equal(
    report.personnelResponse,
    'Swept the plaza and cleared the drain cover.'
  );
  assert.equal(report.completedByPersonnelId, PERSONNEL_ID);
  assert.ok(
    report.completedByPersonnelName,
    'a completed report must name the personnel who did the work'
  );
  assert.ok(report.workCompletedAt, 'the completion time must be exposed');

  // The administrator's own channel is untouched by the cleaner's reply.
  assert.equal(
    report.personnelNote,
    'Use the west gate; the east one is locked.'
  );
});

test('a cleaner who finished without writing a note is still credited', async () => {
  await pool.query(
    `UPDATE personnel_assignments
        SET completion_notes = NULL
      WHERE report_id = $1 AND personnel_id = $2`,
    [REPORT_ID, PERSONNEL_ID]
  );

  const { res, error } = await runController(adminController.getAllReports, {
    requestId: 'test-note-admin-blank',
    admin: { admin_id: ADMIN_ID, role: 'ADMIN' },
    query: {},
  });

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  const report = res.body.find((entry) => entry.reportId === REPORT_ID);

  assert.equal(report.personnelResponse, null);
  assert.equal(
    report.completedByPersonnelId,
    PERSONNEL_ID,
    'a blank note must not erase the credit for the work'
  );

  // Restore for any later test that reads this note.
  await pool.query(
    `UPDATE personnel_assignments
        SET completion_notes = 'Swept the plaza and cleared the drain cover.'
      WHERE report_id = $1 AND personnel_id = $2`,
    [REPORT_ID, PERSONNEL_ID]
  );
});

test('a report with no completed work simply has no personnelResponse', async () => {
  const { res, error } = await runController(reportController.getMyReports, {
    requestId: 'test-note-empty',
    resident: { residentId: RESIDENT_ID },
  });

  assert.equal(error, undefined, `unexpected error: ${error && error.message}`);
  const report = res.body.find((entry) => entry.reportId === REVISION_REPORT_ID);
  assert.ok(report, 'the revision report must come back in the resident list');
  assert.equal(
    report.personnelResponse,
    null,
    'a reopened task has no note to share'
  );
});
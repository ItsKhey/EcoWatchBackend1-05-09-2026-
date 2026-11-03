/**
 * End-to-end verification of the personnel assignment workflow against the
 * local PostgreSQL database and the real service layer.
 *
 * There are no mocks here: it assigns a real pending report to a real personnel
 * account, walks ASSIGNED -> ACCEPTED -> IN_PROGRESS -> COMPLETED with real
 * before/after image uploads, approves the report as the administrator, asserts
 * every transition and the database invariants, then restores the original rows
 * and removes everything it created.
 *
 * Usage: node scripts/verify-personnel-workflow.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { pool } = require('../src/config/db');
const reportAssignmentService = require('../src/modules/reports/reportAssignmentService');
const personnelAssignmentService = require('../src/modules/personnel/personnelAssignmentService');
const personnelAssignmentRepository = require('../src/modules/personnel/personnelAssignmentRepository');
const personnelEvidenceRepository = require('../src/modules/personnel/personnelEvidenceRepository');
const personnelNotificationRepository = require('../src/modules/personnel/personnelNotificationRepository');
const cloudinaryService = require('../src/shared/cloudinaryService');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

const failures = [];
let assertions = 0;

const check = (label, condition, detail = '') => {
  assertions += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

const findTargetReport = async () => {
  const result = await pool.query(
    `
    SELECT r.*
    FROM reports r
    WHERE r.status = 'Pending'
      AND r.assigned_personnel_id IS NULL
      AND COALESCE(r.is_deleted, false) = false
      AND COALESCE(r.is_archived, false) = false
      AND NOT EXISTS (
        SELECT 1 FROM personnel_assignments pa
        WHERE pa.report_id = r.report_id
          AND pa.status IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS')
      )
    ORDER BY r.report_id
    LIMIT 1
    `
  );
  return result.rows[0] || null;
};

const findTargetPersonnel = async () => {
  const result = await pool.query(
    `
    SELECT *
    FROM personnel_accounts
    WHERE role = 'PERSONNEL'
      AND enabled = true
      AND deleted_at IS NULL
      AND current_assignment_report_id IS NULL
      AND COALESCE(is_cleaning, false) = false
      AND NOT EXISTS (
        SELECT 1 FROM personnel_assignments pa
        WHERE pa.personnel_id = personnel_accounts.personnel_id
          AND pa.status IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS')
      )
    ORDER BY personnel_id
    LIMIT 1
    `
  );
  return result.rows[0] || null;
};

const findAdmin = async () => {
  const result = await pool.query('SELECT admin_id FROM admins LIMIT 1');
  return result.rows[0]?.admin_id || null;
};

const verifySchema = async () => {
  console.log('\n[1/6] Schema');
  const columns = await pool.query(
    `
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('personnel_assignments', 'personnel_evidence', 'personnel_notifications',
                         'personnel_accounts')
    `
  );
  const present = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
  check('personnel_assignments exists', [...present].some((c) => c.startsWith('personnel_assignments.')));
  check('personnel_evidence exists', [...present].some((c) => c.startsWith('personnel_evidence.')));
  check('personnel_notifications exists', [...present].some((c) => c.startsWith('personnel_notifications.')));
  check('personnel_accounts.fcm_token exists', present.has('personnel_accounts.fcm_token'));

  const indexes = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
      AND indexname IN ('personnel_assignments_active_report_uidx',
                        'personnel_assignments_active_personnel_uidx')`
  );
  check('one active assignment per report index', indexes.rows.length === 2);
};

const cleanup = async (ctx) => {
  console.log('\n[6/6] Cleanup');
  const { report, personnel, startedAt, assignmentIds, evidenceUrls } = ctx;

  for (const url of evidenceUrls || []) {
    try {
      await cloudinaryService.destroyImage(url);
    } catch (error) {
      console.log(`  note  evidence asset cleanup skipped: ${error.message}`);
    }
  }

  if (assignmentIds && assignmentIds.length) {
    await pool.query('DELETE FROM personnel_evidence WHERE assignment_id = ANY($1::text[])', [assignmentIds]);
    await pool.query('DELETE FROM personnel_notifications WHERE assignment_id = ANY($1::text[])', [assignmentIds]);
    await pool.query('DELETE FROM personnel_assignments WHERE assignment_id = ANY($1::text[])', [assignmentIds]);
  }

  // Best-effort removal of the rows the workflow generated elsewhere.
  await pool.query('DELETE FROM personnel_notifications WHERE personnel_id = $1 AND created_at >= $2', [
    personnel.personnel_id,
    startedAt,
  ]);
  await pool.query('DELETE FROM report_histories WHERE report_id = $1 AND timestamp >= $2', [
    report.report_id,
    startedAt,
  ]);
  try {
    await pool.query('DELETE FROM notifications WHERE report_id = $1 AND created_at >= $2', [
      report.report_id,
      startedAt,
    ]);
  } catch (error) {
    console.log(`  note  resident notification cleanup skipped: ${error.message}`);
  }

  // Restore the report to exactly the values it had before the run.
  await pool.query(
    `
    UPDATE reports
       SET status = $2,
           assigned_personnel_id = $3,
           assigned_personnel_ids = $4,
           assigned_by_admin_id = $5,
           assigned_at = $6,
           handled_by_id = $7,
           admin_response = $8,
           priority = $9,
           resolved_at = $10
     WHERE report_id = $1
    `,
    [
      report.report_id,
      report.status,
      report.assigned_personnel_id,
      report.assigned_personnel_ids,
      report.assigned_by_admin_id,
      report.assigned_at,
      report.handled_by_id,
      report.admin_response,
      report.priority,
      report.resolved_at,
    ]
  );

  // Restore the personnel account's busy state.
  await pool.query(
    `
    UPDATE personnel_accounts
       SET status = $2,
           is_cleaning = $3,
           current_assignment = $4,
           current_assignment_report_id = $5,
           current_assignment_location = $6,
           current_assignment_assigned_at = $7
     WHERE personnel_id = $1
    `,
    [
      personnel.personnel_id,
      personnel.status,
      personnel.is_cleaning,
      personnel.current_assignment,
      personnel.current_assignment_report_id,
      personnel.current_assignment_location,
      personnel.current_assignment_assigned_at,
    ]
  );

  console.log('  restored report and personnel rows, removed test artifacts');
};

const main = async () => {
  await verifySchema();

  console.log('\n[2/6] Select real target');
  const report = await findTargetReport();
  const personnel = await findTargetPersonnel();
  const adminId = await findAdmin();

  if (!report || !personnel || !adminId) {
    console.log('  No suitable pending report / idle personnel / admin available to exercise the flow.');
    process.exit(0);
  }

  console.log(`  report    ${report.report_id} (${report.status})`);
  console.log(`  personnel ${personnel.personnel_id} (${personnel.status})`);
  console.log(`  admin     ${adminId}`);

  const startedAt = new Date();
  const ctx = { report, personnel, startedAt, assignmentIds: [], evidenceUrls: [] };

  try {
    console.log('\n[3/6] Admin assigns the report');
    const assigned = await reportAssignmentService.assignPersonnelToReport({
      reportId: report.report_id,
      assignedPersonnelIds: [personnel.personnel_id],
      canonicalPersonnelId: personnel.personnel_id,
      adminResponse: 'Automated workflow verification.',
      priority: report.priority || 'Normal',
      adminId,
      requestId: 'verify-personnel-workflow',
    });

    check('report moved to In Progress', assigned.report.status === 'In Progress', assigned.report.status);

    const active = await personnelAssignmentRepository.findActiveByPersonnelId(personnel.personnel_id);
    check('an active assignment row exists', Boolean(active));
    check('assignment starts ASSIGNED', active?.status === 'ASSIGNED', active?.status);
    check('assignment points at the report', active?.report_id === report.report_id);

    const assignmentId = active.assignment_id;
    ctx.assignmentIds.push(assignmentId);

    console.log('\n[4/6] Personnel walks the workflow');
    const currentTask = await personnelAssignmentService.getCurrentTask(personnel.personnel_id);
    check('current task is returned', currentTask?.assignmentId === assignmentId);
    check('task can be accepted', currentTask?.permissions?.canAccept === true);

    const accepted = await personnelAssignmentService.acceptTask(personnel.personnel_id, assignmentId);
    check('accepted status', accepted.status === 'ACCEPTED', accepted.status);
    check('acceptedAt recorded', Boolean(accepted.acceptedAt));
    check('cannot complete before evidence', accepted.permissions?.canComplete === false);

    let startBlocked = false;
    try {
      await personnelAssignmentService.startTask(personnel.personnel_id, assignmentId, {});
    } catch (error) {
      startBlocked = error.statusCode === 409;
    }
    check('start is rejected without BEFORE evidence', startBlocked);

    const before = await personnelAssignmentService.uploadEvidence(
      personnel.personnel_id,
      assignmentId,
      { phase: 'BEFORE', file: { buffer: ONE_PIXEL_PNG } }
    );
    ctx.evidenceUrls.push(before.evidence.imageUrl);
    check('BEFORE evidence stored', before.evidence.phase === 'BEFORE');
    check('BEFORE count is 1', before.task.beforeCount === 1);
    check('task can now start', before.task.permissions?.canStart === true);

    const started = await personnelAssignmentService.startTask(personnel.personnel_id, assignmentId, {});
    check('in progress status', started.status === 'IN_PROGRESS', started.status);
    check('startedAt recorded', Boolean(started.startedAt));

    let afterBlocked = true;
    try {
      await personnelAssignmentService.uploadEvidence(personnel.personnel_id, assignmentId, {
        phase: 'BEFORE',
        file: { buffer: ONE_PIXEL_PNG },
      });
      // A second BEFORE is allowed while IN_PROGRESS; re-upload the AFTER below.
      afterBlocked = false;
    } catch (error) {
      afterBlocked = true;
    }
    check('BEFORE can still be appended while in progress', afterBlocked === false);

    const after = await personnelAssignmentService.uploadEvidence(
      personnel.personnel_id,
      assignmentId,
      { phase: 'AFTER', file: { buffer: ONE_PIXEL_PNG } }
    );
    ctx.evidenceUrls.push(after.evidence.imageUrl);
    check('AFTER evidence stored', after.evidence.phase === 'AFTER');
    check('AFTER count is 1', after.task.afterCount === 1);
    check('task can be completed', after.task.permissions?.canComplete === true);

    const completed = await personnelAssignmentService.completeTask(
      personnel.personnel_id,
      assignmentId,
      { notes: 'Cleaned and verified.' }
    );
    check('completed status', completed.status === 'COMPLETED', completed.status);
    check('completedAt recorded', Boolean(completed.completedAt));
    check('completion notes stored', completed.completionNotes === 'Cleaned and verified.');

    const reportStillInProgress = await pool.query(
      'SELECT status, assigned_personnel_id FROM reports WHERE report_id = $1',
      [report.report_id]
    );
    check(
      'report stays In Progress awaiting approval',
      reportStillInProgress.rows[0].status === 'In Progress',
      reportStillInProgress.rows[0].status
    );
    check(
      'personnel pointer kept until approval',
      reportStillInProgress.rows[0].assigned_personnel_id === personnel.personnel_id
    );

    console.log('\n[5/6] Admin approves completion');
    const approval = await reportAssignmentService.completePersonnelReport({
      reportId: report.report_id,
      updatedByAdminId: adminId,
      requestId: 'verify-personnel-workflow',
    });
    check('report Completed after approval', approval.report.status === 'Completed', approval.report.status);
    check('report pointer released', approval.report.assigned_personnel_id === null);

    const personnelAfter = await pool.query(
      'SELECT is_cleaning, current_assignment_report_id FROM personnel_accounts WHERE personnel_id = $1',
      [personnel.personnel_id]
    );
    check('personnel released after approval', personnelAfter.rows[0].current_assignment_report_id === null);
    check('personnel no longer cleaning', personnelAfter.rows[0].is_cleaning === false);

    const finalAssignment = await personnelAssignmentRepository.findById(assignmentId);
    check('assignment remains COMPLETED as history', finalAssignment?.status === 'COMPLETED', finalAssignment?.status);

    const notificationCount = await personnelNotificationRepository.unreadCount(personnel.personnel_id);
    check('personnel received notifications', notificationCount >= 1, String(notificationCount));
  } finally {
    await cleanup(ctx);
  }

  console.log(`\n${assertions - failures.length}/${assertions} checks passed`);
  if (failures.length) {
    console.log('Failures:');
    for (const failure of failures) console.log(`  - ${failure}`);
  }
  process.exit(failures.length ? 1 : 0);
};

main().catch((error) => {
  console.error('\n[VERIFY] Unexpected error:', error);
  process.exit(1);
});

// Referenced so the module graph is explicit: the evidence repository is used
// through the service, but importing it keeps the schema dependency visible.
void personnelEvidenceRepository;

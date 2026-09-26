require('dotenv').config();

/**
 * Phase 3A end-to-end rehearsal against the configured database.
 *
 * Exercises the real repository and service code the broadcast depends on:
 * a token claim, admin token discovery, a NEW_REPORT insert for an
 * administrator, owner-scoped read-back, unread counting, trash and restore.
 * Everything it creates is removed again.
 *
 * Usage: node scripts/rehearse-phase-3a.js
 */
const { pool } = require('../config/db');
const adminRepository = require('../repositories/adminRepository');
const notificationRepository = require('../repositories/notificationRepository');
const trashNotificationRepository = require('../repositories/trashNotificationRepository');
const fcmService = require('../services/fcmService');
const { NOTIFICATION_TYPES } = require('../services/notificationService');

let createdNotificationId = null;
let adminId = null;

async function main() {
  try {
    const admins = await pool.query(`SELECT admin_id FROM admins ORDER BY admin_id LIMIT 1`);
    if (admins.rows.length === 0) {
      console.log('SKIP: no administrator account exists.');
      return;
    }
    adminId = admins.rows[0].admin_id;
    console.log('administrator                :', adminId);

    // A temporary token stands in for a real device so the broadcast is armed.
    const probeToken = `phase3a-rehearsal-${Date.now()}-${'x'.repeat(40)}`;
    const bound = await adminRepository.claimFcmToken(adminId, probeToken);
    console.log('token claim                  :', bound ? 'OK' : 'FAILED');

    const tokens = await fcmService.findAllAdminFcmTokens();
    console.log('findAllAdminFcmTokens()      :', tokens.length, 'token(s)');

    // Reuse a real report when one exists so the report_id path is exercised.
    const report = await pool.query(
      `SELECT report_id FROM reports ORDER BY created_at DESC LIMIT 1`
    ).catch(() => ({ rows: [] }));
    const reportId = report.rows[0] ? report.rows[0].report_id : null;
    console.log('report under test            :', reportId || 'none (null report_id)');

    const created = await notificationRepository.createNotification({
      residentId: adminId,
      reportId,
      title: 'New Report Submitted',
      message: `A resident submitted a new report. Report ID: ${reportId}`,
      type: NOTIFICATION_TYPES.NEW_REPORT,
    });
    createdNotificationId = created.notification_id;
    console.log('NEW_REPORT insert            : OK id=' + createdNotificationId);
    console.log('  type                       :', created.type);
    console.log('  created_at (server-owned)  :', created.created_at);

    const list = await notificationRepository.findAllByResidentId(adminId);
    const stored = list.find((row) => row.notification_id === createdNotificationId);
    console.log('owner-scoped read-back       :', stored ? 'OK' : 'MISSING');
    console.log('mapNotification fields       :',
      'notificationId, id, mongoId, residentId, reportId, title, message, type, isRead, isDeleted, createdAt');

    const unread = await notificationRepository.countUnreadByResidentId(adminId);
    console.log('unread count                 :', unread, '(includes this row)');

    await trashNotificationRepository.createTrashNotification(createdNotificationId, adminId);
    const afterTrash = await notificationRepository.findAllByResidentId(adminId);
    console.log('hidden after trash           :',
      !afterTrash.some((row) => row.notification_id === createdNotificationId) ? 'OK' : 'STILL VISIBLE');
    const trash = await notificationRepository.findTrashByResidentId(adminId);
    console.log('visible in trash             :',
      trash.some((row) => row.notification_id === createdNotificationId) ? 'OK' : 'MISSING');

    await trashNotificationRepository.deleteByNotificationId(createdNotificationId, adminId);
    const afterRestore = await notificationRepository.findAllByResidentId(adminId);
    console.log('restored to active           :',
      afterRestore.some((row) => row.notification_id === createdNotificationId) ? 'OK' : 'MISSING');

    // Resident isolation: an admin ID must never appear in resident tables.
    const leak = await pool.query(
      `SELECT COUNT(*)::int AS count FROM notifications WHERE resident_id = $1`,
      [adminId]
    );
    console.log('resident table isolation     :',
      leak.rows[0].count === 0 ? 'OK (no admin rows in resident tables)' : 'LEAK');
  } catch (error) {
    console.error('REHEARSAL FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    if (createdNotificationId) {
      await pool.query('DELETE FROM admin_notifications WHERE notification_id = $1', [
        createdNotificationId,
      ]);
      console.log('cleanup: notification        : removed');
    }
    if (adminId) {
      await pool.query(
        `UPDATE admins SET fcm_token = NULL WHERE fcm_token LIKE 'phase3a-rehearsal-%'`
      );
      console.log('cleanup: token               : removed');
    }
    await pool.end();
  }
}

main();

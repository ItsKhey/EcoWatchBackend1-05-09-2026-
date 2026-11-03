require('dotenv').config();

const reportRepository =
  require('../../src/modules/reports/reportRepository');

const notificationRepository =
  require('../../src/modules/notifications/notificationRepository');

const historyRepository =
  require('../../src/modules/history/historyRepository');

const { pool } = require('../../src/config/db');

async function test() {
  try {
    console.log('\n========================================');
    console.log('   ECOWATCH REPOSITORY TEST');
    console.log('========================================\n');

    // --------------------------------------------------
    // REPORTS
    // --------------------------------------------------

    console.log('=== REPORT REPOSITORY ===');

    const reports = await reportRepository.findAll();

    console.log(`Reports found: ${reports.length}`);

    if (reports.length > 0) {
      const report = reports[0];

      console.log(`Report ID: ${report.report_id}`);
      console.log(`Resident ID: ${report.resident_id}`);

      const reportById =
        await reportRepository.findByReportId(report.report_id);

      console.log(
        `findByReportId(): ${reportById ? 'PASS' : 'FAIL'}`
      );

      const residentReports =
        await reportRepository.findByResidentId(
          report.resident_id
        );

      console.log(
        `findByResidentId(): ${residentReports.length} result(s)`
      );
    }

    // --------------------------------------------------
    // NOTIFICATIONS
    // --------------------------------------------------

    console.log('\n=== NOTIFICATION REPOSITORY ===');

    const notificationCountResult = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM notifications
    `);

    const notificationCount =
      notificationCountResult.rows[0].count;

    console.log(
      `Notifications in database: ${notificationCount}`
    );

    if (notificationCount > 0) {
      const notificationResult = await pool.query(`
        SELECT *
        FROM notifications
        ORDER BY created_at DESC
        LIMIT 1
      `);

      const notification = notificationResult.rows[0];

      const notifications =
        await notificationRepository.findAllByResidentId(
          notification.resident_id
        );

      console.log(
        `findAllByResidentId(): ${notifications.length} result(s)`
      );

      const notificationById =
        await notificationRepository.findById(
          notification.id
        );

      console.log(
        `findById(): ${
          notificationById ? 'PASS' : 'FAIL'
        }`
      );
    } else {
      console.log(
        'No notification data available — read operations skipped.'
      );
    }

    // --------------------------------------------------
    // HISTORY
    // --------------------------------------------------

    console.log('\n=== HISTORY REPOSITORY ===');

    const histories =
      await historyRepository.findAll();

    console.log(`History records found: ${histories.length}`);

    if (histories.length > 0) {
      const history = histories[0];

      console.log(`History ID: ${history.id}`);
      console.log(`Report ID: ${history.report_id}`);
      console.log(`Action: ${history.action}`);

      const reportHistory =
        await historyRepository.findByReportId(
          history.report_id
        );

      console.log(
        `findByReportId(): ${reportHistory.length} result(s)`
      );

      const residentHistory =
        await historyRepository.findByResidentId(
          history.resident_id
        );

      console.log(
        `findByResidentId(): ${residentHistory.length} result(s)`
      );
    } else {
      console.log(
        'No history data currently exists.'
      );
    }

    console.log('\n========================================');
    console.log('   REPOSITORY TEST COMPLETE');
    console.log('========================================\n');

  } catch (error) {
    console.error('\n========================================');
    console.error('   REPOSITORY TEST FAILED');
    console.error('========================================\n');

    console.error(error);

    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

test();

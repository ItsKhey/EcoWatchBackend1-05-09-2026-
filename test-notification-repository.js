require('dotenv').config();

const notificationRepository =
  require('./repositories/notificationRepository');

async function test() {
  try {
    console.log('\n=== NOTIFICATION REPOSITORY TEST ===\n');

    console.log('1. Testing findAllByResidentId()...');

    /*
     * We need a real resident_id from the notifications table.
     * Get one directly through the repository test query.
     */
    const { pool } = require('./config/db');

    const residentResult = await pool.query(`
      SELECT resident_id
      FROM notifications
      WHERE resident_id IS NOT NULL
      LIMIT 1
    `);

    if (residentResult.rows.length === 0) {
      console.log('No notifications currently exist.');
      console.log('Read repository methods cannot be tested with data yet.');
      await pool.end();
      return;
    }

    const residentId = residentResult.rows[0].resident_id;

    console.log(`Testing resident: ${residentId}`);

    const notifications =
      await notificationRepository.findAllByResidentId(residentId);

    console.log(
      `Found ${notifications.length} notification(s).`
    );

    if (notifications.length > 0) {
      console.log('\nFirst notification:');
      console.dir(notifications[0], { depth: null });

      const notificationId = notifications[0].id;

      console.log(
        `\n2. Testing findById(${notificationId})...`
      );

      const notification =
        await notificationRepository.findById(notificationId);

      console.dir(notification, { depth: null });

      if (notification) {
        console.log('\n✓ findById() successful');
      } else {
        console.log('\n✗ findById() returned null');
      }
    }

    console.log('\n=== TEST COMPLETE ===');

  } catch (error) {
    console.error('\n=== NOTIFICATION REPOSITORY TEST FAILED ===');
    console.error(error);
    process.exitCode = 1;
  }
}

test();

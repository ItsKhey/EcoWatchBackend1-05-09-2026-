require('dotenv').config();

const archivedReportRepository =
  require('./repositories/archivedReportRepository');

const trashReportRepository =
  require('./repositories/trashReportRepository');

const { pool } = require('./config/db');

async function test() {
  try {
    console.log('\n========================================');
    console.log(' ARCHIVE/TRASH REPOSITORY TEST');
    console.log('========================================\n');

    console.log('=== ARCHIVED REPORTS ===');

    const archived =
      await archivedReportRepository.findByResidentId(
        'RES-QOX9TDHK'
      );

    console.log(
      `Archived reports for RES-QOX9TDHK: ${archived.length}`
    );

    console.log('\n=== TRASH REPORTS ===');

    const trash =
      await trashReportRepository.findByResidentId(
        'RES-QOX9TDHK'
      );

    console.log(
      `Trash reports for RES-QOX9TDHK: ${trash.length}`
    );

    console.log('\n========================================');
    console.log(' TEST COMPLETE');
    console.log('========================================\n');

  } catch (error) {
    console.error('\nTEST FAILED');
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

test();

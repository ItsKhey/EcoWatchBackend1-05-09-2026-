require('dotenv').config();

const reportRepository = require('./repositories/reportRepository');

async function test() {
  try {
    console.log('\n=== REPORT REPOSITORY TEST ===\n');

    console.log('1. Testing findAll()...');

    const reports = await reportRepository.findAll();

    console.log(`Found ${reports.length} report(s).`);

    if (reports.length > 0) {
      console.log('\nFirst report:');
      console.dir(reports[0], { depth: null });

      const reportId = reports[0].report_id;

      console.log(`\n2. Testing findByReportId("${reportId}")...`);

      const report = await reportRepository.findByReportId(reportId);

      console.dir(report, { depth: null });

      if (report) {
        console.log('\n✓ findByReportId() successful');
      } else {
        console.log('\n✗ findByReportId() returned null');
      }

      console.log(
        `\n3. Testing findByResidentId("${report.resident_id}")...`
      );

      const residentReports =
        await reportRepository.findByResidentId(report.resident_id);

      console.log(
        `Found ${residentReports.length} report(s) for resident ${report.resident_id}.`
      );
    } else {
      console.log('\nNo reports currently exist in the reports table.');
      console.log('findAll() itself executed successfully.');
    }

    console.log('\n=== TEST COMPLETE ===');

  } catch (error) {
    console.error('\n=== REPORT REPOSITORY TEST FAILED ===');
    console.error(error);
    process.exitCode = 1;
  }
}

test();

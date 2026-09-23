const cron = require('node-cron');
const trashReportRepository = require('../repositories/trashReportRepository');

const permanentlyDeleteExpiredReports = async () => {
  const expirationDate = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000
  );

  const deletedReports =
    await trashReportRepository.deleteExpired(expirationDate);

  if (deletedReports.length > 0) {
    console.log(
      `[CLEANUP] Permanently deleted ${deletedReports.length} expired report(s)`
    );
  }
};

const startReportCleanupJob = () => {
  // Run every day at 2:00 AM
  cron.schedule('0 2 * * *', () => {
    permanentlyDeleteExpiredReports().catch((error) => {
      console.error(
        `[CLEANUP] Failed to delete expired reports: ${error.message}`
      );
    });
  });
};

module.exports = {
  startReportCleanupJob,
};
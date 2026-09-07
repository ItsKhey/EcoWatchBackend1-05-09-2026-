const cron = require('node-cron');
const Report = require('../models/Report');

const permanentlyDeleteExpiredReports = async () => {
  const expirationDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const result = await Report.deleteMany({
    isDeleted: true,
    deletedAt: { $lt: expirationDate },
  });

  if (result.deletedCount > 0) {
    console.log(`[CLEANUP] Permanently deleted ${result.deletedCount} expired report(s)`);
  }
};

const startReportCleanupJob = () => {
  cron.schedule('0 2 * * *', () => {
    permanentlyDeleteExpiredReports().catch((error) => {
      console.error(`[CLEANUP] Failed to delete expired reports: ${error.message}`);
    });
  });
};

module.exports = { startReportCleanupJob, permanentlyDeleteExpiredReports };
const cron = require('node-cron');
const { withTransaction } = require('../config/db');
const historyRepository = require('../repositories/historyRepository');

const permanentlyDeleteExpiredReports = async () => {
  const expirationDate = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000
  );

  return withTransaction(async (client) => {
    const markerResult = await client.query(
      `
      SELECT report_id, resident_id
      FROM trash_reports
      WHERE deleted_at < $1
      ORDER BY report_id
      FOR UPDATE
      `,
      [expirationDate]
    );
    const markers = markerResult.rows;
    if (markers.length === 0) return [];

    const reportIds = [...new Set(markers.map((row) => row.report_id))];
    const reportResult = await client.query(
      `
      SELECT report_id, resident_id, title, status
      FROM reports
      WHERE report_id = ANY($1::varchar[])
      FOR UPDATE
      `,
      [reportIds]
    );
    const reportsById = new Map(
      reportResult.rows.map((row) => [row.report_id, row])
    );

    // Deleting the active report row invokes the personnel FK's
    // ON DELETE SET NULL behavior. Explicitly clear the marker rows in the
    // same transaction so an expired report cannot leave an orphaned trash
    // record or a busy personnel account behind.
    await client.query(
      `
      DELETE FROM reports
      WHERE report_id = ANY($1::varchar[])
      `,
      [reportIds]
    );
    await client.query(
      `
      DELETE FROM trash_reports
      WHERE report_id = ANY($1::varchar[])
      `,
      [reportIds]
    );
    await client.query(
      `
      DELETE FROM archived_reports
      WHERE report_id = ANY($1::varchar[])
      `,
      [reportIds]
    );

    for (const marker of markers) {
      const report = reportsById.get(marker.report_id);
      await historyRepository.createHistory(
        {
          residentId: marker.resident_id || report?.resident_id,
          reportId: marker.report_id,
          action: 'PERMANENTLY_DELETED',
          oldStatus: report?.status || null,
          newStatus: 'Permanently Deleted',
          description: `Report '${report?.title || marker.report_id}' permanently removed by trash expiration.`,
        },
        client
      );
    }

    return markers;
  });
};

const startReportCleanupJob = () => {
  // Run every day at 2:00 AM
  cron.schedule('0 2 * * *', () => {
    permanentlyDeleteExpiredReports().then((deletedReports) => {
      if (deletedReports.length > 0) {
        console.log(
          `[CLEANUP] Permanently deleted ${deletedReports.length} expired report(s)`
        );
      }
    }).catch((error) => {
      console.error(
        `[CLEANUP] Failed to delete expired reports: ${error.message}`
      );
    });
  });
};

module.exports = {
  permanentlyDeleteExpiredReports,
  startReportCleanupJob,
};

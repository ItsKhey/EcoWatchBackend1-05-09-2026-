const cron = require('node-cron');
const announcementRepository = require('../repositories/announcementRepository');

/**
 * Permanently deletes announcements whose administrator-chosen deadline has
 * passed.
 *
 * <p>Resident and administrator reads already hide expired rows, so this job is
 * not what enforces the deadline; it is what stops the table from growing
 * without bound. That distinction matters: a row stops being delivered the
 * instant it lapses whether or not this runs, and this is what eventually
 * reclaims it.
 *
 * <p>The delete is unconditional, not filtered by priority. An IMPORTANT
 * announcement follows the same window the administrator picked, so an emergency
 * notice is not silently kept alive by a flag the sender may have set without
 * thinking.
 */
const deleteExpiredAnnouncements = async () => {
  const expired = await announcementRepository.findExpired();
  if (expired.length === 0) return [];

  // Re-check in the DELETE itself rather than trusting the SELECT above: a row
  // could have been republished or given a new deadline in between, and deleting
  // on a stale read would remove a live announcement.
  const deletedCount = await announcementRepository.deleteExpired();

  return { deleted: deletedCount, skipped: expired.length - deletedCount };
};

/**
 * Starts the nightly expiry sweep.
 *
 * <p>Runs at 03:00, offset from the 00:00 history job and the 02:00 report job
 * so the three cleanups do not compete for the same connection burst.
 */
const startAnnouncementCleanupJob = () => {
  cron.schedule('0 3 * * *', () => {
    deleteExpiredAnnouncements()
      .then(({ deleted }) => {
        if (deleted > 0) {
          console.log(`[CLEANUP] Permanently deleted ${deleted} expired announcement(s)`);
        }
      })
      .catch((error) => {
        // A failed sweep is not fatal: expiry is already enforced on read, so
        // the next run simply tries again.
        console.error(
          `[CLEANUP] Failed to delete expired announcements: ${error.message}`
        );
      });
  });
};

module.exports = {
  deleteExpiredAnnouncements,
  startAnnouncementCleanupJob,
};

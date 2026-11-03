const cron = require('node-cron');
const residentRepository = require('./residentRepository');
const historyRepository = require('../history/historyRepository');
const { CATEGORY, SUBJECT_TYPE } = require('../../shared/historyActions');
const { logError, logInfo } = require('../../shared/logger');

/**
 * Retention for administrator-disabled reporter accounts.
 *
 * ---------------------------------------------------------------------------
 * What expires, and what deliberately does not
 * ---------------------------------------------------------------------------
 * Only an account an ADMINISTRATOR disabled is purged, and the discriminator is
 * `disabled_by_resident = false` rather than the status. A resident who paused
 * their own account carries the same DISABLED status, but that pause is
 * explicitly reversible and they are entitled to come back at any time; deleting
 * those on a timer would quietly break the promise /api/auth/disable-account
 * makes in its own response. The repository filter encodes this, so the job
 * cannot be pointed at self-paused accounts by a mistake here.
 *
 * ---------------------------------------------------------------------------
 * Why 30 days
 * ---------------------------------------------------------------------------
 * The same window the trashed-report cleanup already uses, so "discarded data is
 * kept for a month" is one rule in this codebase rather than two. It is long
 * enough for an administrator to reverse a mistaken disable, which is why
 * re-enable exists, and short enough that the retained personal data of someone
 * who never returns is not kept indefinitely.
 *
 * The clock starts at `disabled_at`, not `updated_at`: a later profile edit must
 * not keep an abandoned account alive forever.
 */
const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Permanently deletes every reporter account an administrator disabled more than
 * the retention window ago.
 *
 * Reuses the resident repository's own cascade, so an expired account is removed
 * exactly like a self-service DELETE /api/auth/account: every report it owns in
 * the active, archived and trashed collections, its notifications, and its
 * Cloudinary photos. Writing the removal here instead would eventually drift
 * from that one.
 *
 * One account failing does not abandon the rest. Each delete is its own
 * transaction inside the shared helper, so a failure is reported and the job
 * moves on rather than stopping at the first bad row forever.
 *
 * @returns {Promise<{purged: string[], failed: Array<{id: string, error: string}>}>}
 */
const permanentlyDeleteExpiredResidentAccounts = async () => {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  const expired = await residentRepository.findExpiredDisabledResidents(cutoff);

  const purged = [];
  const failed = [];

  for (const account of expired) {
    const residentId = account.resident_id;

    try {
      const deletedId = await residentRepository.deleteResidentAccount(residentId);
      if (!deletedId) {
        // Another request deleted it between the scan and here. Nothing to do.
        continue;
      }

      purged.push(residentId);

      /*
       * Written AFTER the delete, because the cascade removes the account's own
       * history rows and there is no foreign key from report_histories to
       * residents, so a row naming a deleted resident is accepted and is the only
       * remaining trace of the decision.
       *
       * Filed with no adminId: this ran on a schedule, and the absence of an
       * actor is what distinguishes an expiry from a decision somebody made.
       */
      await historyRepository.createHistory({
        action: 'RESIDENT_ACCOUNT_PURGED',
        category: CATEGORY.ACCOUNT,
        subjectType: SUBJECT_TYPE.RESIDENT,
        subjectId: residentId,
        adminId: null,
        oldStatus: 'DISABLED',
        newStatus: 'Permanently Deleted',
        description: `Reporter account permanently removed after ${RETENTION_DAYS} days disabled by an administrator. `
          + 'The profile, reports, history and notifications were deleted.',
      });

      logInfo(
        null,
        'RESIDENT_PURGE',
        `Purged reporter account ${residentId} (disabled since ${account.disabled_at?.toISOString?.() || account.disabled_at})`
      );
    } catch (error) {
      failed.push({ id: residentId, error: error.message });
      logError(
        null,
        'RESIDENT_PURGE',
        `Reporter account ${residentId} was past its retention window but could not be deleted: ${error.message}`
      );
    }
  }

  return { purged, failed };
};

const startResidentPurgeJob = () => {
  // Unlike the other cleanups, this one is irreversible, so it ships with an
  // off switch. A deployment that should not be expiring resident data sets
  // RESIDENT_PURGE_DISABLED=true and the job simply never starts.
  if (String(process.env.RESIDENT_PURGE_DISABLED || '').toLowerCase() === 'true') {
    logInfo(null, 'RESIDENT_PURGE', 'retention job disabled by RESIDENT_PURGE_DISABLED');
    return;
  }

  // Daily at 4:00 AM. An hour clear of the report (2:00 AM) and announcement
  // (3:00 AM) cleanups, so the three jobs never contend for the same rows or the
  // same connections at once.
  cron.schedule('0 4 * * *', () => {
    permanentlyDeleteExpiredResidentAccounts()
      .then(({ purged, failed }) => {
        if (purged.length > 0) {
          console.log(
            `[CLEANUP] Permanently deleted ${purged.length} expired reporter account(s)`
          );
        }
        if (failed.length > 0) {
          console.error(
            `[CLEANUP] ${failed.length} expired reporter account(s) could not be deleted and will be retried tomorrow`
          );
        }
      })
      .catch((error) => {
        console.error(
          `[CLEANUP] Failed to delete expired reporter accounts: ${error.message}`
        );
      });
  });
};

module.exports = {
  RETENTION_DAYS,
  permanentlyDeleteExpiredResidentAccounts,
  startResidentPurgeJob,
};
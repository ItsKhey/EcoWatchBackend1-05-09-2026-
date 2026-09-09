const cron = require('node-cron');
const History = require('../models/History');
const TrashHistory = require('../models/TrashHistory');
const Notification = require('../models/Notification');
const TrashNotification = require('../models/TrashNotification');

const startHistoryCleanupJob = () => {
    // Run every day at midnight
    cron.schedule('0 0 * * *', async () => {
        console.log('[CLEANUP] Running 30-day cleanup for History and Notifications...');
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        try {
            // 1. Permanent delete from TrashHistory
            const deletedHistory = await TrashHistory.deleteMany({ deletedAt: { $lte: thirtyDaysAgo } });
            console.log(`[CLEANUP] Permanently deleted ${deletedHistory.deletedCount} history items from trash.`);

            // 2. Permanent delete from TrashNotification
            const deletedNotifs = await TrashNotification.deleteMany({ deletedAt: { $lte: thirtyDaysAgo } });
            console.log(`[CLEANUP] Permanently deleted ${deletedNotifs.deletedCount} notifications from trash.`);

        } catch (err) {
            console.error('[CLEANUP] Error during history cleanup:', err);
        }
    });
};

module.exports = { startHistoryCleanupJob };

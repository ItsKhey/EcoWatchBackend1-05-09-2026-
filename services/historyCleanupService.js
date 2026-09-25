const cron = require('node-cron');
const { pool, withTransaction } = require('../config/db');

const startHistoryCleanupJob = () => {
    // Run every day at midnight
    cron.schedule('0 0 * * *', async () => {
        console.log('[CLEANUP] Running 30-day cleanup for History and Notifications...');

        const thirtyDaysAgo = new Date(
            Date.now() - 30 * 24 * 60 * 60 * 1000
        );

        try {
            // 1. Permanently delete soft-deleted report histories
            const deletedHistory = await pool.query(
                `
                DELETE FROM report_histories
                WHERE is_deleted = true
                  AND deleted_at <= $1
                RETURNING id
                `,
                [thirtyDaysAgo]
            );

            console.log(
                `[CLEANUP] Permanently deleted ${deletedHistory.rowCount} history items from trash.`
            );

            // 2. Permanently delete notifications from trash
            const deletedNotifCount = await withTransaction(async (client) => {
                const expired = await client.query(
                    `
                    DELETE FROM trash_notifications
                    WHERE deleted_at <= $1
                    RETURNING notification_id, resident_id
                    `,
                    [thirtyDaysAgo]
                );
                if (expired.rowCount === 0) return 0;

                // Delete the durable row in the same transaction. Deleting only
                // the marker would make the original notification reappear.
                await client.query(
                    `
                    DELETE FROM notifications AS n
                    USING expired AS e
                    WHERE n.notification_id = e.notification_id
                      AND n.resident_id = e.resident_id
                    `,
                );
                return expired.rowCount;
            });

            console.log(
                `[CLEANUP] Permanently deleted ${deletedNotifCount} notifications from trash.`
            );

        } catch (err) {
            console.error('[CLEANUP] Error during history cleanup:', err);
        }
    });
};

module.exports = { startHistoryCleanupJob };
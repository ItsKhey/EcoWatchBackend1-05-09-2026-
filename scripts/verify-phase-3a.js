require('dotenv').config();

/**
 * Phase 3A — read-only verification of the administrator push path.
 *
 * Confirms the routes are registered, the admin FCM token column exists, and
 * how many admin devices are currently eligible to receive a NEW_REPORT
 * broadcast. Sends nothing.
 */
const { pool } = require('../config/db');
const adminRoutes = require('../routes/adminRoutes');
const notificationRoutes = require('../routes/notificationRoutes');
const { findAllAdminFcmTokens } = require('../services/fcmService');
const { isFirebaseConfigured } = require('../services/fcmService');

const routePaths = (router) => {
  const paths = [];
  const walk = (stack, prefix = '') => {
    for (const layer of stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods || {}).map((m) => m.toUpperCase());
        methods.forEach((method) => paths.push(`${method} ${prefix}${layer.route.path}`));
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const source = layer.regexp?.source || '';
        const match = source.match(/^\^\\\/(.*?)\\\//);
        walk(layer.handle.stack, match ? `/${match[1]}` : prefix);
      }
    }
  };
  walk(router.stack);
  return paths;
};

async function main() {
  const admin = routePaths(adminRoutes);
  const notifications = routePaths(notificationRoutes);

  console.log('\n=== Phase 3A verification ===\n');
  console.log('Firebase configured      :', isFirebaseConfigured());
  console.log('POST   /admin/fcm-token  :', admin.includes('POST /fcm-token') ? 'REGISTERED' : 'MISSING');
  console.log('DELETE /admin/fcm-token  :', admin.includes('DELETE /fcm-token') ? 'REGISTERED' : 'MISSING');

  const ownerScoped = ['GET /my-notifications', 'GET /trash', 'GET /unread-count', 'PATCH /mark-as-read'];
  ownerScoped.forEach((route) => {
    console.log(`notifications ${route.padEnd(24)}:`, notifications.includes(route) ? 'OWNER-SCOPED' : 'MISSING');
  });

  try {
    const column = await pool.query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'admins'
          AND column_name = 'fcm_token'`
    );
    console.log('\nadmins.fcm_token column :', column.rows.length ? 'PRESENT' : 'MISSING — run migrate:admin-fcm-token');

    const bound = await pool.query(
      `SELECT COUNT(*)::int AS total, COUNT(fcm_token)::int AS with_token FROM admins`
    );
    console.log(`admins total / bound     : ${bound.rows[0].total} / ${bound.rows[0].with_token}`);

    const tokens = await findAllAdminFcmTokens();
    console.log(`eligible broadcast tokens: ${tokens.length}`);
    console.log(tokens.length === 0
      ? '  -> NEW_REPORT broadcasts are currently a no-op until an admin logs in on a device.'
      : '  -> broadcast is armed.');
  } catch (error) {
    console.error('\nDatabase check failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();

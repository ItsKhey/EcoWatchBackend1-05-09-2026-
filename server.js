const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');
dns.setServers(['1.1.1.1', '1.0.0.1']);

const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const { logger } = require('./src/shared/logger');
const { notFound, errorHandler } = require('./src/middleware/errorMiddleware');
const { startHistoryCleanupJob } = require('./src/modules/history/historyCleanupService');
const { startReportCleanupJob } = require('./src/modules/reports/reportCleanupService');
const { startAnnouncementCleanupJob } = require('./src/modules/announcements/announcementCleanupService');
const { startResidentPurgeJob } = require('./src/modules/residents/residentPurgeService');
const { isFirebaseConfigured } = require('./src/shared/fcmService');
const { isFirebaseAuthConfigured } = require('./src/config/firebaseAdmin');
const { isLocalHost } = require('./src/config/db');
const { provider } = require('./src/shared/cloudinaryService');

dotenv.config();

if (!process.env.JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET is not configured.');
  process.exit(1);
}

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

app.use(logger);

// Report and profile photos written by the local image storage provider.
//
// These are site relative URLs, so the same database works whether the apps are
// pointed at this server or at a hosted deployment. Serving them from here is
// what keeps a local PostgreSQL + local server setup free of any third party
// CDN in the request path.
//
// express.static resolves inside the folder and refuses dotfiles, so nothing
// above uploads/ is reachable through this route.
//
// Uploaded names are content-unique, so a given URL never changes what it
// points at. That is what makes a long immutable cache safe: the client's image
// loader keeps a copy and never asks again, which is what removes the wait when
// a list scrolls back into view.
const UPLOADS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

app.use(
  '/uploads',
  express.static(path.resolve(__dirname, 'uploads'), {
    maxAge: UPLOADS_MAX_AGE_MS,
    immutable: true,
    // Lets a client loaded over http:// read a file that was written by a
    // different host name, which is the case when a LAN build and an emulator
    // build share one database.
    crossOriginResourcePolicy: 'cross-origin'
  })
);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'UP',
    database: 'CONNECTED',
    databaseTarget: isLocalHost ? 'LOCAL_POSTGRES' : 'REMOTE_POSTGRES',
    imageStorage: provider === 'cloudinary' ? 'CLOUDINARY' : 'LOCAL_DISK',
    pushNotifications: isFirebaseConfigured() ? 'CONFIGURED' : 'NOT_CONFIGURED',
    // Shares the same service account as FCM. Reported separately because the
    // registration and reset flows degrade to 503 without it while login,
    // reports and notifications keep working.
    emailVerification: isFirebaseAuthConfigured() ? 'CONFIGURED' : 'NOT_CONFIGURED',
    timestamp: new Date().toISOString()
  });
});

// Routes
app.use('/api/auth', require('./src/modules/auth/authRoutes'));
app.use('/api/reports', require('./src/modules/reports/reportRoutes'));
app.use('/api/history', require('./src/modules/history/historyRoutes'));
app.use('/api/notifications', require('./src/modules/notifications/notificationRoutes'));
app.use('/api/admin', require('./src/modules/admin/adminRoutes'));
app.use('/api/personnel', require('./src/modules/personnel/personnelRoutes'));
app.use('/api/vehicles', require('./src/modules/vehicles/vehicleRoutes'));
app.use('/api/announcements', require('./src/modules/announcements/announcementRoutes'));

app.use(notFound);
app.use(errorHandler);

startHistoryCleanupJob();
startReportCleanupJob();
startAnnouncementCleanupJob();
startResidentPurgeJob();
const PORT = process.env.PORT || 5000;
// 0.0.0.0 by default so a phone on the same WiFi can reach the server. The
// Android emulator reaches it through 10.0.2.2, which forwards to loopback.
const HOST = process.env.HOST || '0.0.0.0';

/**
 * Prints the addresses a phone on this network can actually use.
 *
 * A machine with several adapters (WiFi plus Ethernet, or a VPN) has several
 * addresses, and only the one on the same network as the phone is reachable from
 * it. 0.0.0.0 is what the server binds to, which is not something anyone can
 * type into a phone, so the concrete addresses are listed instead.
 *
 * This exists because the address changes whenever the laptop joins a different
 * network, and reading it off the screen is faster and far less error prone than
 * remembering an ipconfig command while holding a phone.
 */
const listReachableAddresses = () => {
  const os = require('os');
  const addresses = [];

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      // IPv4 only: a phone cannot practically use the others over the local
      // network, and a link-local address is not routable.
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      addresses.push(entry.address);
    }
  }

  return [...new Set(addresses)];
};

app.listen(PORT, HOST, () => {
  console.log(`[SERVER] Running in ${process.env.NODE_ENV} mode on port ${PORT}`);
  console.log(`[SERVER] Listening on http://${HOST}:${PORT}`);

  const addresses = listReachableAddresses();
  console.log('');
  console.log('[SERVER] Point the apps at one of these (must be the same network as the phone):');
  for (const address of addresses) {
    console.log(`[SERVER]   http://${address}:${PORT}/api/`);
  }
  if (addresses.length === 0) {
    console.log('[SERVER]   (none found - is this machine connected to WiFi or Ethernet?)');
  }
  console.log('');
  console.log(`[SERVER] Emulator builds use http://10.0.2.2:${PORT}/api/ instead.`);
  console.log('[SERVER] Health check: /api/health');
});

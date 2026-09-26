const {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const residentRepository = require('../repositories/residentRepository');
const adminRepository = require('../repositories/adminRepository');
const { logInfo, logError } = require('../utils/logger');

/** Admin-facing channel and click action; must match the Admin app manifest. */
const ADMIN_CHANNEL_ID = 'ecowatch_admin_notifications';
const ADMIN_CLICK_ACTION = 'com.example.ecowatchadmin1.action.OPEN_NOTIFICATION';

let firebaseApp;

function parseServiceAccountJson() {
  const normalize = (serviceAccount) => {
    if (typeof serviceAccount?.private_key === 'string') {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    return serviceAccount;
  };

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return normalize(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    return normalize(JSON.parse(
      Buffer.from(
        process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
        'base64'
      ).toString('utf8')
    ));
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey };
  }

  return null;
}

function isFirebaseConfigured() {
  try {
    return Boolean(
      parseServiceAccountJson()
      || process.env.GOOGLE_APPLICATION_CREDENTIALS
      || process.env.GOOGLE_CLOUD_PROJECT
    );
  } catch (error) {
    return false;
  }
}

function getFirebaseApp() {
  if (firebaseApp) return firebaseApp;
  if (getApps().length > 0) {
    [firebaseApp] = getApps();
    return firebaseApp;
  }

  const serviceAccount = parseServiceAccountJson();
  if (serviceAccount) {
    firebaseApp = initializeApp({ credential: cert(serviceAccount) });
  } else if (
    process.env.GOOGLE_APPLICATION_CREDENTIALS
    || process.env.GOOGLE_CLOUD_PROJECT
  ) {
    firebaseApp = initializeApp({ credential: applicationDefault() });
  } else {
    const error = new Error(
      'Firebase Admin is not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON or the FIREBASE_* credential variables.'
    );
    error.code = 'FCM_NOT_CONFIGURED';
    throw error;
  }

  return firebaseApp;
}

async function sendResidentReportNotification({
  residentId,
  notificationId,
  reportId,
  type,
  title,
  message,
  createdAt,
}) {
  const token = await residentRepository.findFcmTokenByResidentId(residentId);
  if (!token) {
    return { skipped: true, reason: 'NO_TOKEN' };
  }

  let messaging;
  try {
    messaging = getMessaging(getFirebaseApp());
  } catch (error) {
    if (error.code === 'FCM_NOT_CONFIGURED') {
      return { skipped: true, reason: 'NOT_CONFIGURED' };
    }
    throw error;
  }

  try {
    const messageId = await messaging.send({
      token,
      // Foreground messages are rendered by the app's channel. When the app
      // is backgrounded, the notification payload provides a reliable OS
      // fallback while data preserves exact report deep-link values.
      notification: { title, body: message },
      data: {
        notificationId: String(notificationId),
        reportId: reportId ? String(reportId) : '',
        type: String(type),
        title: String(title),
        message: String(message),
        createdAt: String(createdAt || new Date().toISOString()),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'ecowatch_notifications',
          clickAction: 'com.example.myecowatch1.action.OPEN_NOTIFICATION',
        },
      },
    });

    return { delivered: true, messageId };
  } catch (error) {
    const code = String(error?.code || '');
    if (
      code === 'messaging/registration-token-not-registered'
      || code === 'messaging/invalid-registration-token'
    ) {
      await residentRepository.clearFcmToken(residentId, token);
      return { delivered: false, reason: 'INVALID_TOKEN', error: code };
    }
    throw error;
  }
}

/**
 * Phase 3A — every administrator device currently able to receive a broadcast.
 * Exposed so route/verification tooling can assert delivery reachability
 * without sending a message.
 */
async function findAllAdminFcmTokens() {
  const rows = await adminRepository.findAllFcmTokens();
  return rows.map((row) => row.token);
}

/**
 * Phase 3A — broadcasts a resident report submission to every administrator.
 *
 * Uses sendEachForMulticast so a single unregistered device never blocks the
 * rest, and reports per-token outcomes (delivered, failed, error codes) so the
 * broadcast can be audited from Render logs.
 */
async function sendAdminNewReportNotification({
  notificationId,
  reportId,
  type,
  title,
  message,
  createdAt,
  requestId = null,
}) {
  let tokens;
  try {
    tokens = await findAllAdminFcmTokens();
  } catch (error) {
    logError(requestId, 'FCM_ADMIN_TOKENS', `Unable to read admin tokens: ${error.message}`);
    return { skipped: true, reason: 'TOKEN_LOOKUP_FAILED' };
  }

  logInfo(
    requestId,
    'FCM_ADMIN_BROADCAST',
    `tokenCount=${tokens.length} notificationId=${notificationId} reportId=${reportId} type=${type}`
  );

  if (tokens.length === 0) {
    return { skipped: true, reason: 'NO_TOKENS', tokenCount: 0 };
  }

  let messaging;
  try {
    messaging = getMessaging(getFirebaseApp());
  } catch (error) {
    if (error.code === 'FCM_NOT_CONFIGURED') {
      logError(requestId, 'FCM_ADMIN_BROADCAST', 'Firebase Admin is not configured.');
      return { skipped: true, reason: 'NOT_CONFIGURED', tokenCount: tokens.length };
    }
    throw error;
  }

  const data = {
    notificationId: String(notificationId),
    reportId: reportId ? String(reportId) : '',
    type: String(type),
    title: String(title),
    message: String(message),
    createdAt: String(createdAt || new Date().toISOString()),
  };

  let response;
  try {
    response = await messaging.sendEachForMulticast({
      tokens,
      // Data-only payload: the Admin app renders through its own EcoWatch
      // channel so a single code path covers foreground and background.
      data,
      android: {
        priority: 'high',
        notification: {
          channelId: ADMIN_CHANNEL_ID,
          clickAction: ADMIN_CLICK_ACTION,
        },
      },
    });
  } catch (error) {
    logError(
      requestId,
      'FCM_ADMIN_BROADCAST',
      `Multicast send failed: ${error.code || error.name} ${error.message}`
    );
    return { delivered: false, reason: 'SEND_FAILED', tokenCount: tokens.length };
  }

  const invalid = [];
  const failures = [];
  response.responses.forEach((item, index) => {
    if (item.success) {
      logInfo(
        requestId,
        'FCM_ADMIN_BROADCAST',
        `delivered messageId=${item.messageId} tokenIndex=${index}`
      );
      return;
    }
    const code = item.error?.code || 'UNKNOWN';
    failures.push({ tokenIndex: index, code, message: item.error?.message || '' });
    logError(
      requestId,
      'FCM_ADMIN_BROADCAST',
      `failed tokenIndex=${index} code=${code} message=${item.error?.message || ''}`
    );
    if (
      code === 'messaging/registration-token-not-registered'
      || code === 'messaging/invalid-registration-token'
    ) {
      invalid.push(tokens[index]);
    }
  });

  if (invalid.length > 0) {
    try {
      const cleared = await adminRepository.clearFcmTokenByValue(invalid);
      logInfo(
        requestId,
        'FCM_ADMIN_BROADCAST',
        `pruned ${cleared} unregistered admin token(s)`
      );
    } catch (error) {
      logError(requestId, 'FCM_ADMIN_BROADCAST', `Token prune failed: ${error.message}`);
    }
  }

  return {
    delivered: response.successCount > 0,
    tokenCount: tokens.length,
    successCount: response.successCount,
    failureCount: response.failureCount,
    messageIds: response.responses.filter((item) => item.success).map((item) => item.messageId),
    failures,
  };
}

module.exports = {
  isFirebaseConfigured,
  parseServiceAccountJson,
  sendResidentReportNotification,
  ADMIN_CHANNEL_ID,
  ADMIN_CLICK_ACTION,
  findAllAdminFcmTokens,
  sendAdminNewReportNotification,
};

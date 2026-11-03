const {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const residentRepository = require('../modules/residents/residentRepository');
const adminRepository = require('../modules/admin/adminRepository');
const { logInfo, logError } = require('./logger');

/** Admin-facing channel and click action; must match the Admin app manifest. */
const ADMIN_CHANNEL_ID = 'ecowatch_admin_notifications';
const ADMIN_CLICK_ACTION = 'com.example.ecowatchadmin1.action.OPEN_NOTIFICATION';

/**
 * Resident-facing channel and click action; must match the Resident app
 * manifest and {@code NotificationRepository.CHANNEL_ID}.
 *
 * <p>These were previously inline string literals on the per-resident report
 * send. They are exported now because the announcement broadcast needs the same
 * pair, and two copies of a channel id is how a push ends up silently
 * undeliverable.
 */
const RESIDENT_CHANNEL_ID = 'ecowatch_notifications';
const RESIDENT_CLICK_ACTION = 'com.example.myecowatch1.action.OPEN_NOTIFICATION';

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
          channelId: RESIDENT_CHANNEL_ID,
          clickAction: RESIDENT_CLICK_ACTION,
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

/** Residents are pushed concurrently, but never all at once. */
const RESIDENT_BROADCAST_CONCURRENCY = 20;

/**
 * Wall-clock budget for the whole announcement fan-out.
 *
 * <p>The publish request waits for this, so the budget is what stops a large
 * resident list from pushing the publish past a client or proxy timeout. When
 * it runs out, the remaining residents are reported as unattempted rather than
 * left to hang: the in-app rows are already committed, so the announcement is
 * delivered regardless and the next REST sync reconciles the rest.
 */
const RESIDENT_BROADCAST_DEADLINE_MS = (() => {
  const configured = Number.parseInt(process.env.ANNOUNCEMENT_BROADCAST_DEADLINE_MS, 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 8000;
})();

/**
 * Cap on a single FCM call.
 *
 * <p>Without this one hung request would consume the entire budget and starve
 * every other recipient. The abandoned call is reported as a failure so it shows
 * up in the tally instead of disappearing.
 */
const RESIDENT_SEND_TIMEOUT_MS = 5000;

const withTimeout = (promise, timeoutMs, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} timed out after ${timeoutMs}ms`), {
        code: 'FCM_SEND_TIMEOUT',
      }));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

/**
 * Broadcasts an announcement to resident devices.
 *
 * <p>Deliberately one message per resident rather than a single multicast. Each
 * resident's in-app notification row carries its own notification_id, and the
 * Resident app de-duplicates on that id: sending one shared id would let the
 * device store the push copy and the REST copy of the same announcement as two
 * separate rows in the Alerts list. Per-recipient sends keep the push id and
 * the stored id identical, so a re-delivery is recognised as the same
 * notification.
 *
 * <p>A single unreachable device never blocks the broadcast: each send is
 * isolated, and unregistered tokens are pruned as they are discovered.
 *
 * @param {Array<{residentId: string, token: string, notificationId: number|string}>} recipients
 * @returns {Promise<object>} delivery tally; never throws for a single failure.
 */
async function sendResidentAnnouncementNotification({
  recipients,
  announcementId,
  type,
  title,
  message,
  createdAt,
  requestId = null,
}) {
  const list = Array.isArray(recipients) ? recipients.filter(Boolean) : [];
  if (list.length === 0) {
    return { skipped: true, reason: 'NO_TOKENS', tokenCount: 0 };
  }

  let messaging;
  try {
    messaging = getMessaging(getFirebaseApp());
  } catch (error) {
    if (error.code === 'FCM_NOT_CONFIGURED') {
      logError(requestId, 'FCM_RESIDENT_BROADCAST', 'Firebase Admin is not configured.');
      return { skipped: true, reason: 'NOT_CONFIGURED', tokenCount: list.length };
    }
    throw error;
  }

  const failures = [];
  const invalidTokens = [];
  let successCount = 0;
  let nextIndex = 0;
  let timedOut = false;

  // The budget is measured from the moment the fan-out starts, not from
  // function entry, so a slow token lookup cannot eat into it.
  const deadlineAt = Date.now() + RESIDENT_BROADCAST_DEADLINE_MS;
  logInfo(
    requestId,
    'FCM_RESIDENT_BROADCAST',
    `starting tokenCount=${list.length} concurrency=${Math.min(
      RESIDENT_BROADCAST_CONCURRENCY,
      list.length
    )} budgetMs=${RESIDENT_BROADCAST_DEADLINE_MS}`
  );

  const worker = async () => {
    while (nextIndex < list.length) {
      if (Date.now() >= deadlineAt) {
        timedOut = true;
        return;
      }
      const recipient = list[nextIndex];
      nextIndex += 1;

      try {
        const messageId = await withTimeout(
          messaging.send({
            token: recipient.token,
            // Carries the notification block so Android renders the notice
            // itself when the app is backgrounded, matching the report
            // notifications.
            notification: { title, body: message },
            data: {
              notificationId: String(recipient.notificationId),
              // No report owns an announcement, so this stays empty and the app
              // routes on type instead.
              reportId: '',
              type: String(type),
              title: String(title),
              message: String(message),
              createdAt: String(createdAt || new Date().toISOString()),
              // The resident app uses this to open the Announcements screen
              // rather than the Alerts list when the notice is tapped.
              announcementId: String(announcementId ?? ''),
              targetScreen: 'ANNOUNCEMENTS',
            },
            android: {
              priority: 'high',
              notification: {
                channelId: RESIDENT_CHANNEL_ID,
                clickAction: RESIDENT_CLICK_ACTION,
              },
            },
          }),
          RESIDENT_SEND_TIMEOUT_MS,
          `FCM send for resident ${recipient.residentId}`
        );
        successCount += 1;
        logInfo(
          requestId,
          'FCM_RESIDENT_BROADCAST',
          `delivered messageId=${messageId} residentId=${recipient.residentId}`
        );
      } catch (error) {
        const code = String(error?.code || 'UNKNOWN');
        failures.push({ residentId: recipient.residentId, code, message: error?.message || '' });
        logError(
          requestId,
          'FCM_RESIDENT_BROADCAST',
          `failed residentId=${recipient.residentId} code=${code} message=${error?.message || ''}`
        );

        if (
          code === 'messaging/registration-token-not-registered'
          || code === 'messaging/invalid-registration-token'
        ) {
          invalidTokens.push(recipient);
        }
      }
    }
  };

  const workerCount = Math.min(RESIDENT_BROADCAST_CONCURRENCY, list.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Prune tokens FCM has told us are dead so later broadcasts do not keep
  // paying for them.
  if (invalidTokens.length > 0) {
    for (const stale of invalidTokens) {
      try {
        await residentRepository.clearFcmToken(stale.residentId, stale.token);
      } catch (error) {
        logError(
          requestId,
          'FCM_RESIDENT_BROADCAST',
          `Token prune failed for resident ${stale.residentId}: ${error.message}`
        );
      }
    }
    logInfo(
      requestId,
      'FCM_RESIDENT_BROADCAST',
      `pruned ${invalidTokens.length} unregistered resident token(s)`
    );
  }

  const notAttemptedCount = list.length - nextIndex;
  if (notAttemptedCount > 0) {
    logError(
      requestId,
      'FCM_RESIDENT_BROADCAST',
      `budget of ${RESIDENT_BROADCAST_DEADLINE_MS}ms exhausted; `
      + `${notAttemptedCount} of ${list.length} recipient(s) were not attempted. `
      + 'Their in-app notification rows are committed, so the next REST sync '
      + 'reconciles them.'
    );
  }

  return {
    delivered: successCount > 0,
    tokenCount: list.length,
    successCount,
    failureCount: failures.length,
    // Distinguishes "we tried and it failed" from "we ran out of budget", which
    // are different problems for whoever reads the logs.
    notAttemptedCount,
    timedOut: timedOut && notAttemptedCount > 0,
    failures,
  };
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
  eligibleAdminIds = null,
}) {
  let tokens;
  try {
    const rows = await adminRepository.findAllFcmTokens();
    // A muted administrator's token is filtered out here rather than sent and
    // discarded downstream, so it is never transmitted at all.
    const allowed = Array.isArray(eligibleAdminIds) ? new Set(eligibleAdminIds) : null;
    tokens = rows
      .filter((row) => (allowed ? allowed.has(row.adminId) : true))
      .map((row) => row.token);
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

/**
 * Personnel-facing channel and click action; must match the Personnel app
 * manifest. Kept beside the resident/admin pair so the three roles never drift
 * into sharing a channel by accident.
 */
const PERSONNEL_CHANNEL_ID = 'ecowatch_personnel_notifications';
const PERSONNEL_CLICK_ACTION =
  'com.example.ecowatchpersonnel1.action.OPEN_NOTIFICATION';

/**
 * Pushes one assignment event to the device bound to a personnel account.
 *
 * Mirrors sendResidentReportNotification: the in-app row is already committed
 * by the caller, so every failure here is reported rather than thrown. A stale
 * token is cleared so it is not retried forever.
 */
async function sendPersonnelNotification({
  personnelId,
  token,
  notificationId,
  assignmentId,
  reportId,
  type,
  title,
  message,
  createdAt,
}) {
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
      notification: { title, body: message },
      data: {
        notificationId: String(notificationId),
        assignmentId: assignmentId ? String(assignmentId) : '',
        reportId: reportId ? String(reportId) : '',
        type: String(type),
        title: String(title),
        message: String(message),
        createdAt: String(createdAt || new Date().toISOString()),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: PERSONNEL_CHANNEL_ID,
          clickAction: PERSONNEL_CLICK_ACTION,
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
      return { delivered: false, reason: 'INVALID_TOKEN', error: code, personnelId };
    }
    throw error;
  }
}

module.exports = {
  isFirebaseConfigured,
  parseServiceAccountJson,
  PERSONNEL_CHANNEL_ID,
  PERSONNEL_CLICK_ACTION,
  sendPersonnelNotification,
  /*
   * Exported so the Firebase Auth boundary in config/firebaseAdmin.js shares
   * this single lazily-initialized app. initializeApp throws when called twice
   * with the same name, and FCM is already the first Firebase consumer, so
   * Auth has to reuse this instance rather than create its own.
   */
  getFirebaseApp,
  sendResidentReportNotification,
  ADMIN_CHANNEL_ID,
  ADMIN_CLICK_ACTION,
  RESIDENT_CHANNEL_ID,
  RESIDENT_CLICK_ACTION,
  RESIDENT_BROADCAST_DEADLINE_MS,
  RESIDENT_SEND_TIMEOUT_MS,
  sendAdminNewReportNotification,
  sendResidentAnnouncementNotification,
};

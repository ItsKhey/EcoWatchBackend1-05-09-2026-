const {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const residentRepository = require('../repositories/residentRepository');

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
      // Include both data and notification payloads. Foreground delivery is
      // rendered by the app's EcoWatch channel; background delivery gets an
      // OS fallback notification with the same title/body and a report-aware
      // click action. The data keys remain the source for exact deep linking.
      notification: { title, body: message },
      clickAction: 'com.example.myecowatch1.action.OPEN_NOTIFICATION',
      // The data keys are also used by the app's foreground renderer. A notification
      // payload here would be rendered by the OS without these app extras.
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

module.exports = {
  isFirebaseConfigured,
  parseServiceAccountJson,
  sendResidentReportNotification,
};

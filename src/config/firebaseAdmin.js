/*
 * Firebase Admin Auth boundary.
 *
 * Scope is deliberately narrow. Supabase remains the source of truth for every
 * account and this backend remains the only authentication authority; Firebase
 * is used for exactly two things:
 *
 *   1. proving ownership of an email address (registration verification), and
 *   2. proving ownership of an email address (password reset verification).
 *
 * Nothing here signs a user in, issues a token, or decides whether a session is
 * valid. There is no Firebase ID token accepted by any route, no Firebase
 * session, and no Firebase user record that can log into EcoWatch. The JWT in
 * utils/generateToken.js is the only credential this system honours.
 *
 * The app instance is shared with services/fcmService.js so the process never
 * calls initializeApp twice.
 */

const { getAuth } = require('firebase-admin/auth');

const {
  getFirebaseApp,
  isFirebaseConfigured,
  parseServiceAccountJson,
} = require('../shared/fcmService');

const { logError } = require('../shared/logger');

let cachedAuth;

/**
 * Every Firebase failure is translated into a message a resident can act on.
 * Admin SDK messages mention internal products ("USER_NOT_FOUND", "INVALID_ID_TOKEN")
 * and are never returned to a client unchanged.
 */
const FIREBASE_ERROR_MAP = {
  'auth/email-already-exists': {
    statusCode: 409,
    message: 'An account with this email already exists.',
  },
  'auth/invalid-email': {
    statusCode: 400,
    message: 'Please enter a valid email address.',
  },
  'auth/invalid-password': {
    statusCode: 400,
    message: 'Please choose a stronger password.',
  },
  'auth/user-not-found': {
    statusCode: 404,
    message: 'No verification identity exists for this email yet.',
  },
  'auth/weak-password': {
    statusCode: 400,
    message: 'Please choose a stronger password.',
  },
  'auth/missing-password': {
    statusCode: 400,
    message: 'A password is required.',
  },
  /*
   * The two action-code failures are the ordinary "link already used" and
   * "link timed out" outcomes of the reset flow, so they are reported as
   * client errors rather than server faults.
   */
  'auth/invalid-action-code': {
    statusCode: 400,
    message: 'This verification link is invalid or has already been used.',
  },
  'auth/expired-action-code': {
    statusCode: 400,
    message: 'This verification link has expired. Please request a new one.',
  },
  /*
   * A registration session that was revoked, tampered with, or signed out. This
   * is the expected answer when the app presented a stale token, so it is a plain
   * 401 that tells the resident to check their email again.
   */
  'auth/id-token-expired': {
    statusCode: 401,
    message: 'This verification session has expired. Please try again.',
  },
  'auth/id-token-revoked': {
    statusCode: 401,
    message: 'This verification session is no longer valid. Please try again.',
  },
  'auth/operation-not-allowed': {
    statusCode: 503,
    message: 'Email verification is temporarily unavailable. Please try again later.',
  },
  'auth/invalid-id-token': {
    statusCode: 401,
    message:
      'This verification session is not valid yet. Open the verification link in '
      + 'your email and try again.',
  },
  'auth/too-many-requests': {
    statusCode: 429,
    message: 'Too many attempts. Please wait a moment and try again.',
  },
  'auth/network-request-failed': {
    statusCode: 503,
    message: 'Could not reach the verification service. Please try again.',
  },
  'auth/internal-error': {
    statusCode: 500,
    message: 'The verification service had a problem. Please try again.',
  },
  'auth/invalid-login-credentials': {
    statusCode: 401,
    message: 'Invalid username or password',
  },
};

function createFirebaseError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.firebaseCode = code;
  return error;
}

/**
 * Rewrites a Firebase Admin error into a user-facing Error carrying a
 * statusCode, so middleware/errorMiddleware.js renders it like any other
 * controlled failure instead of leaking an SDK string.
 */
function translateFirebaseError(error, requestId) {
  const code = String(error?.errorInfo?.code || error?.code || '');
  const mapped = FIREBASE_ERROR_MAP[code];

  if (mapped) {
    logError(
      requestId,
      'FIREBASE_AUTH',
      `mapped ${code} to ${mapped.statusCode}: ${mapped.message}`
    );
    return createFirebaseError(mapped.message, mapped.statusCode, code);
  }

  logError(
    requestId,
    'FIREBASE_AUTH',
    `unmapped Firebase error code=${code || 'UNKNOWN'} message=${
      error?.message || 'no message'
    }`
  );

  return createFirebaseError(
    'The verification service had a problem. Please try again.',
    500,
    code || 'auth/unknown'
  );
}

function isFirebaseAuthConfigured() {
  return isFirebaseConfigured();
}

/*
 * Identity Toolkit action-code lookup.
 *
 * The Admin SDK can mint links but cannot read one back: firebase-admin has no
 * checkActionCode, because that is a client-SDK operation. The REST endpoint the
 * web SDK uses for the same purpose is called here instead, authorised with the
 * project's service account, so the deployment does not need a second credential.
 *
 * With only an oobCode this call is a lookup. It returns the address the code was
 * issued for and consumes nothing, so the resident can still be sent back to fix
 * a mistyped password without asking for a new email.
 */
const IDENTITY_TOOLKIT_RESET_URL =
  'https://identitytoolkit.googleapis.com/v1/accounts:resetPassword';
const IDENTITY_TOOLKIT_TIMEOUT_MS = 15000;

/*
 * The REST layer names failures the way the client SDK does, minus the "auth/"
 * prefix. Mapping them onto the same codes means translateFirebaseError keeps
 * producing the resident-facing messages above, so an expired link reads the
 * same no matter which layer noticed it.
 */
const ACTION_CODE_ERROR_MAP = {
  INVALID_OOB_CODE: 'auth/invalid-action-code',
  EXPIRED_OOB_CODE: 'auth/expired-action-code',
  INVALID_EMAIL: 'auth/invalid-email',
  USER_NOT_FOUND: 'auth/user-not-found',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'auth/too-many-requests',
  INTERNAL_ERROR: 'auth/internal-error',
};

function createActionCodeError(code) {
  const firebaseCode = ACTION_CODE_ERROR_MAP[code] || 'auth/internal-error';
  const error = new Error(code || 'action code lookup failed');
  error.code = firebaseCode;
  error.errorInfo = { code: firebaseCode };
  return error;
}

function createNetworkError() {
  const error = new Error('Could not reach the verification service.');
  error.code = 'auth/network-request-failed';
  error.errorInfo = { code: 'auth/network-request-failed' };
  return error;
}

/**
 * Validates a password-reset oobCode and returns the address it was issued for.
 *
 * <p>Deliberately does not consume the code and does not change a password: the
 * caller needs to know which account the link belongs to before writing anything.
 */
async function verifyPasswordResetCode(oobCode) {
  const app = getFirebaseApp();
  const { access_token: accessToken } = await app.options.credential.getAccessToken();

  let response;
  try {
    response = await fetch(IDENTITY_TOOLKIT_RESET_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ oobCode }),
      signal: AbortSignal.timeout(IDENTITY_TOOLKIT_TIMEOUT_MS),
    });
  } catch {
    throw createNetworkError();
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw createActionCodeError(String(payload?.error?.message || ''));
  }

  return payload;
}

/**
 * Lazily resolves the shared Firebase Auth instance.
 *
 * A missing service account is a deployment problem, not a client problem, so
 * it surfaces as 503 with a configuration message rather than a 500 crash.
 */
function getFirebaseAuth() {
  if (cachedAuth) return cachedAuth;

  let app;
  try {
    app = getFirebaseApp();
  } catch (error) {
    if (error.code === 'FCM_NOT_CONFIGURED') {
      throw createFirebaseError(
        'Email verification is not configured on this server.',
        503,
        'FIREBASE_NOT_CONFIGURED'
      );
    }
    throw error;
  }

  cachedAuth = getAuth(app);
  return cachedAuth;
}

/** Test seam so a test run can start from a clean instance. */
function resetFirebaseAuthForTests() {
  cachedAuth = null;
}

module.exports = {
  getFirebaseAuth,
  isFirebaseAuthConfigured,
  parseServiceAccountJson,
  translateFirebaseError,
  resetFirebaseAuthForTests,
  verifyPasswordResetCode,
};

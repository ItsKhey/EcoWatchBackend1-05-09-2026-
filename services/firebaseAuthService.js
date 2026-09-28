const crypto = require('crypto');

const {
  getFirebaseAuth,
  isFirebaseAuthConfigured,
  translateFirebaseError,
} = require('../config/firebaseAdmin');

const { logInfo, logError } = require('../utils/logger');

/*
 * ---------------------------------------------------------------------------
 * What this module is for
 * ---------------------------------------------------------------------------
 * Firebase proves that a person owns an email address. That is the only thing it
 * is ever asked, in two places:
 *
 *   1. REGISTRATION. The app creates the Firebase user with the client SDK and
 *      asks Firebase to send the verification email. When the resident has
 *      opened it, the app presents the resulting ID token here and
 *      verifyRegistrationSession cryptographically confirms that this Firebase
 *      session belongs to an address that was actually verified.
 *
 *   2. PASSWORD RESET. The app asks Firebase to send the reset email. The link
 *      comes back as an oobCode, and inspectActionCode confirms Firebase issued
 *      it for PASSWORD_RESET and names the address it belongs to.
 *
 * ---------------------------------------------------------------------------
 * Where Firebase is deliberately NOT involved
 * ---------------------------------------------------------------------------
 * Login. The app signs in to Firebase during registration purely so Firebase can
 * send and track the verification email, and signs out as soon as the account
 * exists. No route here accepts a Firebase credential as a login credential, and
 * the EcoWatch login path never reads Firebase. An ID token is honoured in
 * exactly one place - verifyRegistrationSession - and only to create an account
 * that does not exist yet.
 *
 * ---------------------------------------------------------------------------
 * Why nothing is emailed from here
 * ---------------------------------------------------------------------------
 * Firebase refuses to send a verification email unless a user is signed in, and
 * this server never signs in. All email delivery therefore happens on the
 * device through the Firebase client SDK, which also means the backend never
 * holds an outbound mail credential at all.
 */

function assertConfigured() {
  if (!isFirebaseAuthConfigured()) {
    const error = new Error(
      'Email verification is not configured on this server.'
    );
    error.statusCode = 503;
    error.firebaseCode = 'FIREBASE_NOT_CONFIGURED';
    throw error;
  }
}

/**
 * Confirms a Firebase ID token that the app obtained after the resident opened
 * their verification email.
 *
 * <p>Everything the caller could forge is checked here, because the token is the
 * only thing being trusted:
 *
 *   - verifyIdToken checks the signature, so the token genuinely came from this
 *     Firebase project and was not modified in transit.
 *   - checkRevoked is enabled, so a session the app signed out of cannot be
 *     replayed to create an account.
 *   - email_verified must be true, so a session that exists but never proved
 *     ownership of the inbox cannot create anything.
 *
 * <p>The caller must additionally match the returned address against the
 * registration it belongs to. A valid token is only ever proof about the address
 * it names, so it must not be allowed to activate a different signup.
 *
 * @returns {Promise<{uid: string, email: string}>}
 */
async function verifyRegistrationSession({ idToken, requestId }) {
  assertConfigured();

  let decoded;
  try {
    decoded = await getFirebaseAuth().verifyIdToken(idToken, true);
  } catch (error) {
    throw translateFirebaseError(error, requestId);
  }

  if (decoded?.email_verified !== true) {
    const error = new Error(
      'This email address has not been verified yet. Open the verification link '
      + 'in your email and try again.'
    );
    error.statusCode = 400;
    error.firebaseCode = 'EMAIL_NOT_VERIFIED';
    throw error;
  }

  const email = String(decoded?.email || '').trim().toLowerCase();
  const uid = String(decoded?.uid || '').trim();

  if (!uid || !email) {
    const error = new Error('This verification session is not usable.');
    error.statusCode = 400;
    error.firebaseCode = 'INVALID_SESSION';
    throw error;
  }

  logInfo(requestId, 'FIREBASE_AUTH', `verified registration session for ${email}`);

  return { uid, email, emailVerified: true };
}

/**
 * Validates a password-reset oobCode WITHOUT consuming it, and returns the
 * address it was issued for.
 *
 * <p>Two things are enforced here:
 *
 *   - The operation must be PASSWORD_RESET. A verification link from the
 *     registration flow is not a password-reset credential and must never be
 *     replayable as one.
 *   - The address Firebase names is the authority on which account to update.
 *     The client never states which account it is resetting, so it cannot
 *     redirect a reset at somebody else's row.
 *
 * <p>The caller is responsible for consuming the code afterwards via the Android
 * SDK's applyActionCode.
 */
async function inspectActionCode(oobCode, requestId) {
  assertConfigured();

  let info;
  try {
    info = await getFirebaseAuth().checkActionCode(oobCode);
  } catch (error) {
    throw translateFirebaseError(error, requestId);
  }

  if (info?.operation !== 'PASSWORD_RESET') {
    const error = new Error(
      'This verification link cannot be used to reset a password.'
    );
    error.statusCode = 400;
    throw error;
  }

  const email = String(info?.data?.email || '').trim().toLowerCase();
  if (!email) {
    const error = new Error(
      'This verification link is invalid or has already been used.'
    );
    error.statusCode = 400;
    throw error;
  }

  logInfo(requestId, 'FIREBASE_AUTH', `reset code validated for email=${email}`);

  return { email, operation: info.operation };
}

/**
 * Returns the Firebase identity for an address, or null when there is none.
 * Used to detect legacy accounts that predate the Firebase columns.
 */
async function findIdentityByEmail(email, requestId) {
  assertConfigured();

  try {
    const user = await getFirebaseAuth().getUserByEmail(email);
    return { uid: user.uid, emailVerified: user.emailVerified === true };
  } catch (error) {
    const code = String(error?.errorInfo?.code || error?.code || '');
    if (code === 'auth/user-not-found') {
      return null;
    }
    throw translateFirebaseError(error, requestId);
  }
}

/**
 * Guarantees a Firebase identity exists for an address, so the app is able to ask
 * Firebase to send a password-reset email for it.
 *
 * <p>This is the legacy-account bridge. Firebase will not send a reset email for
 * an address it has never seen, so an account that predates the Firebase
 * integration has no identity yet. One is created here with a random placeholder
 * password: enough for Firebase to deliver, never usable as a credential for
 * anything, and overwritten with the resident's real new password the moment
 * /reset-password completes.
 */
async function ensureIdentityForReset({ email, displayName, requestId }) {
  assertConfigured();

  const existing = await findIdentityByEmail(email, requestId);
  if (existing) {
    return { uid: existing.uid, created: false, emailVerified: existing.emailVerified };
  }

  // 32 hex characters: far too long to guess, and comfortably inside bcrypt's
  // 72-byte ceiling.
  const placeholder = crypto.randomBytes(16).toString('hex');

  const user = await getFirebaseAuth().createUser({
    email,
    password: placeholder,
    displayName: displayName || undefined,
    emailVerified: false,
  });

  logInfo(
    requestId,
    'FIREBASE_AUTH',
    `created placeholder identity uid=${user.uid} so ${email} can be reset`
  );

  return { uid: user.uid, created: true, emailVerified: false };
}

/**
 * Overwrites the Firebase identity password so it matches the bcrypt hash just
 * written to Supabase.
 *
 * The Supabase hash is what login checks. This call exists so the address keeps a
 * usable Firebase identity afterwards, which is what allows a later reset email
 * to be sent at all. If it fails, the resident can still log in with their
 * username and new password immediately.
 */
async function overwriteIdentityPassword({ uid, password, requestId }) {
  assertConfigured();

  try {
    await getFirebaseAuth().updateUser(uid, { password });
    logInfo(requestId, 'FIREBASE_AUTH', `firebase password synchronised for uid=${uid}`);
    return true;
  } catch (error) {
    throw translateFirebaseError(error, requestId);
  }
}

module.exports = {
  ensureIdentityForReset,
  findIdentityByEmail,
  inspectActionCode,
  overwriteIdentityPassword,
  verifyRegistrationSession,
};

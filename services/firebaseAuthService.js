/*
 * Firebase Auth operations used by the email-verification and password-reset
 * flows.
 *
 * Every function here is a thin, well-labelled wrapper around the Admin SDK.
 * Two invariants hold across all of them:
 *
 *   - Firebase decides only whether an EMAIL ADDRESS IS PROVEN. It never
 *     decides whether a login is valid.
 *   - A Firebase outage degrades the verification step, it never corrupts
 *     Supabase. Supabase writes are the authoritative ones and are committed
 *     first wherever a flow touches both systems.
 *
 * The generated links are not emails. Firebase hands back a link; Resend sends
 * it. See services/emailServices.js.
 */

const crypto = require('crypto');

const {
  getFirebaseAuth,
  isFirebaseAuthConfigured,
  translateFirebaseError,
} = require('../config/firebaseAdmin');

const {
  sendFirebaseVerificationLink,
  sendFirebasePasswordResetLink,
} = require('./emailServices');

const { logInfo, logError } = require('../utils/logger');

/**
 * Where Firebase sends the person after they click the link.
 *
 * This is an HTTPS App Link on the Firebase default domain rather than a custom
 * scheme, so Android can verify the link against the app's signing certificate
 * and open EcoWatch directly instead of showing a browser chooser. Verification
 * then depends on the app's SHA-256 being registered in the Firebase console;
 * see FIREBASE_EMAIL_SETUP.md.
 */
const DEFAULT_CONTINUE_URL = 'https://ecowatch1-4445f.firebaseapp.com/finishSignUp';

/**
 * The Android package the action page should hand off to. Firebase uses this to
 * offer the "open in app" behaviour on its own hosted action page.
 */
const DEFAULT_ANDROID_PACKAGE = 'com.example.myecowatch1';

const getContinueUrl = () => process.env.FIREBASE_CONTINUE_URL || DEFAULT_CONTINUE_URL;

/** Registration links land on the same page; Firebase appends mode=verifyEmail. */
const getVerificationContinueUrl = () =>
  process.env.FIREBASE_VERIFICATION_CONTINUE_URL || getContinueUrl();

const getAndroidPackageName = () =>
  process.env.FIREBASE_ANDROID_PACKAGE_NAME || DEFAULT_ANDROID_PACKAGE;

/**
 * The single ActionCodeSettings used for both verification and reset.
 *
 * handleCodeInApp is what makes Firebase append the oobCode to the continue URL
 * and hand control to the app instead of completing the action in the browser.
 * The app then decides what happens; the password itself is always set by this
 * backend, never by the page.
 *
 * installApp is false so Firebase does not offer to install EcoWatch from a
 * password reset on someone who is trying to get back into an account they
 * already have on another device.
 */
const buildActionCodeSettings = (url) => ({
  url,
  handleCodeInApp: true,
  android: {
    packageName: getAndroidPackageName(),
    installApp: false,
  },
});

/** Registration links stay usable for a day; OTP links live 5 minutes. */
const VERIFICATION_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/** Firebase's own password-reset link lifetime. */
const RESET_LINK_TTL_MINUTES = 60;

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
 * Turns an email delivery failure into a logged, tagged error.
 *
 * services/emailServices.js has already classified the failure and attached the
 * operator-facing reason as operatorHint. That hint is written to the server log
 * because it is the only place the fix belongs: the resident is told delivery is
 * unavailable, while whoever runs the deployment finds out that EMAIL_FROM is
 * the provider's testing sender.
 */
const reportDeliveryFailure = ({ error, requestId, label, recipient }) => {
  const code = String(error?.code || 'EMAIL_DELIVERY_FAILED');
  const hint = error?.operatorHint || error?.message || 'no detail from the provider';

  logError(requestId, 'EMAIL_DELIVERY', `${label} to ${recipient} failed [${code}]`);
  logError(requestId, 'EMAIL_CONFIG', hint);

  return createFirebaseError(
    'We could not send the email. Email delivery is not configured for this '
      + 'address yet. Please contact your administrator.',
    502,
    code
  );
};

/**
 * Creates an unverified Firebase identity for a new registration.
 *
 * The identity is created unverified on purpose. Firebase owns the email
 * proof, so a resident who never clicks the link must never produce a verified
 * Firebase record, and therefore must never produce a Supabase account either.
 *
 * The password is set on the Firebase identity at the same moment the bcrypt
 * hash is written to Supabase, which is what keeps the two systems in step from
 * the very first request and lets a later password reset update both.
 */
async function createVerificationIdentity({
  email,
  password,
  displayName,
  requestId,
}) {
  assertConfigured();

  try {
    const user = await getFirebaseAuth().createUser({
      email,
      password,
      displayName: displayName || undefined,
      emailVerified: false,
      // The resident is never disabled here. Firebase is not the authority on
      // account status; residents.status is.
      disabled: false,
    });

    logInfo(
      requestId,
      'FIREBASE_AUTH',
      `created unverified identity uid=${user.uid} for email=${email}`
    );

    return { uid: user.uid, email: user.email || email };
  } catch (error) {
    throw translateFirebaseError(error, requestId);
  }
}

/**
 * Generates a fresh email-verification link and delivers it.
 *
 * The previous link is invalidated by Firebase when a new one is generated for
 * the same address, so resending cannot be used to keep several live links.
 */
async function sendVerificationLink({ email, username, requestId }) {
  assertConfigured();

  let link;
  try {
    link = await getFirebaseAuth().generateEmailVerificationLink(
      email,
      buildActionCodeSettings(getVerificationContinueUrl())
    );
  } catch (error) {
    throw translateFirebaseError(error, requestId);
  }

  try {
    await sendFirebaseVerificationLink(email, link, username);
  } catch (error) {
    throw reportDeliveryFailure({
      error,
      requestId,
      label: 'verification link',
      recipient: email,
    });
  }

  logInfo(requestId, 'FIREBASE_AUTH', `verification link issued for email=${email}`);

  return { link, expiresAt: new Date(Date.now() + VERIFICATION_LINK_TTL_MS) };
}

/**
 * Asks Firebase whether the address behind an identity has been proven.
 *
 * This is the only thing that gates account creation. It is a boolean read on
 * Firebase's own record, which is why it cannot be forged by the client.
 */
async function isEmailVerified(uid, requestId) {
  assertConfigured();

  try {
    const user = await getFirebaseAuth().getUser(uid);
    return { verified: user.emailVerified === true, email: user.email || null };
  } catch (error) {
    throw translateFirebaseError(error, requestId);
  }
}

/**
 * Generates the password-reset link and delivers it.
 *
 * Firebase requires the identity to already exist, which is why this can 404 for
 * an account that has never been through a Firebase-backed flow. The controller
 * backfills the identity before calling this, so this path is only reached for
 * an address Firebase genuinely knows.
 */
async function sendPasswordResetLink({ email, username, requestId }) {
  assertConfigured();

  let link;
  try {
    link = await getFirebaseAuth().generatePasswordResetLink(
      email,
      buildActionCodeSettings(getContinueUrl())
    );
  } catch (error) {
    throw translateFirebaseError(error, requestId);
  }

  try {
    await sendFirebasePasswordResetLink(email, link, username);
  } catch (error) {
    throw reportDeliveryFailure({
      error,
      requestId,
      label: 'password reset link',
      recipient: email,
    });
  }

  logInfo(requestId, 'FIREBASE_AUTH', `password reset link issued for email=${email}`);

  return {
    link,
    expiresAt: new Date(Date.now() + RESET_LINK_TTL_MINUTES * 60 * 1000),
  };
}

/**
 * Validates a reset oobCode WITHOUT consuming it, and returns the address it
 * was issued for.
 *
 * Two things are enforced here:
 *
 *   - The operation must be PASSWORD_RESET. A verification link from the
 *     registration flow is not a password-reset credential and must never be
 *     replayable as one.
 *   - The address Firebase names is the authority on which account to update.
 *     The client never states which account it is resetting, so it cannot
 *     redirect a reset at somebody else's row.
 *
 * The caller is responsible for consuming the code afterwards via the Android
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
 * Overwrites the Firebase identity password so it matches the bcrypt hash just
 * written to Supabase.
 *
 * The Supabase hash is what login checks. This call exists so that a later
 * password-reset email can still be generated for this address, which requires a
 * Firebase record whose password the Admin SDK can set. If it fails, the
 * resident can still log in with their username and new password immediately.
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
 * Resolves the Firebase identity for an account, creating it when absent.
 *
 * This is the bridge for accounts that existed before this feature. A resident
 * who registered under the old OTP flow has no firebase_uid; rather than
 * refusing their password reset, the identity is created on demand and the uid
 * is backfilled. The address is proven by the reset link itself, so nothing is
 * taken on trust here.
 */
async function ensureIdentity({ email, password, displayName, requestId }) {
  const existing = await findIdentityByEmail(email, requestId);

  if (existing) {
    // The password is re-applied so a legacy identity whose Firebase password
    // predates the current Supabase hash does not drift further.
    if (password) {
      await overwriteIdentityPassword({
        uid: existing.uid,
        password,
        requestId,
      });
    }
    return { uid: existing.uid, created: false, emailVerified: existing.emailVerified };
  }

  const created = await createVerificationIdentity({
    email,
    password,
    displayName,
    requestId,
  });

  return { uid: created.uid, created: true, emailVerified: false };
}

/**
 * Retires an unverified identity that nothing in Supabase references.
 *
 * Used when a resident abandons a signup and retries with the same address.
 * Deleting the abandoned identity is the only thing that lets the address be
 * registered again, because Firebase rejects a second createUser for an address
 * it already holds.
 *
 * The safety condition is established by the caller: a uid is only ever passed
 * here when it is known to belong to a pending signup that was just discarded,
 * never to a live account. A verified identity is refused outright, because
 * removing one would silently break that resident's future password resets.
 */
async function deleteUnverifiedIdentity({ uid, email, requestId }) {
  assertConfigured();

  try {
    const user = await getFirebaseAuth().getUser(uid);

    if (user.emailVerified === true) {
      const conflict = new Error('An account with this email already exists.');
      conflict.statusCode = 409;
      conflict.firebaseCode = 'auth/email-already-exists';
      throw conflict;
    }

    await getFirebaseAuth().deleteUser(uid);
    logInfo(
      requestId,
      'FIREBASE_AUTH',
      `retired abandoned unverified identity uid=${uid} for email=${email}`
    );
    return true;
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    throw translateFirebaseError(error, requestId);
  }
}

/**
 * Guarantees a Firebase identity exists for an address so a reset link can be
 * generated, without needing the account's password.
 *
 * This is the legacy-account bridge. A resident who registered under the old OTP
 * flow has a bcrypt hash in Supabase and no Firebase record, and Firebase will
 * not generate a reset link for an address it has never seen. The identity is
 * created here with a random placeholder password.
 *
 * That placeholder is never a usable credential: login reads Supabase, and
 * /reset-password overwrites the placeholder with the resident's real new
 * password as soon as the reset completes.
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

  const created = await createVerificationIdentity({
    email,
    password: placeholder,
    displayName,
    requestId,
  });

  logInfo(
    requestId,
    'FIREBASE_AUTH',
    `created placeholder identity uid=${created.uid} so ${email} can be reset`
  );

  return { uid: created.uid, created: true, emailVerified: false };
}

module.exports = {
  DEFAULT_CONTINUE_URL,
  DEFAULT_ANDROID_PACKAGE,
  RESET_LINK_TTL_MINUTES,
  VERIFICATION_LINK_TTL_MS,
  buildActionCodeSettings,
  createVerificationIdentity,
  deleteUnverifiedIdentity,
  ensureIdentity,
  ensureIdentityForReset,
  findIdentityByEmail,
  getContinueUrl,
  getVerificationContinueUrl,
  inspectActionCode,
  isEmailVerified,
  overwriteIdentityPassword,
  sendPasswordResetLink,
  sendVerificationLink,
};

/*
 * Shared input validation for the Firebase email-verification and
 * password-reset flows.
 *
 * Two rules matter more than the rest:
 *
 *   1. Bcrypt truncates silently at 72 BYTES, not 72 characters. A 60-character
 *      emoji password is 240 bytes and would be hashed from its first 72 bytes,
 *      so the limit below is measured in UTF-8 bytes.
 *
 *   2. Both apps call .trim() on the password field before it leaves the device.
 *      The server trims identically so the stored hash always corresponds to
 *      what the resident believes they typed, and so a password that trims to
 *      nothing is rejected instead of becoming a valid empty credential.
 *
 * These validators are used by the new email-link flow only. The legacy OTP
 * registration path is deliberately left unvalidated so deployed clients and
 * existing accounts keep working exactly as they do today.
 */

const { createHttpError } = require('./personnelValidation');

/** Mirrors UsernameValidator in the Android app: 3-20 alphanumerics/underscore. */
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

/**
 * Intentionally permissive. A strict RFC 5322 regex rejects valid addresses
 * (quoted local parts, some .edu forms) and the requirement is to accept any
 * valid provider: Gmail, Yahoo, Outlook, Hotmail, school .edu, or anything else.
 * Firebase performs the authoritative format check on createUser.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const BCRYPT_MAX_BYTES = 72;
const PASSWORD_MIN_LENGTH = 8;

/** Case-folded for the uniqueness check, original kept for delivery. */
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const normalizeUsername = (value) => String(value || '').trim();

const requireEmail = (value, fieldName = 'Email') => {
  const email = normalizeEmail(value);

  if (!email) {
    throw createHttpError(400, `${fieldName} is required.`);
  }

  if (email.length > 254) {
    throw createHttpError(400, `${fieldName} is too long.`);
  }

  if (!EMAIL_PATTERN.test(email)) {
    throw createHttpError(400, 'Please enter a valid email address.');
  }

  return email;
};

const requireUsername = (value) => {
  const username = normalizeUsername(value);

  if (!username) {
    throw createHttpError(400, 'Username is required.');
  }

  if (!USERNAME_PATTERN.test(username)) {
    throw createHttpError(
      400,
      'Username must be 3-20 characters, using letters, numbers or underscore.'
    );
  }

  return username;
};

const requireFullName = (value, fieldName) => {
  const name = String(value || '').trim();

  if (!name) {
    throw createHttpError(400, `${fieldName} is required.`);
  }

  if (name.length > 100) {
    throw createHttpError(400, `${fieldName} must be at most 100 characters.`);
  }

  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw createHttpError(400, `${fieldName} contains invalid characters.`);
  }

  return name;
};

/**
 * Returns the trimmed password or throws with a specific, actionable reason.
 * The reason is safe to show: it describes the password the caller just typed
 * and never echoes the value back.
 */
const requirePassword = (value) => {
  const password = String(value == null ? '' : value).trim();

  if (!password) {
    throw createHttpError(400, 'Password is required.');
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    throw createHttpError(
      400,
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
    );
  }

  if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_BYTES) {
    throw createHttpError(
      400,
      `Password is too long. Use ${BCRYPT_MAX_BYTES} characters or fewer.`
    );
  }

  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw createHttpError(
      400,
      'Password must contain at least one letter and one number.'
    );
  }

  return password;
};

/**
 * Guards a client-supplied registrationId / oobCode before it reaches a query.
 * Both are opaque strings from Firebase, so they are bounded rather than
 * pattern-matched.
 */
const requireOpaqueToken = (value, fieldName) => {
  const token = String(value == null ? '' : value).trim();

  if (!token) {
    throw createHttpError(400, `${fieldName} is required.`);
  }

  if (token.length > 512) {
    throw createHttpError(400, `${fieldName} is malformed.`);
  }

  if (!/^[A-Za-z0-9_\-.]+$/.test(token)) {
    throw createHttpError(400, `${fieldName} is malformed.`);
  }

  return token;
};

module.exports = {
  BCRYPT_MAX_BYTES,
  EMAIL_PATTERN,
  PASSWORD_MIN_LENGTH,
  USERNAME_PATTERN,
  normalizeEmail,
  normalizeUsername,
  requireEmail,
  requireFullName,
  requireOpaqueToken,
  requirePassword,
  requireUsername,
};

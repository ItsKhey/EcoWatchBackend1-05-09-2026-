const PERSONNEL_ID_PATTERN = /^PERS-[0-9]{4}$/;
const LEGACY_PERSONNEL_ID_PATTERN = /^RES-[A-Z0-9]{4,32}$/;
const ASSIGNMENT_ID_PATTERN = /^(?:PERS-[0-9]{4}|RES-[A-Z0-9]{4,32})$/;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,49}$/;
const GMAIL_PATTERN = /^[a-z0-9._%+-]+@gmail\.com$/;
const PHONE_PATTERN = /^[0-9+() .-]{7,25}$/;
const PERSONNEL_STATUSES = new Set(['ONLINE', 'OFFLINE', 'CLEANING']);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const createHttpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const requireObject = (value, fieldName = 'Request body') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createHttpError(400, `${fieldName} must be a JSON object.`);
  }

  return value;
};

const normalizeText = (
  value,
  fieldName,
  {
    required = true,
    maxLength = 255,
    defaultValue = '',
  } = {}
) => {
  if (value === undefined || value === null) {
    if (required) {
      throw createHttpError(400, `${fieldName} is required.`);
    }

    return defaultValue;
  }

  if (typeof value !== 'string') {
    throw createHttpError(400, `${fieldName} must be a string.`);
  }

  const normalized = value.trim().replace(/\s+/g, ' ');

  if (required && !normalized) {
    throw createHttpError(400, `${fieldName} is required.`);
  }

  if (normalized.length > maxLength) {
    throw createHttpError(400, `${fieldName} must be at most ${maxLength} characters.`);
  }

  if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw createHttpError(400, `${fieldName} contains invalid characters.`);
  }

  return normalized;
};

const normalizeMultilineText = (
  value,
  fieldName,
  { required = false, maxLength = 300, defaultValue = '' } = {}
) => {
  if (value === undefined || value === null) {
    if (required) {
      throw createHttpError(400, `${fieldName} is required.`);
    }

    return defaultValue;
  }

  if (typeof value !== 'string') {
    throw createHttpError(400, `${fieldName} must be a string.`);
  }

  const normalized = value.trim();

  if (required && !normalized) {
    throw createHttpError(400, `${fieldName} is required.`);
  }

  if (normalized.length > maxLength) {
    throw createHttpError(400, `${fieldName} must be at most ${maxLength} characters.`);
  }

  if (CONTROL_CHARACTER_PATTERN.test(normalized.replace(/[\r\n\t]/g, ''))) {
    throw createHttpError(400, `${fieldName} contains invalid characters.`);
  }

  return normalized;
};

const getEmailInput = (payload) => {
  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  const gmail = typeof payload.gmail === 'string' ? payload.gmail.trim() : '';
  return email || gmail || (payload.email ?? payload.gmail);
};

const normalizeEmail = (value) => {
  const email = normalizeText(value, 'Email', { maxLength: 255 }).toLowerCase();

  if (!GMAIL_PATTERN.test(email)) {
    throw createHttpError(400, 'Email must be a valid Gmail address.');
  }

  return email;
};

const normalizeUsername = (value) => {
  const username = normalizeText(value, 'Username', { maxLength: 50 }).toLowerCase();

  if (!USERNAME_PATTERN.test(username)) {
    throw createHttpError(
      400,
      'Username must be 3-50 characters and contain only lowercase letters, numbers, dots, underscores, or hyphens.'
    );
  }

  return username;
};

const normalizePhoneNumber = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const phoneNumber = normalizeText(value, 'Phone number', { maxLength: 25 });

  if (!PHONE_PATTERN.test(phoneNumber)) {
    throw createHttpError(400, 'Phone number format is invalid.');
  }

  return phoneNumber;
};

const validatePassword = (value, fieldName = 'Password') => {
  if (typeof value !== 'string') {
    throw createHttpError(400, `${fieldName} is required.`);
  }

  if (value.length < 8 || value.length > 72) {
    throw createHttpError(400, `${fieldName} must be between 8 and 72 characters.`);
  }

  if (Buffer.byteLength(value, 'utf8') > 72) {
    throw createHttpError(400, `${fieldName} must not exceed 72 UTF-8 bytes.`);
  }

  return value;
};

const validatePersonnelId = (value, fieldName = 'Personnel ID') => {
  if (typeof value !== 'string') {
    throw createHttpError(400, `${fieldName} must be a string.`);
  }

  const personnelId = value.trim().toUpperCase();

  if (!PERSONNEL_ID_PATTERN.test(personnelId)) {
    throw createHttpError(400, `${fieldName} must use the PERS-XXXX format.`);
  }

  return personnelId;
};

const validateStatus = (value) => {
  if (typeof value !== 'string') {
    throw createHttpError(400, 'Status must be a string.');
  }

  const status = value.trim().toUpperCase();

  if (!PERSONNEL_STATUSES.has(status)) {
    throw createHttpError(400, 'Status must be ONLINE, OFFLINE, or CLEANING.');
  }

  return status;
};

const validateStatusPayload = (body) => {
  const payload = requireObject(body);
  const hasStatus =
    Object.prototype.hasOwnProperty.call(payload, 'status') &&
    payload.status !== null &&
    payload.status !== '';
  const hasOnline =
    Object.prototype.hasOwnProperty.call(payload, 'online') &&
    payload.online !== null;
  const hasCleaning =
    Object.prototype.hasOwnProperty.call(payload, 'cleaning') &&
    payload.cleaning !== null;

  if (
    (hasOnline && typeof payload.online !== 'boolean') ||
    (hasCleaning && typeof payload.cleaning !== 'boolean')
  ) {
    throw createHttpError(400, 'online and cleaning must be boolean values.');
  }

  if (!hasStatus && !hasOnline && !hasCleaning) {
    throw createHttpError(400, 'At least one status field is required.');
  }

  const explicitStatus = hasStatus ? validateStatus(payload.status) : null;

  if (hasCleaning && payload.cleaning) {
    if (explicitStatus && explicitStatus !== 'CLEANING') {
      throw createHttpError(400, 'Status fields conflict; cleaning requires CLEANING status.');
    }
    return 'CLEANING';
  }

  if (hasOnline && payload.online) {
    if (explicitStatus && explicitStatus !== 'ONLINE') {
      throw createHttpError(400, 'Status fields conflict; online requires ONLINE status.');
    }
    return 'ONLINE';
  }

  if (explicitStatus) {
    if (
      hasCleaning &&
      payload.cleaning === false &&
      explicitStatus === 'CLEANING'
    ) {
      throw createHttpError(400, 'Status fields conflict with cleaning=false.');
    }

    if (hasOnline && payload.online === false && explicitStatus === 'ONLINE') {
      throw createHttpError(400, 'Status fields conflict with online=false.');
    }

    return explicitStatus;
  }

  return 'OFFLINE';
};

const validateCreatePayload = (body) => {
  const payload = requireObject(body);

  if (
    payload.email !== undefined &&
    payload.email !== null &&
    payload.gmail !== undefined &&
    payload.gmail !== null &&
    String(payload.email).trim().toLowerCase() !==
      String(payload.gmail).trim().toLowerCase()
  ) {
    throw createHttpError(400, 'Email and Gmail fields must match when both are provided.');
  }

  return {
    firstName: normalizeText(payload.firstName, 'First name', { maxLength: 100 }),
    lastName: normalizeText(payload.lastName, 'Last name', { maxLength: 100 }),
    address: normalizeMultilineText(payload.address, 'Address', { maxLength: 300 }),
    email: normalizeEmail(getEmailInput(payload)),
    username: normalizeUsername(payload.username),
    password: validatePassword(payload.password),
    phoneNumber: normalizePhoneNumber(payload.phoneNumber),
  };
};

const validateUpdatePayload = (body) => {
  const payload = requireObject(body);
  const updates = {};

  if (Object.prototype.hasOwnProperty.call(payload, 'firstName')) {
    updates.firstName = normalizeText(payload.firstName, 'First name', { maxLength: 100 });
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'lastName')) {
    updates.lastName = normalizeText(payload.lastName, 'Last name', { maxLength: 100 });
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'address')) {
    updates.address = normalizeMultilineText(payload.address, 'Address', { maxLength: 300 });
  }

  if (
    Object.prototype.hasOwnProperty.call(payload, 'email') ||
    Object.prototype.hasOwnProperty.call(payload, 'gmail')
  ) {
    if (
      payload.email !== undefined &&
      payload.email !== null &&
      payload.gmail !== undefined &&
      payload.gmail !== null &&
      String(payload.email).trim().toLowerCase() !==
        String(payload.gmail).trim().toLowerCase()
    ) {
      throw createHttpError(400, 'Email and Gmail fields must match when both are provided.');
    }

    updates.email = normalizeEmail(getEmailInput(payload));
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'username')) {
    updates.username = normalizeUsername(payload.username);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'phoneNumber')) {
    updates.phoneNumber = normalizePhoneNumber(payload.phoneNumber);
  }

  if (Object.keys(updates).length === 0) {
    throw createHttpError(400, 'At least one editable personnel field is required.');
  }

  return updates;
};

const parseBooleanQuery = (value, fieldName, defaultValue = false) => {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['true', '1', 'yes'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no'].includes(normalized)) {
    return false;
  }

  throw createHttpError(400, `${fieldName} must be true or false.`);
};

const parsePositiveInteger = (value, fieldName, defaultValue, maximum) => {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw createHttpError(400, `${fieldName} must be an integer between 1 and ${maximum}.`);
  }

  return parsed;
};

const parseListQuery = (query = {}) => {
  const includeDisabled = parseBooleanQuery(
    query.includeDisabled,
    'includeDisabled',
    false
  );
  const activeValue = query.activeOnly ?? query.active;
  const activeOnly = parseBooleanQuery(
    activeValue,
    'activeOnly',
    !includeDisabled
  );
  const includeDeleted = parseBooleanQuery(query.includeDeleted, 'includeDeleted', false);
  const status = query.status ? validateStatus(query.status) : null;
  const search = query.search
    ? normalizeText(query.search, 'Search', { maxLength: 100 })
    : null;
  const page = parsePositiveInteger(query.page, 'Page', 1, 1000000);
  const limit = parsePositiveInteger(query.limit, 'Limit', 50, 100);
  const offset = (page - 1) * limit;

  return {
    activeOnly,
    includeDisabled,
    includeDeleted,
    // includeDisabled only widens enabled/disabled visibility. Deleted rows
    // still require the independent includeDeleted=true opt-in.
    includeInactive: includeDisabled || !activeOnly || includeDeleted,
    status,
    search,
    limit,
    offset,
    page,
  };
};

module.exports = {
  PERSONNEL_ID_PATTERN,
  LEGACY_PERSONNEL_ID_PATTERN,
  ASSIGNMENT_ID_PATTERN,
  PERSONNEL_STATUSES,
  createHttpError,
  requireObject,
  normalizeText,
  normalizeMultilineText,
  normalizeEmail,
  normalizeUsername,
  validatePassword,
  validatePersonnelId,
  validateStatus,
  validateStatusPayload,
  validateCreatePayload,
  validateUpdatePayload,
  parseListQuery,
};

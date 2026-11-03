const PERSONNEL_ID_PATTERN = /^PERS-[0-9]{4}$/;
const LEGACY_PERSONNEL_ID_PATTERN = /^RES-[A-Z0-9]{4,32}$/;
const ASSIGNMENT_ID_PATTERN = /^(?:PERS-[0-9]{4}|RES-[A-Z0-9]{4,32})$/;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,49}$/;
const GMAIL_PATTERN = /^[a-z0-9._%+-]+@gmail\.com$/;
const PHONE_PATTERN = /^[0-9+() .-]{7,25}$/;
const MESSENGER_LINK_PATTERN = /^https?:\/\/[^\s]+$/i;
const PERSONNEL_STATUSES = new Set(['ONLINE', 'OFFLINE', 'CLEANING']);
const VEHICLE_ID_PATTERN = /^VEH-[0-9]{4}$/;

/**
 * What a personnel member does, in the vocabulary the Admin screen's dropdown
 * offers.
 *
 * <p>Deliberately two values and not free text. A role nobody can filter on is a
 * role the fleet cannot be matched against, and a cleanup team only needs the one
 * distinction that changes what the app can do with the account: whether this
 * person drives a truck.
 */
const PERSONNEL_OCCUPATIONS = Object.freeze({
  REGULAR: 'Regular',
  DRIVER: 'Driver',
});

const PERSONNEL_OCCUPATION_VALUES = Object.freeze(Object.values(PERSONNEL_OCCUPATIONS));
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

/**
 * Treats a blank or whitespace-only optional field as "no value" rather than as
 * a validation error, so an admin can clear a contact field by emptying it.
 */
const isAbsentValue = (value) =>
  value === undefined || value === null || (typeof value === 'string' && !value.trim());

const normalizePhoneNumber = (value) => {
  if (isAbsentValue(value)) {
    return null;
  }

  const phoneNumber = normalizeText(value, 'Phone number', { maxLength: 25 });

  if (!PHONE_PATTERN.test(phoneNumber)) {
    throw createHttpError(400, 'Phone number format is invalid.');
  }

  return phoneNumber;
};

const normalizeMessengerLink = (value) => {
  if (isAbsentValue(value)) {
    return null;
  }

  const messengerLink = normalizeText(value, 'Messenger link', { maxLength: 500 });

  if (!MESSENGER_LINK_PATTERN.test(messengerLink)) {
    throw createHttpError(
      400,
      'Messenger link must be an absolute http:// or https:// URL.'
    );
  }

  return messengerLink;
};

/**
 * Requires a contact value instead of treating a blank one as "clear it".
 *
 * <p>Used at signup, where an absent phone number would leave the admin app's
 * Contact Information card permanently empty. Kept here rather than in a
 * controller because both the resident and the Firebase registration transport
 * need it, and importing it across those two controllers would be circular.
 */
const requirePhoneNumber = (value, fieldName = 'Phone number') => {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw createHttpError(400, `${fieldName} is required.`);
  }

  return normalizePhoneNumber(value);
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

/**
 * Normalises the occupation, defaulting to Regular when the field is absent.
 *
 * <p>Regular is the default rather than a refusal because it is what the column
 * defaults to and what every account registered before the field existed is: a
 * client that has not been updated still creates a cleaner, and that should keep
 * working instead of failing with a 400 about a field it never knew about.
 *
 * @param {*} value
 * @param {{ defaultValue?: string|null }} [options]
 */
const normalizeOccupation = (value, { defaultValue = PERSONNEL_OCCUPATIONS.REGULAR } = {}) => {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== 'string') {
    throw createHttpError(400, 'Occupation must be a string.');
  }

  const normalized = value.trim().toLowerCase();
  const match = PERSONNEL_OCCUPATION_VALUES.find(
    (occupation) => occupation.toLowerCase() === normalized
  );

  if (!match) {
    throw createHttpError(
      400,
      `Occupation must be one of: ${PERSONNEL_OCCUPATION_VALUES.join(', ')}.`
    );
  }

  return match;
};

/**
 * Normalises the vehicle a driver is assigned to.
 *
 * <p>Accepts the shorter `vehicleId` spelling as well, because that is the name
 * the Admin app uses everywhere else for the same column and having two spellings
 * on the wire for one value is how a field ends up half-populated.
 *
 * <p>A blank value means "no truck" rather than "invalid": clearing the truck on
 * a driver is a real edit, and refusing it would make the field impossible to
 * undo.
 */
const normalizeAssignedVehicleId = (value) => {
  if (isAbsentValue(value)) {
    return null;
  }

  if (typeof value !== 'string') {
    throw createHttpError(400, 'Assigned vehicle id must be a string.');
  }

  const vehicleId = value.trim().toUpperCase();

  if (!VEHICLE_ID_PATTERN.test(vehicleId)) {
    throw createHttpError(400, 'Assigned vehicle id must look like VEH-0001.');
  }

  return vehicleId;
};

/**
 * Resolves the occupation and the truck together.
 *
 * <p>The one rule enforced here is that a Regular cleaner carries no truck,
 * because that contradiction is the administrator's to avoid regardless of what
 * the fleet happens to hold. The converse — a Driver must have a truck — is NOT
 * enforced: the office can hire a driver before any vehicle is free, and
 * refusing the account over a truck that does not exist yet would be worse than
 * recording the driver as unassigned.
 */
const resolveOccupationAndVehicle = (occupation, assignedVehicleId) => {
  const normalizedOccupation = normalizeOccupation(occupation);
  const normalizedVehicleId = normalizeAssignedVehicleId(assignedVehicleId);

  if (
    normalizedOccupation === PERSONNEL_OCCUPATIONS.REGULAR
    && normalizedVehicleId !== null
  ) {
    throw createHttpError(
      400,
      'Only a Driver can be assigned a vehicle.'
    );
  }

  return {
    occupation: normalizedOccupation,
    assignedVehicleId: normalizedVehicleId,
  };
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

  // The Admin client sends both spellings of each of these, the way it sends
  // both `email` and `gmail` above. Two names for one value is only safe while
  // they agree, so a payload that disagrees is refused rather than resolved by
  // silently taking whichever came first.
  const occupationSpellings = [
    payload.occupation,
    payload.occupationType,
    payload.occupation_type,
  ].filter((value) => value !== undefined && value !== null);
  if (
    occupationSpellings.some(
      (value) => String(value).trim().toLowerCase()
        !== String(occupationSpellings[0]).trim().toLowerCase()
    )
  ) {
    throw createHttpError(400, 'Occupation fields must match when more than one is provided.');
  }

  const vehicleSpellings = [
    payload.assignedVehicleId,
    payload.assigned_vehicle_id,
    payload.vehicleId,
    payload.vehicle_id,
  ].filter((value) => value !== undefined && value !== null);
  if (
    vehicleSpellings.some(
      (value) => String(value).trim().toUpperCase() !== String(vehicleSpellings[0]).trim().toUpperCase()
    )
  ) {
    throw createHttpError(400, 'Assigned vehicle fields must match when more than one is provided.');
  }

  const occupationInput = occupationSpellings[0];
  const vehicleInput = vehicleSpellings[0];
  const { occupation, assignedVehicleId } =
    resolveOccupationAndVehicle(occupationInput, vehicleInput);

  return {
    firstName: normalizeText(payload.firstName, 'First name', { maxLength: 100 }),
    lastName: normalizeText(payload.lastName, 'Last name', { maxLength: 100 }),
    address: normalizeMultilineText(payload.address, 'Address', { maxLength: 300 }),
    email: normalizeEmail(getEmailInput(payload)),
    username: normalizeUsername(payload.username),
    password: validatePassword(payload.password),
    phoneNumber: normalizePhoneNumber(payload.phoneNumber),
    messengerLink: normalizeMessengerLink(payload.messengerLink),
    occupation,
    assignedVehicleId,
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

  if (Object.prototype.hasOwnProperty.call(payload, 'messengerLink')) {
    updates.messengerLink = normalizeMessengerLink(payload.messengerLink);
  }

  const hasOccupation =
    Object.prototype.hasOwnProperty.call(payload, 'occupation')
    || Object.prototype.hasOwnProperty.call(payload, 'occupationType')
    || Object.prototype.hasOwnProperty.call(payload, 'occupation_type');
  const hasAssignedVehicle =
    Object.prototype.hasOwnProperty.call(payload, 'assignedVehicleId')
    || Object.prototype.hasOwnProperty.call(payload, 'assigned_vehicle_id')
    || Object.prototype.hasOwnProperty.call(payload, 'vehicleId')
    || Object.prototype.hasOwnProperty.call(payload, 'vehicle_id');

  // Occupation and truck are independent on an edit, so each is only returned
  // when it was actually sent. Whether the pair agrees is settled by the
  // controller, which is the only place that can see the account's current
  // occupation: sending just the truck means "keep the occupation I already
  // have", which is what lets a driver hired without a vehicle be given one
  // later, and sending just the occupation demotes to Regular and releases the
  // truck with it.
  if (hasOccupation) {
    updates.occupation = normalizeOccupation(
      payload.occupation ?? payload.occupationType ?? payload.occupation_type
    );
  }

  if (hasAssignedVehicle) {
    updates.assignedVehicleId = normalizeAssignedVehicleId(
      payload.assignedVehicleId
        ?? payload.assigned_vehicle_id
        ?? payload.vehicleId
        ?? payload.vehicle_id
    );
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
  PERSONNEL_OCCUPATIONS,
  PERSONNEL_OCCUPATION_VALUES,
  VEHICLE_ID_PATTERN,
  createHttpError,
  requireObject,
  normalizeText,
  normalizeMultilineText,
  normalizeEmail,
  normalizeUsername,
  normalizePhoneNumber,
  normalizeMessengerLink,
  requirePhoneNumber,
  validatePassword,
  validatePersonnelId,
  validateStatus,
  validateStatusPayload,
  normalizeOccupation,
  normalizeAssignedVehicleId,
  resolveOccupationAndVehicle,
  validateCreatePayload,
  validateUpdatePayload,
  parseListQuery,
};

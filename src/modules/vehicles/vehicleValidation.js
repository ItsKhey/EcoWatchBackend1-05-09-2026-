const VEHICLE_ID_PATTERN = /^VEH-[0-9]{4}$/;

/**
 * The fleet has one status, not a status plus a maintenance flag.
 *
 * 'Maintenance' being its own value is what keeps a truck under servicing from
 * also being counted as out on a collection: the Admin screen's three cards are
 * Total / Available / Assigned, and a flag alongside a status would let a single
 * vehicle answer to two of them at once.
 */
const VEHICLE_STATUSES = Object.freeze({
  AVAILABLE: 'Available',
  ASSIGNED: 'Assigned',
  MAINTENANCE: 'Maintenance',
});

const VEHICLE_STATUS_VALUES = Object.freeze(Object.values(VEHICLE_STATUSES));

/** Statuses a filter chip may ask for, or 'All'. */
const VEHICLE_FILTERS = Object.freeze(['All', ...VEHICLE_STATUS_VALUES]);

// Control characters would break the card layout and cannot appear in a real
// plate or a real vehicle type, so they are refused rather than stored.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const createHttpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const normalizeText = (value, fieldName, { required = true, maxLength = 255 } = {}) => {
  if (value === undefined || value === null) {
    if (required) throw createHttpError(400, `${fieldName} is required.`);
    return '';
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

/**
 * Normalises a number plate.
 *
 * <p>Upper-cased and inner whitespace collapsed, because the same plate is
 * typed as "abc 123", "ABC 123" and "ABC-123" by different hands and the unique
 * index treats those as three different vehicles. Hyphen and space are both kept
 * as written: the plate is displayed exactly as it was registered.
 */
const normalizePlateNumber = (value) => {
  const normalized = normalizeText(value, 'Plate number', { maxLength: 20 })
    .replace(/\s+/g, ' ')
    .toUpperCase();

  if (normalized.length < 2) {
    throw createHttpError(400, 'Plate number must be at least 2 characters.');
  }

  return normalized;
};

const normalizeVehicleType = (value) => normalizeText(value, 'Vehicle type', { maxLength: 60 });

/**
 * Validates and normalises a status.
 *
 * @param {*} value the raw status, in any casing the UI might send.
 * @param {{ allowUndefined?: boolean }} [options] when allowUndefined is true an
 *        omitted status returns null instead of throwing, for partial updates.
 */
const normalizeVehicleStatus = (value, { allowUndefined = false } = {}) => {
  if (value === undefined || value === null) {
    if (allowUndefined) return null;
    throw createHttpError(400, 'Status is required.');
  }
  if (typeof value !== 'string') {
    throw createHttpError(400, 'Status must be a string.');
  }

  const normalized = value.trim().toLowerCase();
  const match = VEHICLE_STATUS_VALUES.find((status) => status.toLowerCase() === normalized);
  if (!match) {
    throw createHttpError(
      400,
      `Status must be one of: ${VEHICLE_STATUS_VALUES.join(', ')}.`
    );
  }

  return match;
};

/**
 * Validates a status filter from a query string.
 *
 * @returns {string|null} the status to filter on, or null for 'All'/absent.
 */
const normalizeVehicleFilter = (value) => {
  if (value === undefined || value === null) return null;

  const normalized = String(value).trim().toLowerCase();
  if (!normalized || normalized === 'all') return null;

  const match = VEHICLE_STATUS_VALUES.find((status) => status.toLowerCase() === normalized);
  if (!match) {
    throw createHttpError(400, 'Unknown vehicle status filter.');
  }

  return match;
};

/**
 * Validates the report a vehicle is dispatched to.
 *
 * <p>'Assigned' without a report would leave the Admin screen showing a truck
 * that is out on a collection nobody can open, so the pairing is required here
 * rather than only in the UI form.
 */
const normalizeAssignment = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw createHttpError(400, 'Current report id must be a string.');
  }

  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 50) {
    throw createHttpError(400, 'Current report id must be at most 50 characters.');
  }
  if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw createHttpError(400, 'Current report id contains invalid characters.');
  }

  return normalized;
};

const normalizeVehicleId = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  if (!VEHICLE_ID_PATTERN.test(normalized)) {
    throw createHttpError(400, 'Vehicle id must look like VEH-0001.');
  }
  return normalized;
};

/**
 * Validates a create payload.
 *
 * <p>A vehicle cannot be created already on a collection, so the assignment is
 * rejected rather than quietly accepted and left dangling.
 */
const validateCreateVehiclePayload = (body = {}) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createHttpError(400, 'Request body must be a JSON object.');
  }

  const plateNumber = normalizePlateNumber(body.plateNumber ?? body.plate_number);
  const vehicleType = normalizeVehicleType(body.vehicleType ?? body.vehicle_type);

  const ratedLoad = normalizeText(
    body.ratedLoadCapacity ?? body.rated_load_capacity,
    'Rated load capacity',
    { required: false, maxLength: 40 }
  );

  const status = normalizeVehicleStatus(
    body.status ?? VEHICLE_STATUSES.AVAILABLE
  );

  if (status === VEHICLE_STATUSES.ASSIGNED) {
    throw createHttpError(400, 'A new vehicle cannot be created as Assigned.');
  }

  const notes = normalizeText(body.notes, 'Notes', { required: false, maxLength: 500 });

  return {
    plateNumber,
    vehicleType,
    ratedLoadCapacity: ratedLoad || null,
    status,
    notes: notes || null,
  };
};

/**
 * Validates a partial update payload.
 *
 * <p>Only the keys actually present are returned, so the caller can tell
 * "set this to empty" from "leave this alone". The status and its report are
 * validated together because the two are meaningless apart.
 */
const validateUpdateVehiclePayload = (body = {}) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createHttpError(400, 'Request body must be a JSON object.');
  }

  const updates = {};

  const hasPlate = body.plateNumber !== undefined || body.plate_number !== undefined;
  if (hasPlate) {
    updates.plateNumber = normalizePlateNumber(body.plateNumber ?? body.plate_number);
  }

  const hasType = body.vehicleType !== undefined || body.vehicle_type !== undefined;
  if (hasType) {
    updates.vehicleType = normalizeVehicleType(body.vehicleType ?? body.vehicle_type);
  }

  const hasRatedLoad = body.ratedLoadCapacity !== undefined
    || body.rated_load_capacity !== undefined;
  if (hasRatedLoad) {
    const ratedLoad = normalizeText(
      body.ratedLoadCapacity ?? body.rated_load_capacity,
      'Rated load capacity',
      { required: false, maxLength: 40 }
    );
    updates.ratedLoadCapacity = ratedLoad || null;
  }

  const hasNotes = body.notes !== undefined;
  if (hasNotes) {
    const notes = normalizeText(body.notes, 'Notes', { required: false, maxLength: 500 });
    updates.notes = notes || null;
  }

  const hasStatus = body.status !== undefined;
  const hasAssignment = body.currentReportId !== undefined || body.current_report_id !== undefined;

  if (hasStatus) {
    updates.status = normalizeVehicleStatus(body.status);
  }
  if (hasAssignment) {
    updates.currentReportId = normalizeAssignment(body.currentReportId ?? body.current_report_id);
  }

  if (updates.status === VEHICLE_STATUSES.ASSIGNED && !updates.currentReportId) {
    throw createHttpError(
      400,
      'Assigning a vehicle requires the report it is collecting.'
    );
  }
  if (
    updates.status
    && updates.status !== VEHICLE_STATUSES.ASSIGNED
    && updates.currentReportId
  ) {
    throw createHttpError(
      400,
      'Only an Assigned vehicle can be tied to a collection report.'
    );
  }

  if (Object.keys(updates).length === 0) {
    throw createHttpError(400, 'Nothing to update.');
  }

  return updates;
};

module.exports = {
  VEHICLE_ID_PATTERN,
  VEHICLE_STATUSES,
  VEHICLE_STATUS_VALUES,
  VEHICLE_FILTERS,
  createHttpError,
  normalizePlateNumber,
  normalizeVehicleId,
  normalizeVehicleFilter,
  normalizeVehicleStatus,
  validateCreateVehiclePayload,
  validateUpdateVehiclePayload,
};

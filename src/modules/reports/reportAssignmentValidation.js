const {
  ASSIGNMENT_ID_PATTERN,
  PERSONNEL_ID_PATTERN,
  VEHICLE_ID_PATTERN,
  createHttpError,
  requireObject,
} = require('../../shared/personnelValidation');
const { normalizeWasteScale } = require('../../shared/wasteScaleValidation');
const { normalizeTeamId } = require('../../shared/cleaningTeamValidation');

const MAX_ASSIGNED_PERSONNEL = 50;
const MAX_ADMIN_RESPONSE_LENGTH = 2000;
const MAX_PERSONNEL_NOTE_LENGTH = 2000;
const MAX_PRIORITY_LENGTH = 20;
const MAX_REPORT_ID_LENGTH = 50;
const IDENTIFIER_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const INVALID_TEXT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const readAlias = (payload, aliases) => {
  for (const alias of aliases) {
    if (hasOwn(payload, alias)) {
      return { present: true, value: payload[alias] };
    }
  }

  return { present: false, value: undefined };
};

const rejectServerOwnedFields = (payload) => {
  const serverOwnedAliases = [
    'adminId',
    'admin_id',
    'assignedByAdminId',
    'assigned_by_admin_id',
    'assignedAt',
    'assigned_at',
    'actorId',
    'actor_id',
    'residentId',
    'resident_id',
  ];

  for (const field of serverOwnedAliases) {
    if (hasOwn(payload, field)) {
      throw createHttpError(
        400,
        `${field} is server-owned and cannot be supplied by a client.`
      );
    }
  }
};

const normalizeReportId = (value) => {
  if (typeof value !== 'string') {
    throw createHttpError(400, 'Report ID must be a string.');
  }

  const reportId = value.trim();
  if (!reportId || reportId.length > MAX_REPORT_ID_LENGTH || IDENTIFIER_CONTROL_CHARACTERS.test(reportId)) {
    throw createHttpError(400, 'Report ID is invalid.');
  }

  return reportId;
};

const normalizePersonnelIdList = (value, fieldName) => {
  if (!Array.isArray(value)) {
    throw createHttpError(400, `${fieldName} must be an array.`);
  }

  if (value.length > MAX_ASSIGNED_PERSONNEL) {
    throw createHttpError(
      400,
      `A report cannot be assigned to more than ${MAX_ASSIGNED_PERSONNEL} personnel.`
    );
  }

  const normalized = value.map((personnelId) => {
    if (typeof personnelId !== 'string') {
      throw createHttpError(400, 'Every personnel ID must be a string.');
    }

    const id = personnelId.trim().toUpperCase();
    if (!ASSIGNMENT_ID_PATTERN.test(id)) {
      throw createHttpError(
        400,
        `${fieldName} entries must use PERS-XXXX or legacy RES-XXXXXXXX format.`
      );
    }

    return id;
  });

  return [...new Set(normalized)];
};

const normalizeSinglePersonnelId = (value, fieldName) => {
  if (typeof value !== 'string') {
    throw createHttpError(400, `${fieldName} must be a string.`);
  }

  const personnelId = value.trim().toUpperCase();
  if (!PERSONNEL_ID_PATTERN.test(personnelId)) {
    throw createHttpError(400, `${fieldName} must use the PERS-XXXX format.`);
  }

  return personnelId;
};

const normalizeVehicleId = (value, fieldName) => {
  if (typeof value !== 'string') {
    throw createHttpError(400, `${fieldName} must be a string.`);
  }

  const vehicleId = value.trim().toUpperCase();
  if (!VEHICLE_ID_PATTERN.test(vehicleId)) {
    throw createHttpError(400, `${fieldName} must use the VEH-XXXX format.`);
  }

  return vehicleId;
};

/**
 * Reads an optional field that may arrive under several aliases.
 *
 * The aliases are checked against each other so a client that sends both
 * "teamId" and "team_id" with different values is told rather than silently
 * resolved in favour of one of them.
 */
const readOptionalAlias = (payload, aliases, normalizer) => {
  const values = aliases
    .filter((alias) => hasOwn(payload, alias))
    .map((alias) => ({
      alias,
      value: normalizer(payload[alias], alias),
    }));

  if (values.length > 1) {
    const [first, ...rest] = values;
    if (rest.some((entry) => entry.value !== first.value)) {
      throw createHttpError(
        400,
        `Conflicting ${aliases[0]} fields were supplied.`
      );
    }
  }

  return values.length > 0 ? values[0].value : undefined;
};

const normalizeOptionalText = (value, fieldName, maxLength) => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw createHttpError(400, `${fieldName} must be a string.`);
  }

  const normalized = value.trim();
  if (normalized.length > maxLength || INVALID_TEXT_CONTROL_CHARACTERS.test(normalized)) {
    throw createHttpError(
      400,
      `${fieldName} must be at most ${maxLength} characters and contain no control characters.`
    );
  }

  return normalized;
};

/**
 * Validates both the Phase 2B single-assignment contract and the original
 * array-shaped admin contract. Client supplied actor/timestamp fields are
 * rejected rather than silently trusted.
 */
const validateReportAssignmentPayload = (
  body,
  { requireAdminResponse = false } = {}
) => {
  const payload = requireObject(body, 'Assignment request body');
  rejectServerOwnedFields(payload);

  const allowedFields = new Set([
    'personnelId',
    'personnel_id',
    'assignedPersonnelId',
    'assigned_personnel_id',
    'assignedPersonnelIds',
    'assigned_personnel_ids',
    'handledById',
    'handled_by_id',
    'adminResponse',
    'admin_response',
    // The administrator's note for the assigned cleaner. Separate from
    // adminResponse, which is the answer the resident reads.
    'personnelNote',
    'personnel_note',
    'priority',
    // Waste scale and the crew that matches it. The scale is chosen by the
    // resident when the report is filed; the admin is bound by it when
    // assigning, so the crew and the truck have to fit the scale.
    'wasteScale',
    'waste_scale',
    'teamId',
    'team_id',
    'assignedTeamId',
    'assigned_team_id',
    'vehicleId',
    'vehicle_id',
    'assignedVehicleId',
    'assigned_vehicle_id',
  ]);
  for (const field of Object.keys(payload)) {
    if (!allowedFields.has(field)) {
      throw createHttpError(400, `Unknown assignment field: ${field}.`);
    }
  }

  const canonicalAliases = [
    'personnelId',
    'personnel_id',
    'assignedPersonnelId',
    'assigned_personnel_id',
  ];
  const canonicalValues = canonicalAliases
    .filter((alias) => hasOwn(payload, alias))
    .map((alias) => ({
      alias,
      value: normalizeSinglePersonnelId(payload[alias], alias),
    }));
  const canonicalIds = [...new Set(canonicalValues.map((entry) => entry.value))];
  if (canonicalIds.length > 1) {
    throw createHttpError(400, 'Conflicting personnel ID fields were supplied.');
  }

  const canonical = {
    present: canonicalValues.length > 0,
    value: canonicalValues[0]?.value,
  };
  const legacyListAliases = ['assignedPersonnelIds', 'assigned_personnel_ids'];
  const legacyValues = legacyListAliases
    .filter((alias) => hasOwn(payload, alias))
    .map((alias) => ({
      alias,
      value: normalizePersonnelIdList(payload[alias], alias),
    }));
  if (
    legacyValues.length > 1 &&
    JSON.stringify(legacyValues[0].value) !== JSON.stringify(legacyValues[1].value)
  ) {
    throw createHttpError(400, 'Conflicting assignedPersonnelIds fields were supplied.');
  }
  const legacyList = {
    present: legacyValues.length > 0,
    value: legacyValues[0]?.value,
  };

  let assignedPersonnelIds;
  let canonicalPersonnelId = null;
  let isLegacyArrayRequest = false;

  if (canonical.present) {
    canonicalPersonnelId = canonical.value;

    if (legacyList.present) {
      const list = normalizePersonnelIdList(
        legacyList.value,
        'assignedPersonnelIds'
      );
      if (list.length !== 1 || list[0] !== canonicalPersonnelId) {
        throw createHttpError(
          400,
          'personnelId must match the single assignedPersonnelIds entry when both fields are supplied.'
        );
      }
    }

    assignedPersonnelIds = [canonicalPersonnelId];
  } else {
    if (!legacyList.present) {
      throw createHttpError(
        400,
        'personnelId is required for a report assignment.'
      );
    }

    assignedPersonnelIds = normalizePersonnelIdList(
      legacyList.value,
      'assignedPersonnelIds'
    );
    isLegacyArrayRequest = true;

    if (assignedPersonnelIds.length === 0) {
      throw createHttpError(400, 'At least one personnel ID is required.');
    }
  }

  const handledAliases = ['handledById', 'handled_by_id'];
  const handledValues = handledAliases
    .filter((alias) => hasOwn(payload, alias))
    .map((alias) => ({
      alias,
      value: payload[alias] === null
        ? null
        : normalizeSinglePersonnelId(payload[alias], alias),
    }));
  if (
    handledValues.length > 1 &&
    handledValues[0].value !== handledValues[1].value
  ) {
    throw createHttpError(400, 'Conflicting handledById fields were supplied.');
  }
  const handledById = handledValues[0]?.value || null;

  if (
    canonicalPersonnelId &&
    handledById &&
    canonicalPersonnelId !== handledById
  ) {
    throw createHttpError(
      400,
      'handledById must match personnelId for a single-assignment request.'
    );
  }

  const responseAliases = ['adminResponse', 'admin_response'];
  const responseValues = responseAliases
    .filter((alias) => hasOwn(payload, alias))
    .map((alias) => ({
      alias,
      value: normalizeOptionalText(
        payload[alias],
        alias,
        MAX_ADMIN_RESPONSE_LENGTH
      ),
    }));
  if (
    responseValues.length > 1 &&
    responseValues[0].value !== responseValues[1].value
  ) {
    throw createHttpError(400, 'Conflicting adminResponse fields were supplied.');
  }
  const adminResponse = responseValues[0]?.value;
  if (requireAdminResponse && !adminResponse) {
    throw createHttpError(400, 'adminResponse is required for an assignment.');
  }

  // Optional: an admin may address the resident, the cleaner, or both. Omitting
  // it leaves any existing note untouched rather than clearing it, so a repeated
  // save that only edits the resident response cannot silently wipe the
  // cleaner's instructions.
  const noteAliases = ['personnelNote', 'personnel_note'];
  const noteValues = noteAliases
    .filter((alias) => hasOwn(payload, alias))
    .map((alias) => ({
      alias,
      value: normalizeOptionalText(
        payload[alias],
        alias,
        MAX_PERSONNEL_NOTE_LENGTH
      ),
    }));
  if (
    noteValues.length > 1
    && noteValues[0].value !== noteValues[1].value
  ) {
    throw createHttpError(400, 'Conflicting personnelNote fields were supplied.');
  }
  const personnelNote = noteValues[0]?.value;

  const priority = readAlias(payload, ['priority']);
  const normalizedPriority = normalizeOptionalText(
    priority.present ? priority.value : undefined,
    'priority',
    MAX_PRIORITY_LENGTH
  );
  if (normalizedPriority !== undefined && !normalizedPriority) {
    throw createHttpError(400, 'priority must not be empty.');
  }

  // The waste scale decides how much has to be sent to the site. It is taken
  // from the payload when supplied, because the admin may restate it while
  // dispatching; when it is omitted the caller falls back to the scale the
  // resident filed the report under.
  const wasteScale = readOptionalAlias(
    payload,
    ['wasteScale', 'waste_scale'],
    (value, alias) => {
      if (value === null) return null;
      try {
        return normalizeWasteScale(value);
      } catch (error) {
        error.message = error.message.replace(/wasteScale/g, alias);
        throw error;
      }
    }
  );

  // The cleaning team and the collection vehicle that go with the scale.
  // Either may be null, which means "no team" / "no vehicle".
  const teamId = readOptionalAlias(
    payload,
    ['teamId', 'team_id', 'assignedTeamId', 'assigned_team_id'],
    (value, alias) => (value === null ? null : normalizeTeamId(value, alias))
  );

  const vehicleId = readOptionalAlias(
    payload,
    ['vehicleId', 'vehicle_id', 'assignedVehicleId', 'assigned_vehicle_id'],
    (value, alias) => (value === null ? null : normalizeVehicleId(value, alias))
  );

  return {
    assignedPersonnelIds,
    canonicalPersonnelId,
    handledById,
    adminResponse,
    personnelNote,
    priority: normalizedPriority,
    wasteScale,
    teamId,
    vehicleId,
    isLegacyArrayRequest,
  };
};

module.exports = {
  MAX_ASSIGNED_PERSONNEL,
  MAX_ADMIN_RESPONSE_LENGTH,
  MAX_PERSONNEL_NOTE_LENGTH,
  normalizeReportId,
  validateReportAssignmentPayload,
};

/**
 * The waste scale a report is filed under.
 *
 * A resident tells the CENRO how big a problem they are reporting, and that
 * single label decides how much has to be sent to the site:
 *
 *   Small-Scale Waste  -> one individual personnel member walks in and clears it.
 *   Medium-Scale Waste -> a cleaning team turns out, but no truck is needed.
 *   Large-Scale Waste  -> a cleaning team turns out with a collection vehicle.
 *
 * The scale is chosen by the resident when the report is filed and is stored on
 * the report. The administrator is bound by it when assigning: the assignment
 * payload has to match the scale, otherwise a Large-Scale Waste could be
 * handed to a single cleaner with no truck, which is the exact failure this
 * vocabulary exists to prevent.
 */

const { createHttpError } = require('./personnelValidation');

const WASTE_SCALE = Object.freeze({
  SMALL: 'Small-Scale Waste',
  MEDIUM: 'Medium-Scale Waste',
  LARGE: 'Large-Scale Waste',
});

/** Every accepted scale, in increasing order of effort. */
const WASTE_SCALES = Object.freeze([
  WASTE_SCALE.SMALL,
  WASTE_SCALE.MEDIUM,
  WASTE_SCALE.LARGE,
]);

/**
 * The longest scale text the server accepts.
 *
 * The canonical values run to 18 characters ("Medium-Scale Waste"), so this
 * leaves room for a client that spells one out in a different case without
 * letting an unbounded string reach the fold below.
 */
const MAX_WASTE_SCALE_LENGTH = 30;

/**
 * How many people the scale needs before a truck is even worth considering.
 *
 * A single person handles Small-Scale Waste on their own. Anything bigger is a
 * team job, so a team assignment is rejected when it carries fewer people
 * than this.
 */
const TEAM_MINIMUM_CREW_SIZE = 2;

const WASTE_SCALE_ALIASES = Object.freeze({
  [WASTE_SCALE.SMALL]: 'small',
  [WASTE_SCALE.MEDIUM]: 'medium',
  [WASTE_SCALE.LARGE]: 'large',
});

/**
 * Folds the spellings a client might send onto the canonical vocabulary.
 *
 * The clients are Android apps that may be a release or two apart, so the
 * server accepts the hyphenated display text, the bare adjective, and the
 * snake_case field name spelling, and always stores the display text.
 */
const normalizeWasteScale = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw createHttpError(400, 'wasteScale must be a string.');
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.length > MAX_WASTE_SCALE_LENGTH) {
    throw createHttpError(
      400,
      `wasteScale must be at most ${MAX_WASTE_SCALE_LENGTH} characters.`
    );
  }

  const key = trimmed.toLowerCase().replace(/[_\s]+/g, '-');

  for (const scale of WASTE_SCALES) {
    if (scale.toLowerCase() === key) return scale;
    if (WASTE_SCALE_ALIASES[scale] === key) return scale;
    if (scale.toLowerCase().replace(/\s+/g, '-') === key) return scale;
  }

  throw createHttpError(
    400,
    `wasteScale must be one of: ${WASTE_SCALES.join(', ')}.`
  );
};

/** The scale to fall back on when a report predates the feature. */
const DEFAULT_WASTE_SCALE = WASTE_SCALE.SMALL;

/** True when the scale is one of the three accepted values. */
const isWasteScale = (value) => WASTE_SCALES.includes(value);

/** True when the scale needs a crew rather than a single cleaner. */
const requiresTeam = (scale) =>
  scale === WASTE_SCALE.MEDIUM || scale === WASTE_SCALE.LARGE;

/** True when the scale needs a collection vehicle on site. */
const requiresVehicle = (scale) => scale === WASTE_SCALE.LARGE;

/**
 * The minimum number of people a crew assignment for this scale must carry.
 *
 * Small-Scale Waste is a single-person job, so it asks for exactly one.
 */
const minimumCrewSize = (scale) =>
  requiresTeam(scale) ? TEAM_MINIMUM_CREW_SIZE : 1;

/**
 * Checks that an assignment matches the scale the report was filed under.
 *
 * @param {string|null} scale          the report's waste scale
 * @param {string[]} personnelIds      the people assigned
 * @param {string|null} vehicleId      the collection vehicle assigned, if any
 * @param {string|null} teamId         the cleaning team assigned, if any
 */
const assertAssignmentMatchesScale = ({
  scale,
  personnelIds = [],
  vehicleId = null,
  teamId = null,
}) => {
  if (!scale) return;

  const crewSize = personnelIds.length;

  if (!requiresTeam(scale)) {
    // Small-Scale Waste is a one-person job. More than one person is not
    // forbidden, but a team or a truck on a small job is a dispatch mistake
    // worth surfacing rather than silently accepting.
    if (teamId) {
      throw createHttpError(
        400,
        `${scale} is handled by one personnel member and cannot be assigned to a cleaning team.`
      );
    }
    if (vehicleId) {
      throw createHttpError(
        400,
        `${scale} is handled without a collection vehicle.`
      );
    }
    return;
  }

  if (crewSize < TEAM_MINIMUM_CREW_SIZE) {
    throw createHttpError(
      400,
      `${scale} requires a cleaning team of at least ${TEAM_MINIMUM_CREW_SIZE} personnel.`
    );
  }

  if (requiresVehicle(scale) && !vehicleId) {
    throw createHttpError(
      400,
      `${scale} requires a collection vehicle to be assigned.`
    );
  }

  if (!requiresVehicle(scale) && vehicleId) {
    throw createHttpError(
      400,
      `${scale} is handled without a collection vehicle.`
    );
  }
};

module.exports = {
  WASTE_SCALE,
  WASTE_SCALES,
  DEFAULT_WASTE_SCALE,
  TEAM_MINIMUM_CREW_SIZE,
  MAX_WASTE_SCALE_LENGTH,
  normalizeWasteScale,
  isWasteScale,
  requiresTeam,
  requiresVehicle,
  minimumCrewSize,
  assertAssignmentMatchesScale,
};

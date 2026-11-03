const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WASTE_SCALE,
  WASTE_SCALES,
  DEFAULT_WASTE_SCALE,
  TEAM_MINIMUM_CREW_SIZE,
  normalizeWasteScale,
  isWasteScale,
  requiresTeam,
  requiresVehicle,
  minimumCrewSize,
  assertAssignmentMatchesScale,
} = require('../src/shared/wasteScaleValidation');

test('the vocabulary is the three scales, smallest first', () => {
  assert.deepEqual(WASTE_SCALES, [
    'Small-Scale Waste',
    'Medium-Scale Waste',
    'Large-Scale Waste',
  ]);
  assert.equal(WASTE_SCALE.SMALL, 'Small-Scale Waste');
  assert.equal(WASTE_SCALE.MEDIUM, 'Medium-Scale Waste');
  assert.equal(WASTE_SCALE.LARGE, 'Large-Scale Waste');
});

test('a report filed before the feature is a small job', () => {
  assert.equal(DEFAULT_WASTE_SCALE, WASTE_SCALE.SMALL);
});

test('the spellings a client might send all fold onto the canonical text', () => {
  assert.equal(normalizeWasteScale('Small-Scale Waste'), 'Small-Scale Waste');
  assert.equal(normalizeWasteScale('Medium-Scale Waste'), 'Medium-Scale Waste');
  assert.equal(normalizeWasteScale('Large-Scale Waste'), 'Large-Scale Waste');
  assert.equal(normalizeWasteScale('  Large-Scale Waste  '), 'Large-Scale Waste');
  assert.equal(normalizeWasteScale('large-scale-waste'), 'Large-Scale Waste');
  assert.equal(normalizeWasteScale('large_scale_waste'), 'Large-Scale Waste');
  assert.equal(normalizeWasteScale('small'), 'Small-Scale Waste');
  assert.equal(normalizeWasteScale('MEDIUM'), 'Medium-Scale Waste');
  assert.equal(normalizeWasteScale('large'), 'Large-Scale Waste');
});

test('an absent scale stays absent so the caller can apply the default', () => {
  assert.equal(normalizeWasteScale(undefined), null);
  assert.equal(normalizeWasteScale(null), null);
  assert.equal(normalizeWasteScale(''), null);
  assert.equal(normalizeWasteScale('   '), null);
});

test('an unknown scale is rejected rather than guessed at', () => {
  assert.throws(
    () => normalizeWasteScale('Enormous-Scale Waste'),
    /must be one of/
  );
  assert.throws(
    () => normalizeWasteScale(7),
    /must be a string/
  );
  assert.throws(
    () => normalizeWasteScale('x'.repeat(200)),
    /at most/
  );
});

test('isWasteScale only accepts the canonical text', () => {
  assert.equal(isWasteScale('Small-Scale Waste'), true);
  assert.equal(isWasteScale('small'), false);
  assert.equal(isWasteScale(null), false);
});

test('a medium or large job needs a crew, only a large one needs a truck', () => {
  assert.equal(requiresTeam(WASTE_SCALE.SMALL), false);
  assert.equal(requiresTeam(WASTE_SCALE.MEDIUM), true);
  assert.equal(requiresTeam(WASTE_SCALE.LARGE), true);

  assert.equal(requiresVehicle(WASTE_SCALE.SMALL), false);
  assert.equal(requiresVehicle(WASTE_SCALE.MEDIUM), false);
  assert.equal(requiresVehicle(WASTE_SCALE.LARGE), true);
});

test('a small job takes one person, anything bigger takes a crew', () => {
  assert.equal(minimumCrewSize(WASTE_SCALE.SMALL), 1);
  assert.equal(minimumCrewSize(WASTE_SCALE.MEDIUM), TEAM_MINIMUM_CREW_SIZE);
  assert.equal(minimumCrewSize(WASTE_SCALE.LARGE), TEAM_MINIMUM_CREW_SIZE);
});

test('a small job is cleared by one person, with no crew and no truck', () => {
  assert.doesNotThrow(() => assertAssignmentMatchesScale({
    scale: WASTE_SCALE.SMALL,
    personnelIds: ['PERS-0001'],
  }));
});

test('a small job refuses a crew or a truck', () => {
  assert.throws(
    () => assertAssignmentMatchesScale({
      scale: WASTE_SCALE.SMALL,
      personnelIds: ['PERS-0001', 'PERS-0002'],
      teamId: 'TEAM-0001',
    }),
    /cannot be assigned to a cleaning team/
  );
  assert.throws(
    () => assertAssignmentMatchesScale({
      scale: WASTE_SCALE.SMALL,
      personnelIds: ['PERS-0001'],
      vehicleId: 'VEH-0001',
    }),
    /without a collection vehicle/
  );
});

test('a medium job takes a crew and refuses a truck', () => {
  assert.doesNotThrow(() => assertAssignmentMatchesScale({
    scale: WASTE_SCALE.MEDIUM,
    personnelIds: ['PERS-0001', 'PERS-0002'],
    teamId: 'TEAM-0001',
  }));

  assert.throws(
    () => assertAssignmentMatchesScale({
      scale: WASTE_SCALE.MEDIUM,
      personnelIds: ['PERS-0001', 'PERS-0002'],
      teamId: 'TEAM-0001',
      vehicleId: 'VEH-0001',
    }),
    /without a collection vehicle/
  );
});

test('a medium job refuses to be handed to a single person', () => {
  assert.throws(
    () => assertAssignmentMatchesScale({
      scale: WASTE_SCALE.MEDIUM,
      personnelIds: ['PERS-0001'],
    }),
    /at least 2 personnel/
  );
});

test('a large job takes a crew and a truck', () => {
  assert.doesNotThrow(() => assertAssignmentMatchesScale({
    scale: WASTE_SCALE.LARGE,
    personnelIds: ['PERS-0001', 'PERS-0002'],
    teamId: 'TEAM-0001',
    vehicleId: 'VEH-0001',
  }));
});

test('a large job refuses to go out without the truck', () => {
  assert.throws(
    () => assertAssignmentMatchesScale({
      scale: WASTE_SCALE.LARGE,
      personnelIds: ['PERS-0001', 'PERS-0002'],
      teamId: 'TEAM-0001',
    }),
    /requires a collection vehicle/
  );
});

test('a report with no scale is not held to the rules', () => {
  assert.doesNotThrow(() => assertAssignmentMatchesScale({
    scale: null,
    personnelIds: ['PERS-0001'],
    vehicleId: 'VEH-0001',
  }));
});

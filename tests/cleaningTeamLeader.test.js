const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeTeamLeaderId,
  validateCreateTeamPayload,
  validateUpdateTeamPayload,
} = require('../src/shared/cleaningTeamValidation');

test('a leader id is normalised like a member id', () => {
  assert.equal(normalizeTeamLeaderId(' pers-0001 '), 'PERS-0001');
  // No leader is a real state, not an invalid one: every team created before
  // leaders existed has none.
  assert.equal(normalizeTeamLeaderId(null), null);
  assert.equal(normalizeTeamLeaderId(''), null);
  assert.equal(normalizeTeamLeaderId(undefined), null);

  assert.throws(
    () => normalizeTeamLeaderId('TEAM-0001'),
    (error) => error.statusCode === 400
  );
  assert.throws(
    () => normalizeTeamLeaderId(42),
    (error) => error.statusCode === 400
  );
});

test('create reads the leader from either spelling', () => {
  const camel = validateCreateTeamPayload({
    teamName: 'North Crew',
    leaderId: 'pers-0002',
    memberIds: ['PERS-0001', 'PERS-0002'],
  });
  assert.equal(camel.leaderId, 'PERS-0002');

  const snake = validateCreateTeamPayload({
    team_name: 'North Crew',
    leader_personnel_id: 'PERS-0003',
    member_ids: ['PERS-0003', 'PERS-0004'],
  });
  assert.equal(snake.leaderId, 'PERS-0003');
});

test('an update can tell "no leader mentioned" from "clear the leader"', () => {
  const nameOnly = validateUpdateTeamPayload({ teamName: 'Renamed' });
  assert.ok(!('leaderId' in nameOnly), 'a rename must not touch the leader');

  const cleared = validateUpdateTeamPayload({ leaderId: null });
  assert.equal(cleared.leaderId, null);

  const changed = validateUpdateTeamPayload({ leaderId: 'pers-0009' });
  assert.equal(changed.leaderId, 'PERS-0009');
});

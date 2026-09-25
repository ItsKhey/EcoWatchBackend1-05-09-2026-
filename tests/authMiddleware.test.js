const test = require('node:test');
const assert = require('node:assert/strict');

const { protectResident } = require('../middleware/authMiddleware');

test('protectResident accepts only a normal resident identity', () => {
  const req = {
    resident: {
      resident_id: 'RES-001',
      role: 'RESIDENT',
    },
  };
  let nextError;
  protectResident(req, {}, (error) => {
    nextError = error;
  });

  assert.equal(nextError, undefined);
  assert.deepEqual(req.auth, {
    accountType: 'RESIDENT',
    role: 'RESIDENT',
    residentId: 'RES-001',
  });
});

test('protectResident rejects admin and legacy personnel identities', () => {
  for (const resident of [
    { resident_id: 'ADM-001', role: 'ADMIN' },
    { resident_id: 'RES-LEGACY', role: 'Environmental Services Personnel' },
  ]) {
    let nextError;
    protectResident({ resident }, {}, (error) => {
      nextError = error;
    });
    assert.equal(nextError?.statusCode, 403);
  }
});

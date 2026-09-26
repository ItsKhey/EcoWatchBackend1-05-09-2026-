const test = require('node:test');
const assert = require('node:assert/strict');

const { getResidentLoginDecision } = require('../utils/residentAuth');

const activeResident = {
  resident_id: 'RES-0001',
  role: 'RESIDENT',
  status: 'AVAILABLE',
  disabled_by_resident: false,
};

test('an active resident logs in with the correct password', () => {
  assert.deepEqual(getResidentLoginDecision(activeResident, true), {
    allowed: true,
    mustRestore: false,
    reason: 'active',
  });
});

test('an active resident is rejected with the wrong password', () => {
  assert.deepEqual(getResidentLoginDecision(activeResident, false), {
    allowed: false,
    mustRestore: false,
    reason: 'invalid_password',
  });
});

test('a self-paused account is restored by its owner on the next login', () => {
  const paused = {
    ...activeResident,
    status: 'DISABLED',
    disabled_by_resident: true,
  };

  assert.deepEqual(getResidentLoginDecision(paused, true), {
    allowed: true,
    mustRestore: true,
    reason: 'restore_self_paused',
  });
});

test('a wrong password can never un-pause an account', () => {
  const paused = {
    ...activeResident,
    status: 'DISABLED',
    disabled_by_resident: true,
  };

  assert.deepEqual(getResidentLoginDecision(paused, false), {
    allowed: false,
    mustRestore: false,
    reason: 'account_disabled',
  });
});

test('an account disabled by an administrator stays blocked even with the right password', () => {
  for (const status of ['DISABLED', 'INACTIVE', 'BLOCKED', 'SUSPENDED', 'DELETED']) {
    const administratorDisabled = {
      ...activeResident,
      status,
      disabled_by_resident: false,
    };

    assert.deepEqual(
      getResidentLoginDecision(administratorDisabled, true),
      {
        allowed: false,
        mustRestore: false,
        reason: 'account_disabled',
      },
      `status ${status} must not be restorable by the resident`
    );
  }
});

test('a soft-deleted or explicitly disabled row is never restorable', () => {
  // The self-pause marker alone must not be enough: a stronger signal such as a
  // soft delete or an explicit disable flag always wins.
  for (const override of [
    { deleted_at: new Date() },
    { deleted_at: null, enabled: false },
  ]) {
    const resident = {
      ...activeResident,
      status: 'DISABLED',
      disabled_by_resident: true,
      ...override,
    };

    assert.deepEqual(
      getResidentLoginDecision(resident, true),
      {
        allowed: false,
        mustRestore: false,
        reason: 'account_disabled',
      },
      `override ${JSON.stringify(override)} must not be restorable`
    );
  }
});

test('a missing account is rejected without a database round trip', () => {
  assert.deepEqual(getResidentLoginDecision(null, false), {
    allowed: false,
    mustRestore: false,
    reason: 'no_account',
  });
});

test('a legacy personnel compatibility row is never restored as a resident', () => {
  const legacyPersonnel = {
    resident_id: 'RES-LEGACY',
    role: 'Environmental Services Personnel',
    status: 'DISABLED',
    disabled_by_resident: true,
  };

  assert.deepEqual(getResidentLoginDecision(legacyPersonnel, true), {
    allowed: false,
    mustRestore: false,
    reason: 'account_disabled',
  });
});

test('an active legacy personnel row still authenticates for compatibility', () => {
  const legacyPersonnel = {
    resident_id: 'RES-LEGACY',
    role: 'Environmental Services Personnel',
    status: 'AVAILABLE',
    disabled_by_resident: false,
  };

  assert.deepEqual(getResidentLoginDecision(legacyPersonnel, true), {
    allowed: true,
    mustRestore: false,
    reason: 'active',
  });
});

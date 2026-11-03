const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeMessengerLink,
  normalizePhoneNumber,
  validateCreatePayload,
  validateUpdatePayload,
} = require('../src/shared/personnelValidation');

test('a messenger link must be an absolute http(s) URL', () => {
  assert.equal(normalizeMessengerLink('https://m.me/anareyes'), 'https://m.me/anareyes');
  assert.equal(normalizeMessengerLink('http://m.me/anareyes'), 'http://m.me/anareyes');

  // Without a scheme the client cannot hand the value to Messenger, so it is
  // rejected rather than stored and silently failing at tap time.
  assert.throws(
    () => normalizeMessengerLink('m.me/anareyes'),
    /absolute http/
  );
  assert.throws(
    () => normalizeMessengerLink('javascript:alert(1)'),
    /absolute http/
  );
});

test('an absent messenger link is stored as null so the row stays hidden', () => {
  assert.equal(normalizeMessengerLink(undefined), null);
  assert.equal(normalizeMessengerLink(null), null);
  assert.equal(normalizeMessengerLink(''), null);
  assert.equal(normalizeMessengerLink('   '), null);
});

test('a messenger link that is only whitespace is treated as absent', () => {
  // normalizeText collapses the value, and the emptiness check happens after
  // the length guard, so a blank string must not be mistaken for a URL.
  assert.equal(normalizeMessengerLink('  '), null);
});

test('creation accepts an optional messenger link and phone number', () => {
  const payload = validateCreatePayload({
    firstName: 'Ana',
    lastName: 'Reyes',
    address: 'North Park',
    gmail: 'ana@gmail.com',
    username: 'ana.reyes',
    password: 'StrongPass123',
    phoneNumber: '+63 917 000 0000',
    messengerLink: 'https://m.me/anareyes',
  });

  assert.equal(payload.phoneNumber, '+63 917 000 0000');
  assert.equal(payload.messengerLink, 'https://m.me/anareyes');
});

test('creation without contact fields still succeeds and stores nulls', () => {
  const payload = validateCreatePayload({
    firstName: 'Ana',
    lastName: 'Reyes',
    address: 'North Park',
    gmail: 'ana@gmail.com',
    username: 'ana.reyes',
    password: 'StrongPass123',
  });

  assert.equal(payload.phoneNumber, null);
  assert.equal(payload.messengerLink, null);
});

test('an empty messenger link on update clears the stored one', () => {
  // The admin blanks the field to remove it, so an empty value has to survive
  // validation as an explicit null rather than being dropped as "no change".
  const updates = validateUpdatePayload({ messengerLink: '' });

  assert.equal(updates.messengerLink, null);
  assert.ok('messengerLink' in updates);
});

test('update still rejects an unowned field on its own', () => {
  assert.throws(
    () => validateUpdatePayload({ currentAssignmentReportId: 'REP-1' }),
    /At least one editable personnel field/
  );
});

test('the phone constraint is unchanged by the messenger work', () => {
  assert.equal(normalizePhoneNumber('09170000001'), '09170000001');
  assert.throws(() => normalizePhoneNumber('12345'), /Phone number format is invalid/);
  assert.throws(
    () => normalizePhoneNumber('0917-0000-0001 ext 9'),
    /Phone number format is invalid/
  );
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeReportStatus,
  validateResponsePayload,
  validateStatusPayload,
} = require('../utils/reportStatusValidation');

test('normalizes supported admin report statuses', () => {
  assert.equal(normalizeReportStatus('in_progress'), 'In Progress');
  assert.equal(normalizeReportStatus(' DENIED '), 'Denied');
  assert.equal(normalizeReportStatus('unknown'), null);
});

test('In Progress and Denied require a resident-visible admin response', () => {
  assert.throws(
    () => validateStatusPayload({ status: 'In Progress' }),
    /adminResponse is required/
  );
  assert.deepEqual(
    validateStatusPayload({
      status: 'Denied',
      adminResponse: 'This location is outside the service area.',
    }),
    {
      status: 'Denied',
      adminResponse: 'This location is outside the service area.',
    }
  );
});

test('response-only updates cannot smuggle status or actor fields', () => {
  assert.deepEqual(
    validateResponsePayload({ adminResponse: 'Cleanup is scheduled.' }),
    { adminResponse: 'Cleanup is scheduled.' }
  );
  assert.throws(
    () => validateResponsePayload({
      adminResponse: 'Cleanup is scheduled.',
      status: 'Completed',
      adminId: 'ADM-CLIENT',
    }),
    /server-owned/
  );
});

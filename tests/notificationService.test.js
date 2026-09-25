const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NOTIFICATION_TYPES,
  eventContent,
  normalizeEventType,
  validateCreateEventRequest,
} = require('../services/notificationService');

const report = {
  report_id: 'REP-001',
  resident_id: 'RES-001',
  admin_response: 'Please keep the area clear.',
};

test('server owns every required report notification message', () => {
  assert.deepEqual(
    Object.values(NOTIFICATION_TYPES),
    [
      'PERSONNEL_ASSIGNED',
      'PERSONNEL_UNASSIGNED',
      'CLEANING_STARTED',
      'ADMIN_RESPONSE_UPDATED',
      'REPORT_DENIED',
      'REPORT_COMPLETED',
    ]
  );

  for (const type of Object.values(NOTIFICATION_TYPES)) {
    const content = eventContent(type, report);
    assert.ok(content.title.length > 0);
    assert.match(content.message, /REP-001/);
  }
});

test('admin event endpoint accepts only reportId and type', () => {
  assert.deepEqual(
    validateCreateEventRequest({ reportId: 'REP-001', type: 'report_denied' }),
    { reportId: 'REP-001', type: 'REPORT_DENIED' }
  );

  assert.throws(
    () => validateCreateEventRequest({
      reportId: 'REP-001',
      type: 'REPORT_DENIED',
      residentId: 'RES-OTHER',
      title: 'Client title',
      message: 'Client message',
    }),
    /server-owned/
  );
});

test('unsupported client event types are rejected', () => {
  assert.throws(() => normalizeEventType('ANNOUNCEMENT'), /supported/);
});

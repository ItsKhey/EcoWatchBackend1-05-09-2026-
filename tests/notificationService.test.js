const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NOTIFICATION_TYPES,
  ADMIN_EVENT_TYPES,
  eventContent,
  isAdminEventType,
  isBroadcastEventType,
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
      'NEW_REPORT',
      'ANNOUNCEMENT',
    ]
  );

  // ANNOUNCEMENT is excluded on purpose: it is a broadcast with no report, so
  // its copy comes from announcementContent rather than this report-shaped
  // builder. It is covered in announcementNotification.test.js.
  for (const type of Object.values(NOTIFICATION_TYPES).filter(
    (value) => value !== 'ANNOUNCEMENT'
  )) {
    const content = eventContent(type, report);
    assert.ok(content.title.length > 0);
    assert.match(content.message, /REP-001/);
  }
});

// Phase 3A — NEW_REPORT is the only administrator-facing event; every other
// type is still delivered to the resident who owns the report.
test('only NEW_REPORT is addressed to administrators', () => {
  assert.deepEqual(ADMIN_EVENT_TYPES, ['NEW_REPORT']);
  assert.equal(isAdminEventType('NEW_REPORT'), true);

  for (const type of Object.values(NOTIFICATION_TYPES).filter((value) => value !== 'NEW_REPORT')) {
    assert.equal(isAdminEventType(type), false);
  }
});

test('NEW_REPORT content is server-authored and names the report', () => {
  const content = eventContent('NEW_REPORT', report);
  assert.equal(content.title, 'New Report Submitted');
  assert.match(content.message, /resident submitted a new report/i);
  assert.match(content.message, /REP-001/);
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
  assert.throws(() => normalizeEventType('NOT_A_REAL_EVENT'), /supported/);
});

test('ANNOUNCEMENT is a known type but is not a report event', () => {
  // It is a real notification type now, so normalizeEventType accepts it.
  assert.equal(normalizeEventType('ANNOUNCEMENT'), 'ANNOUNCEMENT');
  assert.equal(isBroadcastEventType('ANNOUNCEMENT'), true);
  assert.equal(isAdminEventType('ANNOUNCEMENT'), false);

  // It must not be creatable through the report-event route, which would
  // attach a broadcast to an unrelated report.
  assert.throws(
    () => validateCreateEventRequest({ reportId: 'REP-001', type: 'ANNOUNCEMENT' }),
    /report event/
  );
});

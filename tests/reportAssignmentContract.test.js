const test = require('node:test');
const assert = require('node:assert/strict');

const { mapAssignmentReport } = require('../services/reportAssignmentService');

test('assignment responses retain the authoritative report created_at', () => {
  const result = mapAssignmentReport({
    report_id: 'REP-001',
    resident_id: 'RES-001',
    title: 'Waste pile',
    status: 'In Progress',
    admin_response: 'Personnel assigned.',
    created_at: '2026-09-25T05:53:12.123+00:00',
    assigned_personnel_id: 'PERS-0001',
  });

  assert.equal(result.created_at, '2026-09-25T05:53:12.123+00:00');
  assert.equal(result.assignedPersonnelId, 'PERS-0001');
});

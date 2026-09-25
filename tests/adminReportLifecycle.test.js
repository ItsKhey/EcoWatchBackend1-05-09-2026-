const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeReport,
  bulkLifecycle,
} = require('../services/adminReportLifecycleService');

test('normalizes admin lifecycle sources without trusting collection flags', () => {
  const archived = normalizeReport({
    report_id: 'REP-ARCHIVE-1',
    resident_id: 'RES-0001',
    title: 'Archived report',
    status: 'In Progress',
    assigned_personnel_ids: ['PERS-0001'],
    assigned_personnel_id: 'PERS-0001',
    is_deleted: false,
    is_archived: false,
  }, 'archived_reports');

  assert.equal(archived.reportId, 'REP-ARCHIVE-1');
  assert.equal(archived.isArchived, true);
  assert.equal(archived.isDeleted, false);
  assert.deepEqual(archived.assignedPersonnelIds, ['PERS-0001']);

  const trashed = normalizeReport({
    report_id: 'REP-TRASH-1',
    resident_id: 'RES-0001',
    title: 'Trashed report',
    status: 'Pending',
  }, 'trash_reports');
  assert.equal(trashed.isDeleted, true);
  assert.equal(trashed.isArchived, false);
});

test('admin bulk lifecycle rejects an empty ID list before database work', async () => {
  await assert.rejects(
    () => bulkLifecycle({ ids: [], action: 'trash', adminId: 'ADM-0001' }),
    /non-empty array/
  );
});

/**
 * Pins the Admin History category vocabulary.
 *
 * The tab a record appears under is decided here, server-side, rather than
 * re-derived by each client from the action string. Getting it wrong does not
 * crash: it silently files an administrator's decision under the wrong heading,
 * which is the failure the audit trail exists to prevent.
 *
 * Where an action is genuinely ambiguous the test states which reading was chosen
 * and why, because reversing one of these is the most likely way to break the
 * screen later.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CATEGORY,
  ACTION_CATEGORY,
  categoryFor,
} = require('../src/shared/historyActions');

test('report decisions are filed under Reports', () => {
  const reportActions = [
    'SUBMITTED',
    'STATUS_CHANGED',
    'ARCHIVED',
    'RESTORED',
    'UPDATED',
    'MOVED_TO_TRASH',
    'PERMANENTLY_DELETED',
    'DENIED',
    'DUPLICATE',
    'DUPLICATE_CONFIRMED',
    'NOT_DUPLICATE',
    'ADMIN_RESPONSE_UPDATED',
  ];

  for (const action of reportActions) {
    assert.equal(categoryFor(action), CATEGORY.REPORTS, `${action} should be Reports`);
  }
});

test('assignment decisions are filed under Assignments', () => {
  const assignmentActions = [
    'ASSIGNED',
    'REASSIGNED',
    'UNASSIGNED',
    'ASSIGNMENT_CANCELLED',
    'ASSIGNMENT_REJECTED',
    'ASSIGNMENT_COMPLETED',
  ];

  for (const action of assignmentActions) {
    assert.equal(
      categoryFor(action),
      CATEGORY.ASSIGNMENTS,
      `${action} should be Assignments`
    );
  }
});

test('cleaning progress is filed under Cleaning', () => {
  const cleaningActions = [
    'CLEANING_STARTED',
    'CLEANING_COMPLETED',
    'BEFORE_EVIDENCE_SUBMITTED',
    'AFTER_EVIDENCE_SUBMITTED',
    'CLEANING_INCOMPLETE',
    'CLEANING_VERIFIED',
    'REVISION_REQUESTED',
  ];

  for (const action of cleaningActions) {
    assert.equal(categoryFor(action), CATEGORY.CLEANING, `${action} should be Cleaning`);
  }
});

test('announcement events are filed under Announcements', () => {
  const announcementActions = [
    'ANNOUNCEMENT_CREATED',
    'ANNOUNCEMENT_PUBLISHED',
    'ANNOUNCEMENT_EDITED',
    'ANNOUNCEMENT_UNPUBLISHED',
    'ANNOUNCEMENT_DELETED',
  ];

  for (const action of announcementActions) {
    assert.equal(
      categoryFor(action),
      CATEGORY.ANNOUNCEMENTS,
      `${action} should be Announcements`
    );
  }
});

test('ESP account events are filed under Account', () => {
  const accountActions = [
    'PERSONNEL_CREATED',
    'PERSONNEL_UPDATED',
    'PERSONNEL_ACTIVATED',
    'PERSONNEL_DEACTIVATED',
    'PERSONNEL_DELETED',
    'PERSONNEL_RESTORED',
    'PERSONNEL_PASSWORD_RESET',
  ];

  for (const action of accountActions) {
    assert.equal(categoryFor(action), CATEGORY.ACCOUNT, `${action} should be Account`);
  }
});

test('every mapped action resolves to the category it was mapped to', () => {
  // ACTION_CATEGORY is keyed by action, so a conflicting second mapping is
  // structurally impossible. What can still break is categoryFor() drifting away
  // from the table, which would file rows under a tab the table disagrees with.
  for (const [action, category] of Object.entries(ACTION_CATEGORY)) {
    assert.equal(
      categoryFor(action),
      category,
      `${action} should resolve to ${category}`
    );
  }
});

test('the five groups are disjoint', () => {
  // Each group is asserted separately above; this checks they do not overlap, so
  // one action cannot be claimed by two tabs. Overlap would make the row count
  // in two pill labels while the row itself appears under whichever tab won.
  const groups = [
    ['SUBMITTED', 'STATUS_CHANGED', 'ARCHIVED', 'RESTORED', 'UPDATED',
      'MOVED_TO_TRASH', 'PERMANENTLY_DELETED', 'DENIED', 'DUPLICATE',
      'DUPLICATE_CONFIRMED', 'NOT_DUPLICATE', 'ADMIN_RESPONSE_UPDATED'],
    ['ASSIGNED', 'REASSIGNED', 'UNASSIGNED', 'ASSIGNMENT_CANCELLED',
      'ASSIGNMENT_REJECTED', 'ASSIGNMENT_COMPLETED'],
    ['CLEANING_STARTED', 'CLEANING_COMPLETED', 'BEFORE_EVIDENCE_SUBMITTED',
      'AFTER_EVIDENCE_SUBMITTED', 'CLEANING_INCOMPLETE', 'CLEANING_VERIFIED',
      'REVISION_REQUESTED'],
    ['ANNOUNCEMENT_CREATED', 'ANNOUNCEMENT_PUBLISHED', 'ANNOUNCEMENT_EDITED',
      'ANNOUNCEMENT_UNPUBLISHED', 'ANNOUNCEMENT_DELETED'],
    ['PERSONNEL_CREATED', 'PERSONNEL_UPDATED', 'PERSONNEL_ACTIVATED',
      'PERSONNEL_DEACTIVATED', 'PERSONNEL_DELETED', 'PERSONNEL_RESTORED',
      'PERSONNEL_PASSWORD_RESET'],
  ];

  const seen = new Map();
  for (const group of groups) {
    for (const action of group) {
      assert.ok(
        !seen.has(action),
        `${action} appears in both ${seen.get(action)} and the current group`
      );
      seen.set(action, categoryFor(action));
    }
  }
});

test('every category has at least one action', () => {
  // A category nothing writes to renders as a permanently empty tab, which looks
  // broken rather than empty.
  const populated = new Set(Object.values(ACTION_CATEGORY));

  for (const category of Object.values(CATEGORY)) {
    assert.ok(populated.has(category), `${category} has no action mapped to it`);
  }
});

test('action lookup is case and whitespace insensitive', () => {
  assert.equal(categoryFor('assigned'), CATEGORY.ASSIGNMENTS);
  assert.equal(categoryFor('  ASSIGNED  '), CATEGORY.ASSIGNMENTS);
  assert.equal(categoryFor('Assigned'), CATEGORY.ASSIGNMENTS);
});

test('an unknown action falls back to Reports rather than vanishing', () => {
  // A server action added after this build must still appear on the screen. If it
  // were dropped instead, new events would silently disappear from the audit
  // trail rather than being filed under a fallback.
  assert.equal(categoryFor('SOME_BRAND_NEW_ACTION'), CATEGORY.REPORTS);
  assert.equal(categoryFor(''), CATEGORY.REPORTS);
  assert.equal(categoryFor(null), CATEGORY.REPORTS);
  assert.equal(categoryFor(undefined), CATEGORY.REPORTS);
});

test('the category set matches the database constraint exactly', () => {
  // report_histories_category_ck in migration/sql/024-admin-history.sql admits
  // exactly these five. A category added here without widening the constraint
  // would be rejected at insert time, failing the very action it was meant to
  // record.
  assert.deepEqual(Object.values(CATEGORY).sort(), [
    'ACCOUNT',
    'ANNOUNCEMENTS',
    'ASSIGNMENTS',
    'CLEANING',
    'REPORTS',
  ]);

  for (const category of Object.values(CATEGORY)) {
    assert.ok(
      ACTION_CATEGORY && Object.values(ACTION_CATEGORY).includes(category),
      `${category} must be reachable from an action`
    );
  }
});

test('the action table is frozen', () => {
  // Both are module constants rather than live state; anything that mutates them
  // would make categoryFor() depend on call order.
  assert.ok(Object.isFrozen(ACTION_CATEGORY));
  assert.ok(Object.isFrozen(CATEGORY));
});

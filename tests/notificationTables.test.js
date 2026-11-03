const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RESIDENT_TABLES,
  ADMIN_TABLES,
  isAdminId,
  tablesFor,
} = require('../src/shared/notificationTables');

/**
 * Phase 3A — the notification store resolves its tables from the owner ID. If
 * this routing ever returned the wrong pair, an administrator could read or
 * write resident notifications, so the mapping is pinned here.
 */

test('administrator IDs resolve to the admin notification tables', () => {
  assert.equal(isAdminId('ADM-92A9EDDB'), true);
  assert.equal(tablesFor('ADM-92A9EDDB').notifications, 'admin_notifications');
  assert.equal(tablesFor('ADM-92A9EDDB').trash, 'trash_admin_notifications');
});

test('resident IDs keep using the existing resident tables', () => {
  assert.equal(isAdminId('RES-1A2B3C'), false);
  assert.equal(tablesFor('RES-1A2B3C').notifications, RESIDENT_TABLES.notifications);
  assert.equal(tablesFor('RES-1A2B3C').trash, RESIDENT_TABLES.trash);
});

test('table routing tolerates casing and surrounding whitespace', () => {
  assert.equal(tablesFor('  adm-92A9EDDB ').notifications, ADMIN_TABLES.notifications);
});

test('missing or malformed owners fall back to resident tables', () => {
  [undefined, null, '', '   ', 'admin', 12345, {}].forEach((value) => {
    assert.equal(
      tablesFor(value).notifications,
      RESIDENT_TABLES.notifications,
      `unexpected routing for ${String(value)}`
    );
  });
});

test('resident and admin tables never overlap', () => {
  assert.notEqual(RESIDENT_TABLES.notifications, ADMIN_TABLES.notifications);
  assert.notEqual(RESIDENT_TABLES.trash, ADMIN_TABLES.trash);
  assert.notEqual(RESIDENT_TABLES.trash, ADMIN_TABLES.notifications);
});

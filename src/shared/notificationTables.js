/**
 * Resolves the notification tables that own a given account.
 *
 * The notifications schema is referentially bound to `residents`, so an
 * administrator cannot be stored in the resident tables. Rather than weaken
 * that constraint, each account type owns its own pair of tables that mirror
 * the resident ones exactly, and this module is the single place that decides
 * which pair an owner ID belongs to.
 *
 * Account prefixes are an existing invariant in this codebase: resident IDs are
 * `RES-` and administrator IDs are `ADM-` (see migration/migrate-admin.js and
 * the admin JWT verification in middleware/authMiddleware).
 */
const RESIDENT_TABLES = Object.freeze({
  notifications: 'notifications',
  trash: 'trash_notifications',
});

const ADMIN_TABLES = Object.freeze({
  notifications: 'admin_notifications',
  trash: 'trash_admin_notifications',
});

const isAdminId = (ownerId) =>
  typeof ownerId === 'string' && ownerId.trim().toUpperCase().startsWith('ADM-');

/** Table names for the account that owns these rows. */
function tablesFor(ownerId) {
  return isAdminId(ownerId) ? ADMIN_TABLES : RESIDENT_TABLES;
}

module.exports = {
  RESIDENT_TABLES,
  ADMIN_TABLES,
  isAdminId,
  tablesFor,
};

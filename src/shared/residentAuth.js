const DISABLED_RESIDENT_STATUSES = new Set([
  'DISABLED',
  'INACTIVE',
  'BLOCKED',
  'SUSPENDED',
  'DELETED',
]);

const RESIDENT_ROLES = new Set([
  'RESIDENT',
  // Keep the legacy resident-table personnel role usable during the
  // migration; those accounts authenticate through their dedicated flow.
  'ENVIRONMENTAL SERVICES PERSONNEL',
]);

const normalize = (value) => String(value || '').trim().toUpperCase();

const isResidentDisabled = (resident) => {
  if (!resident) return true;
  return DISABLED_RESIDENT_STATUSES.has(normalize(resident.status))
    || resident.deleted_at != null
    || resident.enabled === false;
};

const isEligibleResident = (resident) => {
  if (!resident) return false;
  return RESIDENT_ROLES.has(normalize(resident.role)) && !isResidentDisabled(resident);
};

/**
 * Single decision point for resident authentication, used by the login
 * controller so the rule stays in one testable place.
 *
 * A resident may pause their own account, and that pause is reversible. The
 * password must already be verified before an account is restored, otherwise a
 * wrong password could un-pause someone else's account. `disabled_by_resident`
 * is what keeps this self-service: an account disabled by an administrator
 * never carries the marker, so it stays blocked no matter the password.
 *
 * `passwordMatches` is the result of the bcrypt comparison, never the password.
 */
const getResidentLoginDecision = (resident, passwordMatches) => {
  if (!resident) {
    return { allowed: false, mustRestore: false, reason: 'no_account' };
  }

  if (!RESIDENT_ROLES.has(normalize(resident.role))) {
    return { allowed: false, mustRestore: false, reason: 'not_a_resident' };
  }

  if (isResidentDisabled(resident)) {
    /*
     * The self-pause must be the ONLY reason this account is blocked. A row that
     * is additionally soft-deleted or explicitly disabled carries a stronger
     * signal than the pause marker, so it is never restored. Both checks
     * tolerate the columns being absent, matching isResidentDisabled.
     *
     * The role check mirrors the restorePausedResidentAccount SQL predicate, so
     * a legacy personnel compatibility row cannot be restored as a resident.
     */
    const restorableByOwner = normalize(resident.role) === 'RESIDENT'
      && resident.disabled_by_resident === true
      && resident.deleted_at == null
      && resident.enabled !== false
      && passwordMatches;

    if (restorableByOwner) {
      return { allowed: true, mustRestore: true, reason: 'restore_self_paused' };
    }

    return { allowed: false, mustRestore: false, reason: 'account_disabled' };
  }

  return passwordMatches
    ? { allowed: true, mustRestore: false, reason: 'active' }
    : { allowed: false, mustRestore: false, reason: 'invalid_password' };
};

module.exports = {
  DISABLED_RESIDENT_STATUSES,
  RESIDENT_ROLES,
  isResidentDisabled,
  isEligibleResident,
  getResidentLoginDecision,
};

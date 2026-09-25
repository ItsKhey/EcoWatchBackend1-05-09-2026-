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

module.exports = {
  DISABLED_RESIDENT_STATUSES,
  RESIDENT_ROLES,
  isResidentDisabled,
  isEligibleResident,
};

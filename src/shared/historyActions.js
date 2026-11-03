/**
 * The vocabulary the Admin History screen groups by.
 *
 * Stored on each row rather than derived from the `action` constant because
 * several constants straddle two tabs: `COMPLETED` is both a finished cleaning
 * job and a report an administrator marked complete, and `REVISION_REQUESTED`
 * names the cleaning that has to be redone rather than the assignment it belongs
 * to. Deciding the tab where the decision is made keeps the clients from
 * re-deriving it from a keyword and disagreeing with each other.
 *
 * The set mirrors AdminHistoryCategory in the Admin app and is constrained by
 * report_histories_category_ck in the database.
 */
const CATEGORY = Object.freeze({
  REPORTS: 'REPORTS',
  ASSIGNMENTS: 'ASSIGNMENTS',
  CLEANING: 'CLEANING',
  ANNOUNCEMENTS: 'ANNOUNCEMENTS',
  ACCOUNT: 'ACCOUNT',
});

const SUBJECT_TYPE = Object.freeze({
  ANNOUNCEMENT: 'ANNOUNCEMENT',
  PERSONNEL: 'PERSONNEL',
  // A reporter account has no report to join to either, so a credential reset
  // or an account disable is filed against the reporter. Constrained by
  // report_histories_subject_type_ck, which migration 026 widened to admit it.
  RESIDENT: 'RESIDENT',
});

/**
 * The action constant paired with the tab it belongs under.
 *
 * Every administrative decision the system records is listed here explicitly, so
 * a new call site that passes an unknown action is visible in review rather than
 * silently defaulting to Reports.
 */
const ACTION_CATEGORY = Object.freeze({
  // --- Reports: status, actions and decisions -------------------------------
  SUBMITTED: CATEGORY.REPORTS,
  STATUS_CHANGED: CATEGORY.REPORTS,
  ARCHIVED: CATEGORY.REPORTS,
  RESTORED: CATEGORY.REPORTS,
  UPDATED: CATEGORY.REPORTS,
  MOVED_TO_TRASH: CATEGORY.REPORTS,
  PERMANENTLY_DELETED: CATEGORY.REPORTS,
  DENIED: CATEGORY.REPORTS,
  DUPLICATE: CATEGORY.REPORTS,
  NOT_DUPLICATE: CATEGORY.REPORTS,
  ADMIN_RESPONSE_UPDATED: CATEGORY.REPORTS,

  // --- Assignments: the administrative side of personnel management ---------
  ASSIGNED: CATEGORY.ASSIGNMENTS,
  REASSIGNED: CATEGORY.ASSIGNMENTS,
  UNASSIGNED: CATEGORY.ASSIGNMENTS,
  ASSIGNMENT_CANCELLED: CATEGORY.ASSIGNMENTS,
  ASSIGNMENT_REJECTED: CATEGORY.ASSIGNMENTS,
  // The assignment is what the administrator changed, so it is reported here
  // rather than under Cleaning.
  ASSIGNMENT_COMPLETED: CATEGORY.ASSIGNMENTS,

  // --- Cleaning: what happened after assignment ----------------------------
  CLEANING_STARTED: CATEGORY.CLEANING,
  CLEANING_COMPLETED: CATEGORY.CLEANING,
  BEFORE_EVIDENCE_SUBMITTED: CATEGORY.CLEANING,
  AFTER_EVIDENCE_SUBMITTED: CATEGORY.CLEANING,
  CLEANING_INCOMPLETE: CATEGORY.CLEANING,
  CLEANING_VERIFIED: CATEGORY.CLEANING,
  REVISION_REQUESTED: CATEGORY.CLEANING,

  // --- Announcements -------------------------------------------------------
  ANNOUNCEMENT_CREATED: CATEGORY.ANNOUNCEMENTS,
  ANNOUNCEMENT_PUBLISHED: CATEGORY.ANNOUNCEMENTS,
  ANNOUNCEMENT_EDITED: CATEGORY.ANNOUNCEMENTS,
  ANNOUNCEMENT_UNPUBLISHED: CATEGORY.ANNOUNCEMENTS,
  ANNOUNCEMENT_DELETED: CATEGORY.ANNOUNCEMENTS,

  // --- ESP account management ---------------------------------------------
  PERSONNEL_CREATED: CATEGORY.ACCOUNT,
  PERSONNEL_UPDATED: CATEGORY.ACCOUNT,
  PERSONNEL_ACTIVATED: CATEGORY.ACCOUNT,
  PERSONNEL_DEACTIVATED: CATEGORY.ACCOUNT,
  PERSONNEL_DELETED: CATEGORY.ACCOUNT,
  PERSONNEL_RESTORED: CATEGORY.ACCOUNT,
  PERSONNEL_PASSWORD_RESET: CATEGORY.ACCOUNT,

  // --- Reporter account management -----------------------------------------
  RESIDENT_PASSWORD_RESET: CATEGORY.ACCOUNT,
  RESIDENT_ACCOUNT_DISABLED: CATEGORY.ACCOUNT,
  RESIDENT_ACCOUNT_ENABLED: CATEGORY.ACCOUNT,
  // Written by the retention job, not by an administrator. Like the report
  // expiry it is filed with no adminId, so an expiration stays distinguishable
  // from a decision somebody made.
  RESIDENT_ACCOUNT_PURGED: CATEGORY.ACCOUNT,
});

/**
 * Resolves the tab for an action.
 *
 * Falls back to Reports, which is what every client also does, so an action this
 * build has never seen still appears rather than vanishing from the audit trail.
 */
const categoryFor = (action) => {
  if (!action) return CATEGORY.REPORTS;

  const normalized = String(action).trim().toUpperCase();
  return ACTION_CATEGORY[normalized] || CATEGORY.REPORTS;
};

module.exports = {
  CATEGORY,
  SUBJECT_TYPE,
  ACTION_CATEGORY,
  categoryFor,
};

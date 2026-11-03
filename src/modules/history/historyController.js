const historyRepository =
  require('./historyRepository');

/**
 * The five tabs the Admin History screen groups by.
 *
 * Held here rather than only in the client so the API rejects an unknown tab
 * instead of quietly returning an empty feed, which would look like "no records
 * of that kind exist" rather than "you asked for something that does not".
 */
const ADMIN_CATEGORIES = Object.freeze([
  'ALL',
  'REPORTS',
  'ASSIGNMENTS',
  'CLEANING',
  'ANNOUNCEMENTS',
  'ACCOUNT',
]);

const parseTimestamp = (value) => {
  if (value === undefined || value === null || value === '') return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const parseNonNegativeInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * @desc    Admin audit feed: every decision, across every resident
 * @route   GET /api/admin/history
 * @access  Private/Admin
 *
 * Distinct from my-history on purpose. An administrator's question is "what
 * happened across the whole system", and the resident-scoped route cannot answer
 * it: admin actions are written under the resident who owns the report, so
 * filtering by the admin's own id matches nothing.
 */
const getAdminHistory = async (req, res, next) => {
  try {
    const requestedCategory = String(req.query.category || 'ALL').trim().toUpperCase();

    if (!ADMIN_CATEGORIES.includes(requestedCategory)) {
      return res.status(400).json({
        message: `Unknown history category. Expected one of: ${ADMIN_CATEGORIES.join(', ')}.`,
      });
    }

    const rows = await historyRepository.findForAdmin({
      category: requestedCategory === 'ALL' ? null : requestedCategory,
      subjectType: req.query.subjectType ? String(req.query.subjectType).trim() : null,
      reportId: req.query.reportId ? String(req.query.reportId).trim() : null,
      search: req.query.search ? String(req.query.search).trim() : null,
      from: parseTimestamp(req.query.from),
      to: parseTimestamp(req.query.to),
      limit: parseNonNegativeInt(req.query.limit, 200),
      offset: parseNonNegativeInt(req.query.offset, 0),
    });

    // Returned alongside the rows so the pill labels do not need a second request
    // or a client-side recount that could disagree with the query above.
    const counts = await historyRepository.countByCategoryForAdmin();

    return res.json({
      success: true,
      total: rows.length,
      counts,
      history: rows,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc    Admin history trash
 * @route   GET /api/admin/history/trash
 * @access  Private/Admin
 */
const getAdminHistoryTrash = async (req, res, next) => {
  try {
    const rows = await historyRepository.findTrashForAdmin({
      limit: parseNonNegativeInt(req.query.limit, 200),
      offset: parseNonNegativeInt(req.query.offset, 0),
    });

    return res.json({ success: true, total: rows.length, history: rows });
  } catch (error) {
    return next(error);
  }
};

/**
 * Runs one mutation per id and reports exactly which rows were affected.
 *
 * The same shape the resident bulk-delete already returns, and for the same
 * reason: reporting success for an id that matched nothing leaves the client
 * believing a delete landed while the row survived and was re-served on the next
 * sync.
 */
const applyAdminHistoryBulk = async (ids, operation) => {
  const deleted = [];
  const notFound = [];

  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const changed = await operation(id);
    if (changed) {
      deleted.push(id);
    } else {
      notFound.push(id);
    }
  }

  return { requested: ids.length, deleted: deleted.length, notFound };
};

const readIds = (req) => {
  const { ids } = req.body || {};

  if (!Array.isArray(ids) || ids.length === 0) {
    const error = new Error('Invalid IDs provided');
    error.statusCode = 400;
    throw error;
  }

  const normalized = ids
    .map((id) => Number.parseInt(id, 10))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (normalized.length === 0) {
    const error = new Error('Invalid IDs provided');
    error.statusCode = 400;
    throw error;
  }

  return normalized;
};

/**
 * @desc    Bulk soft delete admin history records
 * @route   POST /api/admin/history/bulk-soft-delete
 * @access  Private/Admin
 */
const bulkSoftDeleteAdminHistory = async (req, res, next) => {
  try {
    const ids = readIds(req);
    const summary = await applyAdminHistoryBulk(
      ids,
      (id) => historyRepository.softDeleteById(id)
    );

    if (summary.notFound.length > 0) {
      console.warn(
        `[history] admin bulk-soft-delete: ${summary.notFound.length}/${ids.length} id(s) not matched`
      );
    }

    return res.json({
      success: true,
      message: 'History records moved to trash',
      ...summary,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc    Bulk restore admin history records
 * @route   POST /api/admin/history/bulk-restore
 * @access  Private/Admin
 */
const bulkRestoreAdminHistory = async (req, res, next) => {
  try {
    const ids = readIds(req);
    const summary = await applyAdminHistoryBulk(
      ids,
      (id) => historyRepository.restoreById(id)
    );

    return res.json({
      success: true,
      message: 'History records restored',
      ...summary,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc    Bulk permanent delete admin history records
 * @route   POST /api/admin/history/bulk-delete
 * @access  Private/Admin
 */
const bulkDeleteAdminHistory = async (req, res, next) => {
  try {
    const ids = readIds(req);
    const summary = await applyAdminHistoryBulk(
      ids,
      (id) => historyRepository.deleteById(id)
    );

    if (summary.notFound.length > 0) {
      console.warn(
        `[history] admin bulk-delete: ${summary.notFound.length}/${ids.length} id(s) not matched`
      );
    }

    return res.json({
      success: true,
      message: 'History records permanently deleted',
      ...summary,
    });
  } catch (error) {
    return next(error);
  }
};

// @desc    Get resident history
// @route   GET /api/history/my-history
// @access  Private
const getMyHistory = async (req, res, next) => {
  try {
    const residentId = req.resident.residentId || req.resident.resident_id;
    const history =
      await historyRepository.findByResidentId(residentId);

    res.json(history);
  } catch (error) {
    next(error);
  }
};

// @desc    Bulk soft delete history logs
// @route   POST /api/history/bulk-soft-delete
// @access  Private
const bulkSoftDeleteHistory = async (req, res, next) => {
  try {
    const { ids } = req.body;
    const residentId = req.resident.residentId || req.resident.resident_id;

    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({
        message: 'Invalid IDs provided'
      });
    }

    for (const id of ids) {
      await historyRepository.softDeleteForResident(
        id,
        residentId
      );
    }

    res.json({
      message: 'History logs moved to trash'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Bulk restore history logs
// @route   POST /api/history/bulk-restore
// @access  Private
const bulkRestoreHistory = async (req, res, next) => {
  try {
    const { ids } = req.body;
    const residentId = req.resident.residentId || req.resident.resident_id;

    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({
        message: 'Invalid IDs provided'
      });
    }

    for (const id of ids) {
      await historyRepository.restoreForResident(
        id,
        residentId
      );
    }

    res.json({
      message: 'History logs restored'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Bulk permanent delete history logs
// @route   POST /api/history/bulk-delete
// @access  Private
const bulkDeleteHistory = async (req, res, next) => {
  try {
    const { ids } = req.body;
    const residentId = req.resident.residentId || req.resident.resident_id;

    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({
        message: 'Invalid IDs provided'
      });
    }

    // Track which ids were actually removed. The delete is scoped to the
    // authenticated resident, so an id belonging to another account (or one
    // already gone) matches nothing. Previously every id was reported as
    // success, which left clients believing a permanent delete had landed
    // while the row survived and was re-served on the next sync.
    const deleted = [];
    const notFound = [];

    for (const id of ids) {
      const removed = await historyRepository.deleteByIdForResident(
        id,
        residentId
      );

      if (removed) {
        deleted.push(id);
      } else {
        notFound.push(id);
      }
    }

    if (notFound.length > 0) {
      console.warn(
        `[history] bulk-delete: ${notFound.length}/${ids.length} id(s) not matched for resident ${residentId}`
      );
    }

    res.json({
      message: 'History logs permanently deleted',
      requested: ids.length,
      deleted: deleted.length,
      notFound
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getMyHistory,
  bulkSoftDeleteHistory,
  bulkRestoreHistory,
  bulkDeleteHistory,
  getAdminHistory,
  getAdminHistoryTrash,
  bulkSoftDeleteAdminHistory,
  bulkRestoreAdminHistory,
  bulkDeleteAdminHistory,
  ADMIN_CATEGORIES,
};

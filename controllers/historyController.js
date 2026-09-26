const historyRepository =
  require('../repositories/historyRepository');

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
  bulkDeleteHistory
};

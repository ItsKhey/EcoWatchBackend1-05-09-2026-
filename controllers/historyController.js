const historyRepository =
  require('../repositories/historyRepository');

// @desc    Get resident history
// @route   GET /api/history/my-history
// @access  Private
const getMyHistory = async (req, res, next) => {
  try {
    const history =
      await historyRepository.findByResidentId(
        req.resident.residentId
      );

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

    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({
        message: 'Invalid IDs provided'
      });
    }

    for (const id of ids) {
      await historyRepository.softDeleteForResident(
        id,
        req.resident.residentId
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

    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({
        message: 'Invalid IDs provided'
      });
    }

    for (const id of ids) {
      await historyRepository.restoreForResident(
        id,
        req.resident.residentId
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

    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({
        message: 'Invalid IDs provided'
      });
    }

    for (const id of ids) {
      await historyRepository.deleteByIdForResident(
        id,
        req.resident.residentId
      );
    }

    res.json({
      message: 'History logs permanently deleted'
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

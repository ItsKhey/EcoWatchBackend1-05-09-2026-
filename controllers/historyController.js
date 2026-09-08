const History = require('../models/History');

// @desc    Get resident history
// @route   GET /api/history/my-history
// @access  Private
const getMyHistory = async (req, res, next) => {
  try {
    const history = await History.find({ residentId: req.resident.residentId })
      .sort({ timestamp: -1 })
      .lean();

    res.json(history);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getMyHistory
};

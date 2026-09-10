const express = require('express');
const router = express.Router();
const {
    getMyHistory,
    bulkSoftDeleteHistory,
    bulkRestoreHistory,
    bulkDeleteHistory
} = require('../controllers/historyController');
const { protect } = require('../middleware/authMiddleware');

router.get('/my-history', protect, getMyHistory);
router.post('/bulk-soft-delete', protect, bulkSoftDeleteHistory);
router.post('/bulk-restore', protect, bulkRestoreHistory);
router.post('/bulk-delete', protect, bulkDeleteHistory);

module.exports = router;

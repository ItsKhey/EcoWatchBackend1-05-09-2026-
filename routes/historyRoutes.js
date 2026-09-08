const express = require('express');
const router = express.Router();
const { getMyHistory } = require('../controllers/historyController');
const { protect } = require('../middleware/authMiddleware');

router.get('/my-history', protect, getMyHistory);

module.exports = router;

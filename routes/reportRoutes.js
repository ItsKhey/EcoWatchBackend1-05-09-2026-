const express = require('express');
const router = express.Router();
const {
  createReport,
  getMyReports,
} = require('../controllers/reportController');
const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');

router.post('/', protect, upload.single('image'), createReport);
router.get('/my-reports', protect, getMyReports);

module.exports = router;

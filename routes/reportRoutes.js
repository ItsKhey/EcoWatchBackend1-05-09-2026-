const express = require('express');
const router = express.Router();
const multer = require('multer');
const {
  createReport,
  getMyReports,
} = require('../controllers/reportController');
const { protect } = require('../middleware/authMiddleware');

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post('/', protect, upload.single('image'), createReport);
router.get('/my-reports', protect, getMyReports);

module.exports = router;

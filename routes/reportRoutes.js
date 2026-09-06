const express = require('express');
const router = express.Router();
const multer = require('multer');
const {
  createReport,
  getMyReports,
  updateReport,
  deleteReport,
} = require('../controllers/reportController');
const { protect } = require('../middleware/authMiddleware');

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post('/', protect, upload.single('image'), createReport);
router.get('/my-reports', protect, getMyReports);
router.patch('/:id', protect, upload.single('image'), updateReport);
router.delete('/:id', protect, deleteReport);

module.exports = router;

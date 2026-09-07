const express = require('express');
const router = express.Router();
const multer = require('multer');
const {
  createReport,
  getMyReports,
  updateReport,
  deleteReport,
  softDeleteReport,
  restoreReport,
  archiveReport,
  bulkSoftDeleteReports,
  bulkRestoreReports,
  bulkArchiveReports,
} = require('../controllers/reportController');
const { protect } = require('../middleware/authMiddleware');

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post('/', protect, upload.single('image'), createReport);
router.get('/my-reports', protect, getMyReports);
router.post('/bulk-soft-delete', protect, bulkSoftDeleteReports);
router.post('/bulk-restore', protect, bulkRestoreReports);
router.post('/bulk-archive', protect, bulkArchiveReports);
router.patch('/:id/trash', protect, softDeleteReport);
router.patch('/:id/soft-delete', protect, softDeleteReport);
router.patch('/:id/restore', protect, restoreReport);
router.patch('/:id/archive', protect, archiveReport);
router.patch('/:id', protect, upload.single('image'), updateReport);
router.delete('/:id', protect, deleteReport);

module.exports = router;

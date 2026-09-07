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
router.post('/bulk-move-to-archive', protect, bulkArchiveReports);
router.post('/bulk-move-to-trash', protect, bulkSoftDeleteReports);
router.post('/bulk-restore', protect, bulkRestoreReports);
router.post('/bulk-soft-delete', protect, bulkSoftDeleteReports);
router.post('/bulk-archive', protect, bulkArchiveReports);
router.post('/:id/move-to-trash', protect, softDeleteReport);
router.post('/:id/move-to-archive', protect, archiveReport);
router.post('/:id/restore', protect, restoreReport);
router.patch('/:id/trash', protect, softDeleteReport);
router.patch('/:id/soft-delete', protect, softDeleteReport);
router.patch('/:id/restore', protect, restoreReport);
router.patch('/:id/archive', protect, archiveReport);
router.patch('/:id', protect, upload.single('image'), updateReport);
router.delete('/:id', protect, deleteReport);

module.exports = router;

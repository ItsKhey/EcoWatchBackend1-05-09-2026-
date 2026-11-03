const express = require('express');
const router = express.Router();
const multer = require('multer');
const {
  createReport,
  getMyReports,
  getNearbyClusters,
  updateReport,
  deleteReport,
  softDeleteReport,
  restoreReport,
  archiveReport,
  bulkSoftDeleteReports,
  bulkRestoreReports,
  bulkArchiveReports,
  bulkDeleteReports,
} = require('./reportController');
const { protect } = require('../../middleware/authMiddleware');

const storage = multer.memoryStorage();
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PHOTOS_PER_REPORT = 10;
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const upload = multer({
  storage,
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_PHOTOS_PER_REPORT },
  fileFilter(req, file, cb) {
    if (!allowedImageTypes.has(String(file.mimetype).toLowerCase())) {
      const error = new Error('Only JPEG, PNG, and WebP images are allowed');
      error.code = 'INVALID_FILE_TYPE';
      return cb(error);
    }
    return cb(null, true);
  },
});

// Nearby clusters endpoint (must be before /:id routes)
router.get('/nearby-clusters', protect, getNearbyClusters);

// Create report - supports multiple photos via 'photos' field, or single 'image' (legacy)
// The controller handles both req.files (array) and req.file (single) cases.
router.post(
  '/',
  protect,
  (req, res, next) => {
    // Try array upload first; if no files were sent as 'photos', fall back to single 'image'
    upload.array('photos', MAX_PHOTOS_PER_REPORT)(req, res, (err) => {
      if (err) return next(err);
      if (req.files && req.files.length > 0) return next();
      // Fall back to single file upload for legacy clients
      upload.single('image')(req, res, (singleErr) => {
        if (singleErr) return next(singleErr);
        next();
      });
    });
  },
  createReport
);

router.get('/my-reports', protect, getMyReports);
router.post('/bulk-move-to-archive', protect, bulkArchiveReports);
router.post('/bulk-move-to-trash', protect, bulkSoftDeleteReports);
router.post('/bulk-restore', protect, bulkRestoreReports);
router.post('/bulk-soft-delete', protect, bulkSoftDeleteReports);
router.post('/bulk-archive', protect, bulkArchiveReports);
router.post('/bulk-delete', protect, bulkDeleteReports);
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

const express = require('express');
const router = express.Router();
const {
    getMyHistory,
    bulkSoftDeleteHistory,
    bulkRestoreHistory,
    bulkDeleteHistory
} = require('./historyController');
const { protect } = require('../../middleware/authMiddleware');

// Resident-facing: one account's own logs.
//
// This router is mounted at /api/history, so every route here is scoped to a
// single account and keyed on the caller's own resident id.
router.get('/my-history', protect, getMyHistory);
router.post('/bulk-soft-delete', protect, bulkSoftDeleteHistory);
router.post('/bulk-restore', protect, bulkRestoreHistory);
router.post('/bulk-delete', protect, bulkDeleteHistory);

// The administrator-facing audit feed used to be registered here as
// /admin/history, which resolved to /api/history/admin/history. The Admin app
// calls /api/admin/history, so the handler was unreachable from it and the
// History screen stayed empty.
//
// They now live in adminRoutes.js, which server.js mounts at /api/admin. The
// controller and repository are unchanged; only the mount point moved.

module.exports = router;

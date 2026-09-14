const express = require('express');
const router = express.Router();
const { approveReportCompletion, updateReportStatus } = require('../controllers/adminController');

// Simulating Admin Endpoints
router.post('/reports/:id/approve', approveReportCompletion);
router.patch('/reports/:id/status', updateReportStatus);

module.exports = router;

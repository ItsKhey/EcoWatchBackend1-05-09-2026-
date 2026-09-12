const express = require('express');
const router = express.Router();
const { approveReportCompletion } = require('../controllers/adminController');

// Simulating Admin Endpoint
router.post('/reports/:id/approve', approveReportCompletion);

module.exports = router;

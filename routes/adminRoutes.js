const express = require('express');
const router = express.Router();
const {
  getAllReports,
  assignPersonnel,
  getPersonnel,
  createPersonnel,
  approveReportCompletion,
} = require('../controllers/adminController');
const { protect } = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');

// All routes here are restricted to logged-in Admins
router.use(protect);
router.use(admin);

router.get('/reports', getAllReports);
router.post('/reports/:id/assign', assignPersonnel);
router.post('/reports/:id/approve', approveReportCompletion);
router.get('/personnel', getPersonnel);
router.post('/create-personnel', createPersonnel);

module.exports = router;

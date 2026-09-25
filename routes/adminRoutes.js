const express = require('express');
const router = express.Router();
const {
  loginAdmin,
  getCurrentAdmin,
  getAllReports,
  assignPersonnel,
  reassignPersonnel,
  getAssignment,
  unassignPersonnel,
  deleteReportAssignment,
  getPersonnel,
  createPersonnel,
  approveReportCompletion,
} = require('../controllers/adminController');
const {
  getPersonnelDetails,
  editPersonnel,
  resetPersonnelPassword,
  updatePersonnelStatus,
  disablePersonnel,
  deletePersonnel,
} = require('../controllers/personnelController');
const { protect } = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');
const {
  listResidents,
  getResidentDetails,
  getResidentReports,
  getResidentReportStatistics,
} = require('../controllers/residentAdminController');

router.post('/login', loginAdmin);

// All routes except login are restricted to logged-in Admins
router.use(protect);
router.use(admin);

router.get('/me', getCurrentAdmin);
router.get('/account', getCurrentAdmin); // Compatibility alias for older clients
router.get('/reports', getAllReports);
router.get('/residents', listResidents);
router.get('/residents/:residentId', getResidentDetails);
router.get('/residents/:residentId/reports', getResidentReports);
router.get('/residents/:residentId/reports/statistics', getResidentReportStatistics);
router.get('/residents/:residentId/statistics', getResidentReportStatistics);
router.post('/reports/:id/assign', assignPersonnel);
router.post('/reports/:id/reassign', reassignPersonnel);
router.get('/reports/:id/assignment', getAssignment);
router.get('/reports/:id/assignments', getAssignment);
router.post('/reports/:id/unassign', unassignPersonnel);
router.delete('/reports/:id/assignment', deleteReportAssignment);
router.post('/reports/:id/approve', approveReportCompletion);

// Canonical personnel management contract used by the admin Android app.
router.get('/personnel', getPersonnel);
router.post('/personnel', createPersonnel);
router.get('/personnel/:id', getPersonnelDetails);
router.patch('/personnel/:id', editPersonnel);
router.post('/personnel/:id/reset-password', resetPersonnelPassword);
router.patch('/personnel/:id/status', updatePersonnelStatus);
router.patch('/personnel/:id/disable', disablePersonnel);
router.delete('/personnel/:id', deletePersonnel);

// Preserve the original create-personnel alias during rolling deployments.
router.post('/create-personnel', createPersonnel);

module.exports = router;

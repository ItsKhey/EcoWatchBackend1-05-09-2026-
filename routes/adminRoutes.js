const express = require('express');
const router = express.Router();
const {
  loginAdmin,
  getCurrentAdmin,
  getAllReports,
  archiveAdminReport,
  trashAdminReport,
  restoreAdminReport,
  deleteAdminReport,
  bulkArchiveAdminReports,
  bulkTrashAdminReports,
  bulkRestoreAdminReports,
  bulkDeleteAdminReports,
  assignPersonnel,
  reassignPersonnel,
  getAssignment,
  unassignPersonnel,
  deleteReportAssignment,
  getPersonnel,
  createPersonnel,
  updateReportStatus,
  updateReportResponse,
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

// Administrator-owned lifecycle routes. These intentionally do not reuse the
// resident controllers, which require req.resident ownership and would make an
// admin token act through the compatibility resident identity.
router.post('/reports/bulk-move-to-archive', bulkArchiveAdminReports);
router.post('/reports/bulk-archive', bulkArchiveAdminReports);
router.post('/reports/bulk-move-to-trash', bulkTrashAdminReports);
router.post('/reports/bulk-soft-delete', bulkTrashAdminReports);
router.post('/reports/bulk-restore', bulkRestoreAdminReports);
router.post('/reports/bulk-delete', bulkDeleteAdminReports);
router.post('/reports/:id/move-to-archive', archiveAdminReport);
router.post('/reports/:id/move-to-trash', trashAdminReport);
router.post('/reports/:id/restore', restoreAdminReport);
router.post('/reports/:id/archive', archiveAdminReport);
router.post('/reports/:id/trash', trashAdminReport);
router.patch('/reports/:id/archive', archiveAdminReport);
router.patch('/reports/:id/trash', trashAdminReport);
router.patch('/reports/:id/restore', restoreAdminReport);
router.delete('/reports/:id', deleteAdminReport);

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
router.patch('/reports/:id/status', updateReportStatus);
router.patch('/reports/:id/response', updateReportResponse);
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

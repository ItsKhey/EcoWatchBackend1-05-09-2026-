const express = require('express');
const router = express.Router();
const {
  loginAdmin,
  getCurrentAdmin,
  registerAdminFcmToken,
  clearAdminFcmToken,
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
  reviseReportCompletion,
  getClusters,
  getClusterDetails,
  assignCluster,
  approveClusterCompletion,
  requestClusterRecleaning,
  searchClusters,
  getPossibleDuplicates,
  confirmDuplicateReports,
  markNotDuplicates,
  listCleaningTeams,
  getCleaningTeam,
  getCleaningTeamTaskHistory,
  createCleaningTeam,
  updateCleaningTeam,
  deleteCleaningTeam,
  listCleaningTeamMembers,
  addCleaningTeamMember,
  removeCleaningTeamMember,
} = require('./adminController');
const {
  getPersonnelDetails,
  getPersonnelReports,
  getPersonnelReportStatistics,
  getPersonnelTaskCounts,
  editPersonnel,
  resetPersonnelPassword,
  updatePersonnelStatus,
  disablePersonnel,
  deletePersonnel,
  uploadPersonnelPhoto,
} = require('../personnel/personnelController');
const { protect } = require('../../middleware/authMiddleware');
const { admin } = require('../../middleware/adminMiddleware');
const uploadMemoryImage = require('../../middleware/memoryImageUpload');
const {
  listResidents,
  getResidentDetails,
  getResidentReports,
  getResidentReportStatistics,
  resetResidentPassword,
  disableResident,
  enableResident,
  deleteResident,
} = require('../residents/residentAdminController');
const {
  getAdminHistory,
  getAdminHistoryTrash,
  bulkSoftDeleteAdminHistory,
  bulkRestoreAdminHistory,
  bulkDeleteAdminHistory,
} = require('../history/historyController');

router.post('/login', loginAdmin);

// All routes except login are restricted to logged-in Admins
router.use(protect);
router.use(admin);

router.get('/me', getCurrentAdmin);
router.get('/account', getCurrentAdmin); // Compatibility alias for older clients

// Phase 3A — device FCM token binding for administrator push delivery.
router.post('/fcm-token', registerAdminFcmToken);
router.delete('/fcm-token', clearAdminFcmToken);
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

// Administrator-initiated reporter account management. Separate from
// /api/auth/disable-account, which pauses the caller's OWN account and is
// mounted protectResident for exactly that reason: an admin token must never be
// able to pause somebody else's account through it.
router.post('/residents/:residentId/reset-password', resetResidentPassword);
router.patch('/residents/:residentId/disable', disableResident);

// The undo. Administrator-disabled accounts carry no self-service marker, so
// this is the only way back and a mistake here would otherwise need direct SQL.
router.patch('/residents/:residentId/enable', enableResident);

// Irreversible. Removes the account together with every row it owns, using the
// same cascade as the resident's own DELETE /api/auth/account. There is no undo
// for this: enableResident can only restore a paused account, because by this
// point the rows it would restore no longer exist.
router.delete('/residents/:residentId', deleteResident);

router.post('/reports/:id/assign', assignPersonnel);
router.post('/reports/:id/reassign', reassignPersonnel);
router.get('/reports/:id/assignment', getAssignment);
router.get('/reports/:id/assignments', getAssignment);
router.post('/reports/:id/unassign', unassignPersonnel);
router.delete('/reports/:id/assignment', deleteReportAssignment);
router.patch('/reports/:id/status', updateReportStatus);
router.patch('/reports/:id/response', updateReportResponse);
router.post('/reports/:id/approve', approveReportCompletion);
router.post('/reports/:id/revise', reviseReportCompletion);

// Cleaning teams.
//
// A Medium- or Large-Scale Waste is dispatched as a crew, so the crew has to
// exist before it can be assigned. The teams are maintained here and read by
// the assignment screen when the administrator dispatches a report.
router.get('/cleaning-teams', listCleaningTeams);
router.post('/cleaning-teams', createCleaningTeam);
router.get('/cleaning-teams/:teamId', getCleaningTeam);
router.get('/cleaning-teams/:teamId/task-history', getCleaningTeamTaskHistory);
router.put('/cleaning-teams/:teamId', updateCleaningTeam);
router.delete('/cleaning-teams/:teamId', deleteCleaningTeam);
router.get('/cleaning-teams/:teamId/members', listCleaningTeamMembers);
router.post('/cleaning-teams/:teamId/members', addCleaningTeamMember);
router.delete('/cleaning-teams/:teamId/members/:personnelId', removeCleaningTeamMember);

// Canonical personnel management contract used by the admin Android app.
router.get('/personnel', getPersonnel);
router.post('/personnel', createPersonnel);
router.get('/personnel/:id', getPersonnelDetails);
router.get('/personnel/:id/reports', getPersonnelReports);
router.get('/personnel/:id/reports/statistics', getPersonnelReportStatistics);
router.get('/personnel/:id/statistics', getPersonnelReportStatistics);
// Task counts counted from the assignment rows, matching what the Personnel app
// shows on the cleaner's own profile. Registered before the '/personnel/:id/*'
// assignment routes so the literal segment always wins.
router.get('/personnel/:id/task-counts', getPersonnelTaskCounts);
router.get('/personnel/:id/tasks/counts', getPersonnelTaskCounts);
router.patch('/personnel/:id', editPersonnel);
router.post('/personnel/:id/reset-password', resetPersonnelPassword);
router.patch('/personnel/:id/status', updatePersonnelStatus);
router.patch('/personnel/:id/disable', disablePersonnel);
router.delete('/personnel/:id', deletePersonnel);
// Photograph captured during personnel registration, stored server-side and
// recorded on the account row as profile_image.
router.post('/personnel/:id/photo', uploadMemoryImage, uploadPersonnelPhoto);

// Preserve the original create-personnel alias during rolling deployments.
router.post('/create-personnel', createPersonnel);

// Cluster management endpoints
router.get('/clusters', getClusters);
router.get('/clusters/search', searchClusters);
router.get('/clusters/:clusterId', getClusterDetails);
router.post('/clusters/:clusterId/assign', assignCluster);
router.post('/clusters/:clusterId/approve-completion', approveClusterCompletion);
router.post('/clusters/:clusterId/request-recleaning', requestClusterRecleaning);

// Possible duplicate review. The admin UI treats this as "Possible Duplicate
// Reports"; clusters are only an internal implementation detail.
router.get('/possible-duplicates', getPossibleDuplicates);
router.post('/possible-duplicates/:groupId/deny', confirmDuplicateReports);
router.post('/possible-duplicates/:groupId/accept', markNotDuplicates);

// The administrator's audit feed: every decision, across every resident.
//
// These answers a different question from /api/history/my-history, which is
// scoped to one account's own rows. Admin decisions are written under the
// resident who owns the report, so filtering by the admin's own id matches
// nothing; historyRepository.findForAdmin() therefore reads the table
// unfiltered, and this router is the only place it is exposed.
//
// Mounted here so the public path is /api/admin/history, which is what the
// Admin app calls. They previously sat in historyRoutes.js, whose /api/history
// mount resolved them to /api/history/admin/history and left the Admin History
// screen 404ing. protect and admin are not repeated: router.use above already
// applies both to every route below it.
router.get('/history', getAdminHistory);
router.get('/history/trash', getAdminHistoryTrash);
router.post('/history/bulk-soft-delete', bulkSoftDeleteAdminHistory);
router.post('/history/bulk-restore', bulkRestoreAdminHistory);
router.post('/history/bulk-delete', bulkDeleteAdminHistory);

module.exports = router;

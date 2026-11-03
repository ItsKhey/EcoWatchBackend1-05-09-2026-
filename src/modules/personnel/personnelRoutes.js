const express = require('express');
const router = express.Router();
const {
  loginPersonnel,
  verifyOwnPassword,
  changeOwnPassword,
  createPersonnel,
  uploadPersonnelPhoto,
  listPersonnel,
  getPersonnelDetails,
  editPersonnel,
  resetPersonnelPassword,
  updatePersonnelStatus,
  disablePersonnel,
  enablePersonnel,
  deletePersonnel,
  restorePersonnel,
} = require('./personnelController');
const {
  getMe,
  getCurrentTask,
  listTasks,
  getTaskCounts,
  getTask,
  acceptTask,
  startTask,
  completeTask,
  uploadEvidence,
  deleteEvidence,
  getNotifications,
  getUnreadNotificationCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  registerFcmToken,
  clearFcmToken,
} = require('./personnelTaskController');
const {
  protect,
  protectPersonnel,
} = require('../../middleware/authMiddleware');
const { admin } = require('../../middleware/adminMiddleware');

// Evidence and account photos share the in-memory multipart middleware so the
// storage provider (local disk or Cloudinary) is chosen in the service layer
// rather than by multer, matching the report photo upload path. Both routes
// receive the image under the same `image` field name.
const uploadPersonnelImage = require('../../middleware/memoryImageUpload');

// Public personnel authentication.
router.post('/login', loginPersonnel);

// --- Personnel-authenticated routes -----------------------------------------
//
// These must be registered before the administrator gate below. Identity comes
// from protectPersonnel; the cleaner owns only their own assignment rows.
router.get('/me', protectPersonnel, getMe);
// Self-service password checks and changes. Registered ahead of the
// administrator gate, and ahead of the admin '/:id/password' route, so they are
// reachable with a personnel token and cannot be shadowed by the admin path.
router.post('/verify-password', protectPersonnel, verifyOwnPassword);
router.patch('/password', protectPersonnel, changeOwnPassword);
router.get('/task-counts', protectPersonnel, getTaskCounts);
router.get('/tasks/current', protectPersonnel, getCurrentTask);
router.get('/tasks', protectPersonnel, listTasks);
router.get('/tasks/:assignmentId', protectPersonnel, getTask);
router.post('/tasks/:assignmentId/accept', protectPersonnel, acceptTask);
router.post('/tasks/:assignmentId/start', protectPersonnel, startTask);
router.post('/tasks/:assignmentId/complete', protectPersonnel, completeTask);
router.post(
  '/tasks/:assignmentId/evidence',
  protectPersonnel,
  uploadPersonnelImage,
  uploadEvidence
);
router.delete(
  '/tasks/:assignmentId/evidence/:evidenceId',
  protectPersonnel,
  deleteEvidence
);

router.get('/notifications', protectPersonnel, getNotifications);
router.get(
  '/notifications/unread-count',
  protectPersonnel,
  getUnreadNotificationCount
);
router.patch(
  '/notifications/read-all',
  protectPersonnel,
  markAllNotificationsAsRead
);
router.patch(
  '/notifications/:id/read',
  protectPersonnel,
  markNotificationAsRead
);

// Device binding is role-specific: a personnel token writes only the personnel
// account's token, never an admin or resident one.
router.post('/fcm-token', protectPersonnel, registerFcmToken);
router.delete('/fcm-token', protectPersonnel, clearFcmToken);

// --- Administrator-only personnel account management ------------------------

// Personnel accounts are admin-managed only. There is intentionally no
// registration route in this module.
router.use(protect, admin);

router.post('/', createPersonnel);
router.get('/', listPersonnel);
// The photograph captured while the account is being created is stored as its
// own request so account creation stays a plain JSON contract.
router.post('/:id/photo', uploadPersonnelImage, uploadPersonnelPhoto);
router.get('/:id', getPersonnelDetails);
router.patch('/:id', editPersonnel);
router.patch('/:id/password', resetPersonnelPassword);
router.post('/:id/reset-password', resetPersonnelPassword);
router.patch('/:id/status', updatePersonnelStatus);
router.patch('/:id/disable', disablePersonnel);
router.patch('/:id/enable', enablePersonnel);
router.delete('/:id', deletePersonnel);
router.patch('/:id/restore', restorePersonnel);

module.exports = router;

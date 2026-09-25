const express = require('express');
const router = express.Router();
const { protect, protectResident } = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');
const {
  getMyNotifications,
  getMyTrash,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  updateFcmToken,
  clearFcmToken,
  createReportEvent,
  moveToTrash,
  restoreNotification,
  deleteNotification,
} = require('../controllers/notificationController');

const residentOnly = [protect, protectResident];

router.get('/my-notifications', ...residentOnly, getMyNotifications);
router.get('/trash', ...residentOnly, getMyTrash);
router.get('/unread-count', ...residentOnly, getUnreadCount);
router.patch('/mark-as-read', ...residentOnly, markAllAsRead);
router.put('/fcm-token', ...residentOnly, updateFcmToken);
router.delete('/fcm-token', ...residentOnly, clearFcmToken);

// Server-owned creation is exposed only to authenticated administrators. The
// request supplies a report event, never recipient or notification content.
router.post('/events', protect, admin, createReportEvent);

router.patch('/:id/read', ...residentOnly, markAsRead);
router.post('/:id/move-to-trash', ...residentOnly, moveToTrash);
router.post('/:id/restore', ...residentOnly, restoreNotification);
router.delete('/:id', ...residentOnly, deleteNotification);

module.exports = router;

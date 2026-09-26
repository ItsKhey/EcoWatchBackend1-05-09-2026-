const express = require('express');
const router = express.Router();
const {
  protect,
  protectResident,
  protectNotificationOwner,
} = require('../middleware/authMiddleware');
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

// Phase 3A: the notification center is owned by whoever is signed in. Residents
// and administrators each see only their own rows.
const ownerOnly = [protect, protectNotificationOwner];

router.get('/my-notifications', ...ownerOnly, getMyNotifications);
router.get('/trash', ...ownerOnly, getMyTrash);
router.get('/unread-count', ...ownerOnly, getUnreadCount);
router.patch('/mark-as-read', ...ownerOnly, markAllAsRead);

// Device tokens stay role-specific: an administrator registers through
// /admin/fcm-token so a token is never written to the residents table.
router.put('/fcm-token', ...residentOnly, updateFcmToken);
router.delete('/fcm-token', ...residentOnly, clearFcmToken);

// Server-owned creation is exposed only to authenticated administrators. The
// request supplies a report event, never recipient or notification content.
router.post('/events', protect, admin, createReportEvent);

router.patch('/:id/read', ...ownerOnly, markAsRead);
router.post('/:id/move-to-trash', ...ownerOnly, moveToTrash);
router.post('/:id/restore', ...ownerOnly, restoreNotification);
router.delete('/:id', ...ownerOnly, deleteNotification);

module.exports = router;

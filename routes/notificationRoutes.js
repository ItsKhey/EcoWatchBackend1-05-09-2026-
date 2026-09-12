const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getMyNotifications,
  moveToTrash,
  restoreNotification,
  deleteNotification,
  markAllAsRead
} = require('../controllers/notificationController');

router.get('/my-notifications', protect, getMyNotifications);
router.post('/:id/move-to-trash', protect, moveToTrash);
router.post('/:id/restore', protect, restoreNotification);
router.delete('/:id', protect, deleteNotification);
router.patch('/mark-as-read', protect, markAllAsRead);

module.exports = router;

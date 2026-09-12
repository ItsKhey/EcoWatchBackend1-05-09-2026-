const Notification = require('../models/Notification');
const TrashNotification = require('../models/TrashNotification');

// @desc    Get all notifications for a resident
// @route   GET /api/notifications/my-notifications
// @access  Private
const getMyNotifications = async (req, res, next) => {
  try {
    const residentId = req.resident.residentId;
    const notifications = await Notification.find({ residentId, isDeleted: false }).sort({ createdAt: -1 });
    res.json(notifications);
  } catch (error) {
    next(error);
  }
};

// @desc    Move notification to trash
// @route   POST /api/notifications/:id/move-to-trash
// @access  Private
const moveToTrash = async (req, res, next) => {
  try {
    const notification = await Notification.findOne({ _id: req.params.id, residentId: req.resident.residentId });
    if (!notification) {
      res.status(404);
      throw new Error('Notification not found');
    }

    const trashData = notification.toObject();
    await TrashNotification.create({
      ...trashData,
      isDeleted: true,
      deletedAt: new Date()
    });

    await Notification.deleteOne({ _id: req.params.id });
    res.json({ message: 'Notification moved to trash' });
  } catch (error) {
    next(error);
  }
};

// @desc    Restore notification from trash
// @route   POST /api/notifications/:id/restore
// @access  Private
const restoreNotification = async (req, res, next) => {
  try {
    const trashNotification = await TrashNotification.findOne({ _id: req.params.id, residentId: req.resident.residentId });
    if (!trashNotification) {
      res.status(404);
      throw new Error('Notification not found in trash');
    }

    const notificationData = trashNotification.toObject();
    await Notification.create({
      ...notificationData,
      isDeleted: false,
      deletedAt: null
    });

    await TrashNotification.deleteOne({ _id: req.params.id });
    res.json({ message: 'Notification restored' });
  } catch (error) {
    next(error);
  }
};

// @desc    Permanently delete notification
// @route   DELETE /api/notifications/:id
// @access  Private
const deleteNotification = async (req, res, next) => {
  try {
    const notification = await Notification.findOne({ _id: req.params.id, residentId: req.resident.residentId })
                        || await TrashNotification.findOne({ _id: req.params.id, residentId: req.resident.residentId });

    if (!notification) {
      res.status(404);
      throw new Error('Notification not found');
    }

    if (notification.constructor.modelName === 'Notification') {
      await Notification.deleteOne({ _id: req.params.id });
    } else {
      await TrashNotification.deleteOne({ _id: req.params.id });
    }

    res.json({ message: 'Notification permanently deleted' });
  } catch (error) {
    next(error);
  }
};

// @desc    Mark all notifications as read
// @route   PATCH /api/notifications/mark-as-read
// @access  Private
const markAllAsRead = async (req, res, next) => {
  try {
    await Notification.updateMany(
      { residentId: req.resident.residentId, isRead: false },
      { isRead: true }
    );
    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getMyNotifications,
  moveToTrash,
  restoreNotification,
  deleteNotification,
  markAllAsRead
};

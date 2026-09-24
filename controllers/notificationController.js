const notificationRepository =
  require('../repositories/notificationRepository');

const trashNotificationRepository =
  require('../repositories/trashNotificationRepository');

// @desc    Get all notifications for a resident
// @route   GET /api/notifications/my-notifications
// @access  Private
const getMyNotifications = async (req, res, next) => {
  try {
    const residentId = req.resident.residentId || req.resident.resident_id;
    const notifications =
      await notificationRepository.findAllByResidentId(residentId);

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
    const residentId = req.resident.residentId || req.resident.resident_id;
    const notification = await notificationRepository.findById(
      req.params.id
    );

    if (!notification || notification.resident_id !== residentId) {
      res.status(404);
      throw new Error('Notification not found');
    }

    const existingTrash =
      await trashNotificationRepository.findByNotificationId(
        notification.id,
        residentId
      );

    if (!existingTrash) {
      await trashNotificationRepository.createTrashNotification(
        notification.id,
        residentId
      );
    }

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
    const residentId = req.resident.residentId || req.resident.resident_id;
    const trashNotification =
      await trashNotificationRepository.findByNotificationId(
        req.params.id,
        residentId
      );

    if (!trashNotification) {
      res.status(404);
      throw new Error('Notification not found in trash');
    }

    await trashNotificationRepository.deleteByNotificationId(
      req.params.id,
      residentId
    );

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
    const residentId = req.resident.residentId || req.resident.resident_id;
    const notification = await notificationRepository.findById(
      req.params.id
    );

    if (!notification || notification.resident_id !== residentId) {
      res.status(404);
      throw new Error('Notification not found');
    }

    await notificationRepository.deleteById(req.params.id);
    await trashNotificationRepository.deleteByNotificationId(
      req.params.id,
      residentId
    );

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
    const residentId = req.resident.residentId || req.resident.resident_id;
    await notificationRepository.markAllAsRead(residentId);

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

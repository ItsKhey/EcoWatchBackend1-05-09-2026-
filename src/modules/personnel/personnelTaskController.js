const personnelAssignmentService = require('./personnelAssignmentService');
const personnelNotificationService = require('./personnelNotificationService');
const personnelNotificationRepository = require('./personnelNotificationRepository');
const cleaningTeamService = require('./cleaningTeamService');
const { mapPersonnel } = require('./personnelController');
const { createHttpError } = require('../../shared/personnelValidation');

/**
 * HTTP layer for the Personnel app.
 *
 * Identity is always taken from `req.personnel`, which `protectPersonnel` sets
 * from the verified JWT. No personnel id is ever read from the body or the
 * query string, so one cleaner can never act on another cleaner's task.
 */

const personnelIdFromRequest = (req) => {
  const personnelId = req.personnel?.personnel_id;
  if (!personnelId) {
    throw createHttpError(401, 'Personnel identity is missing.');
  }

  return personnelId;
};

const getMe = async (req, res, next) => {
  try {
    const personnelId = personnelIdFromRequest(req);
    const teams = await cleaningTeamService.listTeamsForPersonnel({ personnelId });
    const listedTeam = teams.length ? teams[0] : null;
    const team = listedTeam
      ? await cleaningTeamService.getCleaningTeam({ teamId: listedTeam.teamId })
      : null;
    const isTeamLeader = Boolean(team && team.leaderId
      && String(team.leaderId).trim().toUpperCase()
        === String(personnelId).trim().toUpperCase());
    const personnel = {
      ...mapPersonnel(req.personnel),
      teamId: team ? team.teamId : null,
      teamName: team ? team.teamName : null,
      teamRole: team ? (isTeamLeader ? 'Leader' : 'Member') : null,
      isTeamLeader,
      teamLeaderName: team ? team.leaderName : null,
      teamMembers: team ? team.members : [],
    };

    res.set('Cache-Control', 'no-store');
    res.json({ success: true, personnel });
  } catch (error) {
    next(error);
  }
};

const getCurrentTask = async (req, res, next) => {
  try {
    const task = await personnelAssignmentService.getCurrentTask(
      personnelIdFromRequest(req)
    );
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, task });
  } catch (error) {
    next(error);
  }
};

const listTasks = async (req, res, next) => {
  try {
    const result = await personnelAssignmentService.listTasks(
      personnelIdFromRequest(req),
      req.query
    );
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      tasks: result.tasks,
      count: result.tasks.length,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
};

const getTaskCounts = async (req, res, next) => {
  try {
    const counts = await personnelAssignmentService.getTaskCounts(
      personnelIdFromRequest(req)
    );
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, counts });
  } catch (error) {
    next(error);
  }
};

const getTask = async (req, res, next) => {
  try {
    const task = await personnelAssignmentService.getTask(
      personnelIdFromRequest(req),
      req.params.assignmentId
    );
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, task });
  } catch (error) {
    next(error);
  }
};

const acceptTask = async (req, res, next) => {
  try {
    const task = await personnelAssignmentService.acceptTask(
      personnelIdFromRequest(req),
      req.params.assignmentId
    );
    res.json({ success: true, message: 'Task accepted.', task });
  } catch (error) {
    next(error);
  }
};

const startTask = async (req, res, next) => {
  try {
    const task = await personnelAssignmentService.startTask(
      personnelIdFromRequest(req),
      req.params.assignmentId,
      { requestId: req.requestId }
    );
    res.json({ success: true, message: 'Task started.', task });
  } catch (error) {
    next(error);
  }
};

const completeTask = async (req, res, next) => {
  try {
    const task = await personnelAssignmentService.completeTask(
      personnelIdFromRequest(req),
      req.params.assignmentId,
      {
        notes: req.body?.notes ?? req.body?.completionNotes ?? null,
        requestId: req.requestId,
      }
    );
    res.json({
      success: true,
      message: 'Task completed and submitted for approval.',
      task,
    });
  } catch (error) {
    next(error);
  }
};

const uploadEvidence = async (req, res, next) => {
  try {
    const result = await personnelAssignmentService.uploadEvidence(
      personnelIdFromRequest(req),
      req.params.assignmentId,
      {
        phase: req.body?.phase ?? req.query?.phase,
        file: req.file,
      }
    );
    res.status(201).json({
      success: true,
      message: 'Evidence uploaded.',
      evidence: result.evidence,
      task: result.task,
    });
  } catch (error) {
    next(error);
  }
};

const deleteEvidence = async (req, res, next) => {
  try {
    const task = await personnelAssignmentService.deleteEvidence(
      personnelIdFromRequest(req),
      req.params.assignmentId,
      req.params.evidenceId
    );
    res.json({ success: true, message: 'Evidence removed.', task });
  } catch (error) {
    next(error);
  }
};

const mapNotification = (row) => ({
  notificationId: String(row.notification_id),
  id: String(row.notification_id),
  mongoId: String(row.notification_id),
  assignmentId: row.assignment_id || null,
  reportId: row.report_id || null,
  title: row.title,
  message: row.message,
  type: row.type,
  isRead: row.is_read === true,
  createdAt: row.created_at,
});

const validateNotificationId = (value) => {
  const notificationId = String(value || '').trim();
  if (!/^\d{1,19}$/.test(notificationId)) {
    throw createHttpError(400, 'Invalid notification ID.');
  }

  return notificationId;
};

const getNotifications = async (req, res, next) => {
  try {
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw createHttpError(400, 'limit must be an integer between 1 and 200.');
    }

    const rows = await personnelNotificationRepository.listForPersonnel(
      personnelIdFromRequest(req),
      { limit }
    );
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      notifications: rows.map(mapNotification),
      count: rows.length,
    });
  } catch (error) {
    next(error);
  }
};

const getUnreadNotificationCount = async (req, res, next) => {
  try {
    const unreadCount = await personnelNotificationRepository.unreadCount(
      personnelIdFromRequest(req)
    );
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, unreadCount });
  } catch (error) {
    next(error);
  }
};

const markNotificationAsRead = async (req, res, next) => {
  try {
    const notification = await personnelNotificationRepository.markAsRead(
      personnelIdFromRequest(req),
      validateNotificationId(req.params.id)
    );

    if (!notification) {
      throw createHttpError(404, 'Notification not found.');
    }

    res.json({ success: true, notificationId: String(notification.notification_id) });
  } catch (error) {
    next(error);
  }
};

const markAllNotificationsAsRead = async (req, res, next) => {
  try {
    const updatedCount = await personnelNotificationRepository.markAllAsRead(
      personnelIdFromRequest(req)
    );
    res.json({ success: true, updatedCount });
  } catch (error) {
    next(error);
  }
};

const registerFcmToken = async (req, res, next) => {
  try {
    const forbidden = ['personnelId', 'personnel_id']
      .filter((key) => Object.prototype.hasOwnProperty.call(req.body || {}, key));
    if (forbidden.length) {
      throw createHttpError(
        400,
        'Personnel identity is server-owned; remove it from the request.'
      );
    }

    const token = String(req.body?.token || req.body?.fcmToken || '').trim();
    if (
      token.length < 20
      || token.length > 4096
      || /[\s\u0000-\u001F\u007F]/.test(token)
    ) {
      throw createHttpError(400, 'A valid FCM registration token is required.');
    }

    await personnelNotificationService.registerDeviceToken(
      personnelIdFromRequest(req),
      token
    );
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

const clearFcmToken = async (req, res, next) => {
  try {
    await personnelNotificationService.clearDeviceToken(
      personnelIdFromRequest(req)
    );
    res.status(204).end();
  } catch (error) {
    next(error);
  }
};

module.exports = {
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
};

const { createHttpError } = require('./personnelValidation');

const ADMIN_REPORT_STATUSES = Object.freeze({
  PENDING: 'Pending',
  IN_PROGRESS: 'In Progress',
  DENIED: 'Denied',
  COMPLETED: 'Completed',
});

const normalizeReportStatus = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
  return Object.values(ADMIN_REPORT_STATUSES)
    .find((status) => status.toLowerCase() === normalized) || null;
};

const validateAdminResponse = (value, { required = false } = {}) => {
  const response = String(value || '').trim();
  if (required && !response) {
    throw createHttpError(400, 'adminResponse is required for this status.');
  }
  if (response.length > 2000) {
    throw createHttpError(400, 'adminResponse must be 2000 characters or fewer.');
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(response)) {
    throw createHttpError(400, 'adminResponse contains unsupported characters.');
  }
  return response;
};

const validateStatusPayload = (body = {}) => {
  const forbidden = [
    'adminId',
    'admin_id',
    'assignedByAdminId',
    'assigned_by_admin_id',
    'residentId',
    'resident_id',
    'notificationId',
  ].filter((key) => Object.prototype.hasOwnProperty.call(body, key));
  if (forbidden.length) {
    throw createHttpError(
      400,
      `This operation is server-owned; remove: ${forbidden.join(', ')}.`
    );
  }

  const status = normalizeReportStatus(body.status);
  if (!status) {
    throw createHttpError(
      400,
      'status must be Pending, In Progress, Denied, or Completed.'
    );
  }

  const requiresResponse = [ADMIN_REPORT_STATUSES.IN_PROGRESS, ADMIN_REPORT_STATUSES.DENIED]
    .includes(status);
  const hasResponse = Object.prototype.hasOwnProperty.call(body, 'adminResponse');
  return {
    status,
    adminResponse: hasResponse || requiresResponse
      ? validateAdminResponse(body.adminResponse, { required: requiresResponse })
      : undefined,
  };
};

const validateResponsePayload = (body = {}) => {
  const forbidden = [
    'adminId',
    'admin_id',
    'status',
    'residentId',
    'resident_id',
  ].filter((key) => Object.prototype.hasOwnProperty.call(body, key));
  if (forbidden.length) {
    throw createHttpError(
      400,
      `This operation is server-owned; remove: ${forbidden.join(', ')}.`
    );
  }
  return {
    adminResponse: validateAdminResponse(body.adminResponse, { required: true }),
  };
};

module.exports = {
  ADMIN_REPORT_STATUSES,
  normalizeReportStatus,
  validateAdminResponse,
  validateStatusPayload,
  validateResponsePayload,
};

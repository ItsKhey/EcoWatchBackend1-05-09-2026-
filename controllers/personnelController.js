const bcrypt = require('bcryptjs');
const personnelRepository = require('../repositories/personnelRepository');
const generateToken = require('../utils/generateToken');
const { logInfo } = require('../utils/logger');
const {
  createHttpError,
  requireObject,
  validateCreatePayload,
  validateUpdatePayload,
  validatePassword,
  validatePersonnelId,
  validateStatusPayload,
  parseListQuery,
} = require('../utils/personnelValidation');

const BCRYPT_ROUNDS = 12;
const DUMMY_PASSWORD_HASH =
  '$2b$12$qbjGRNsYkcKw5q4PRNWJ0uHN/C4rzcqGTaUqUvUH6HapMZqfpsp.m';

const getAdminId = (req) => {
  const adminId = req.resident?.admin_id || req.resident?.resident_id;

  if (!adminId) {
    throw createHttpError(403, 'Authenticated administrator identity is missing.');
  }

  return adminId;
};

const mapCurrentAssignment = (personnel) => {
  if (!personnel.current_assignment_report_id) {
    return null;
  }

  const storedLocation = personnel.current_assignment_location || {};

  return {
    reportId: personnel.current_assignment_report_id,
    title: personnel.assignment_title || null,
    category: personnel.assignment_category || null,
    description: personnel.assignment_description || null,
    reportStatus: personnel.assignment_report_status || null,
    priority: personnel.assignment_priority || null,
    latitude:
      storedLocation.latitude ?? personnel.assignment_latitude ?? null,
    longitude:
      storedLocation.longitude ?? personnel.assignment_longitude ?? null,
    location: storedLocation,
    assignedAt: personnel.current_assignment_assigned_at || null,
    isArchived: personnel.assignment_is_archived === true,
    isDeleted: personnel.assignment_is_deleted === true,
  };
};

const mapPersonnel = (personnel) => ({
  personnelId: personnel.personnel_id,
  serverId: personnel.personnel_id,
  firstName: personnel.first_name,
  lastName: personnel.last_name,
  fullName: `${personnel.first_name} ${personnel.last_name}`.trim(),
  address: personnel.address || '',
  gmail: personnel.email,
  email: personnel.email,
  username: personnel.username,
  role: personnel.role || 'PERSONNEL',
  status: personnel.status,
  online: personnel.status === 'ONLINE',
  cleaning: personnel.status === 'CLEANING',
  isOnline: personnel.status === 'ONLINE',
  isCleaning: personnel.status === 'CLEANING',
  isActive: personnel.enabled === true && !personnel.deleted_at,
  isDisabled: personnel.enabled === false,
  isDeleted: Boolean(personnel.deleted_at),
  lastActive: personnel.last_active || null,
  currentAssignment: mapCurrentAssignment(personnel),
  assignmentReportId: personnel.current_assignment_report_id || null,
  assignmentLatitude:
    personnel.current_assignment_location?.latitude ??
    personnel.assignment_latitude ??
    null,
  assignmentLongitude:
    personnel.current_assignment_location?.longitude ??
    personnel.assignment_longitude ??
    null,
  phoneNumber: personnel.phone_number || '',
  enabled: personnel.enabled,
  disabledAt: personnel.disabled_at || null,
  deletedAt: personnel.deleted_at || null,
  createdById: personnel.created_by_admin_id || null,
  updatedById: personnel.updated_by_admin_id || null,
  disabledById: personnel.disabled_by_admin_id || null,
  deletedById: personnel.deleted_by_admin_id || null,
  dateCreated: personnel.created_at || null,
  createdAt: personnel.created_at || null,
  updatedAt: personnel.updated_at || null,
});

const findRequiredPersonnel = async (personnelId) => {
  const personnel = await personnelRepository.findByPersonnelId(personnelId);

  if (!personnel) {
    throw createHttpError(404, 'Personnel account not found.');
  }

  return personnel;
};

const assertIdentityAvailable = async ({
  username,
  email,
  excludePersonnelId = null,
}) => {
  const conflictSource =
    await personnelRepository.findCredentialConflict({
      username,
      email,
      excludePersonnelId,
    });

  if (conflictSource) {
    throw createHttpError(
      409,
      'Username or Gmail address is already registered to another account.'
    );
  }
};

const loginPersonnel = async (req, res, next) => {
  try {
    const body = requireObject(req.body);
    const identifier =
      typeof body.username === 'string'
        ? body.username.trim()
        : typeof body.identifier === 'string'
          ? body.identifier.trim()
          : typeof body.email === 'string'
            ? body.email.trim()
            : typeof body.gmail === 'string'
              ? body.gmail.trim()
              : '';
    const password = body.password;

    if (!identifier || typeof password !== 'string' || !password) {
      throw createHttpError(400, 'Username and password are required.');
    }

    if (Buffer.byteLength(password, 'utf8') > 72) {
      throw createHttpError(400, 'Password must not exceed 72 UTF-8 bytes.');
    }

    const personnel = await personnelRepository.findForLogin(identifier);
    const passwordMatches = await bcrypt.compare(
      password,
      personnel?.password_hash || DUMMY_PASSWORD_HASH
    );

    if (!personnel || !passwordMatches) {
      logInfo(
        req.requestId,
        'PERSONNEL_AUTH',
        `Personnel login failed for identifier: ${identifier}`
      );
      throw createHttpError(401, 'Invalid personnel username or password.');
    }

    if (!personnel.enabled || personnel.deleted_at) {
      logInfo(
        req.requestId,
        'PERSONNEL_AUTH',
        `Personnel login rejected for unavailable account: ${personnel.personnel_id}`
      );
      throw createHttpError(401, 'Invalid personnel username or password.');
    }

    const lastActive = await personnelRepository.updateLastActive(
      personnel.personnel_id
    );

    if (!lastActive) {
      throw createHttpError(401, 'Invalid personnel username or password.');
    }

    const token = generateToken(personnel.personnel_id, {
      role: 'PERSONNEL',
      accountType: 'PERSONNEL',
    });

    logInfo(
      req.requestId,
      'PERSONNEL_AUTH',
      `Personnel login successful: ${personnel.personnel_id}`
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      token,
      personnel: mapPersonnel({
        ...personnel,
        last_active: lastActive,
      }),
    });
  } catch (error) {
    next(error);
  }
};

const createPersonnel = async (req, res, next) => {
  try {
    const adminId = getAdminId(req);
    const payload = validateCreatePayload(req.body);

    await assertIdentityAvailable({
      username: payload.username,
      email: payload.email,
    });

    const passwordHash = await bcrypt.hash(payload.password, BCRYPT_ROUNDS);
    const personnel = await personnelRepository.createPersonnel({
      ...payload,
      createdByAdminId: adminId,
    });

    logInfo(
      req.requestId,
      'PERSONNEL',
      `Personnel account created: ${personnel.personnel_id} by ${adminId}`
    );

    res.set('Cache-Control', 'no-store');
    res.status(201).json({
      success: true,
      message: 'Personnel account created successfully.',
      personnel: mapPersonnel(personnel),
      temporaryPassword: payload.password,
    });
  } catch (error) {
    next(error);
  }
};

const listPersonnel = async (req, res, next) => {
  try {
    const options = parseListQuery(req.query);
    const personnel = await personnelRepository.findAll(options);
    const total = personnel.length ? Number(personnel[0].total_count) : 0;

    res.json({
      success: true,
      personnel: personnel.map(mapPersonnel),
      count: personnel.length,
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        totalPages: Math.ceil(total / options.limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

const listPersonnelLegacy = async (req, res, next) => {
  try {
    const options = parseListQuery(req.query);
    const personnel = await personnelRepository.findAll(options);

    // The admin Android contract expects a raw array from
    // GET /api/admin/personnel. The /api/personnel alias uses the consistent
    // success envelope and pagination metadata.
    res.json(personnel.map(mapPersonnel));
  } catch (error) {
    next(error);
  }
};

const getPersonnelDetails = async (req, res, next) => {
  try {
    const personnelId = validatePersonnelId(req.params.id);
    const personnel = await findRequiredPersonnel(personnelId);

    res.json({
      success: true,
      personnel: mapPersonnel(personnel),
    });
  } catch (error) {
    next(error);
  }
};

const editPersonnel = async (req, res, next) => {
  try {
    const adminId = getAdminId(req);
    const personnelId = validatePersonnelId(req.params.id);
    const updates = validateUpdatePayload(req.body);
    const existing = await findRequiredPersonnel(personnelId);

    if (existing.deleted_at) {
      throw createHttpError(409, 'Deleted personnel accounts cannot be edited.');
    }

    if (updates.username || updates.email) {
      await assertIdentityAvailable({
        username: updates.username || existing.username,
        email: updates.email || existing.email,
        excludePersonnelId: personnelId,
      });
    }

    const personnel = await personnelRepository.updatePersonnel(
      personnelId,
      updates,
      adminId
    );

    if (!personnel) {
      throw createHttpError(404, 'Personnel account not found.');
    }

    res.json({
      success: true,
      message: 'Personnel account updated successfully.',
      personnel: mapPersonnel(personnel),
    });
  } catch (error) {
    next(error);
  }
};

const resetPersonnelPassword = async (req, res, next) => {
  try {
    const adminId = getAdminId(req);
    const personnelId = validatePersonnelId(req.params.id);
    const body = requireObject(req.body);
    const newPasswordValue = body.newPassword ?? body.password;
    const password = validatePassword(newPasswordValue, 'New password');

    // The Android admin currently sends only newPassword. If it also sends
    // password, treat that value as the current administrator password and
    // require re-authentication before changing another account.
    if (
      body.newPassword !== undefined &&
      body.password !== undefined &&
      req.resident?.password_hash &&
      !await bcrypt.compare(String(body.password), req.resident.password_hash)
    ) {
      throw createHttpError(403, 'Current administrator password is incorrect.');
    }

    const existing = await findRequiredPersonnel(personnelId);

    if (existing.deleted_at) {
      throw createHttpError(409, 'Deleted personnel accounts cannot be reset.');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const personnel = await personnelRepository.updatePassword(
      personnelId,
      passwordHash,
      adminId
    );

    if (!personnel) {
      throw createHttpError(404, 'Personnel account not found.');
    }

    logInfo(
      req.requestId,
      'PERSONNEL',
      `Personnel password reset: ${personnelId} by ${adminId}`
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      message: 'Personnel password reset successfully.',
      personnel: mapPersonnel(personnel),
      temporaryPassword: password,
    });
  } catch (error) {
    next(error);
  }
};

const updatePersonnelStatus = async (req, res, next) => {
  try {
    const adminId = getAdminId(req);
    const personnelId = validatePersonnelId(req.params.id);
    const status = validateStatusPayload(requireObject(req.body));
    const existing = await findRequiredPersonnel(personnelId);

    if (existing.deleted_at || !existing.enabled) {
      throw createHttpError(
        409,
        'Personnel account must be enabled and not deleted before its status can change.'
      );
    }

    if (status === 'CLEANING' && !existing.current_assignment_report_id) {
      throw createHttpError(
        409,
        'A current report assignment is required before setting status to CLEANING.'
      );
    }

    const personnel = await personnelRepository.updateStatus(
      personnelId,
      status,
      adminId
    );

    if (!personnel) {
      throw createHttpError(404, 'Personnel account not found.');
    }

    res.json({
      success: true,
      message: 'Personnel status updated successfully.',
      personnel: mapPersonnel(personnel),
    });
  } catch (error) {
    next(error);
  }
};

const disablePersonnel = async (req, res, next) => {
  try {
    const adminId = getAdminId(req);
    const personnelId = validatePersonnelId(req.params.id);
    const existing = await findRequiredPersonnel(personnelId);

    if (existing.deleted_at) {
      throw createHttpError(409, 'Deleted personnel accounts cannot be disabled.');
    }

    if (existing.current_assignment_report_id) {
      throw createHttpError(
        409,
        'Personnel must be removed from the current report assignment before being disabled.'
      );
    }

    const personnel = await personnelRepository.disablePersonnel(
      personnelId,
      adminId
    );

    if (!personnel) {
      throw createHttpError(
        409,
        'Personnel could not be disabled while an active report assignment exists.'
      );
    }

    res.json({
      success: true,
      message: 'Personnel account disabled successfully.',
      personnel: mapPersonnel(personnel),
    });
  } catch (error) {
    next(error);
  }
};

const enablePersonnel = async (req, res, next) => {
  try {
    const adminId = getAdminId(req);
    const personnelId = validatePersonnelId(req.params.id);
    const existing = await findRequiredPersonnel(personnelId);

    if (existing.deleted_at) {
      throw createHttpError(
        409,
        'Deleted personnel accounts must be restored before they can be enabled.'
      );
    }

    if (existing.current_assignment_report_id) {
      throw createHttpError(
        409,
        'Personnel cannot be enabled while a report assignment reference exists.'
      );
    }

    const personnel = await personnelRepository.enablePersonnel(
      personnelId,
      adminId
    );

    if (!personnel) {
      throw createHttpError(409, 'Personnel account could not be enabled.');
    }

    res.json({
      success: true,
      message: 'Personnel account enabled successfully.',
      personnel: mapPersonnel(personnel),
    });
  } catch (error) {
    next(error);
  }
};

const deletePersonnel = async (req, res, next) => {
  try {
    const adminId = getAdminId(req);
    const personnelId = validatePersonnelId(req.params.id);
    const existing = await findRequiredPersonnel(personnelId);

    if (existing.deleted_at) {
      throw createHttpError(409, 'Personnel account is already deleted.');
    }

    if (existing.current_assignment_report_id) {
      throw createHttpError(
        409,
        'Personnel must be removed from the current report assignment before deletion.'
      );
    }

    const personnel = await personnelRepository.deletePersonnel(
      personnelId,
      adminId
    );

    if (!personnel) {
      throw createHttpError(
        409,
        'Personnel could not be deleted while an active report assignment exists.'
      );
    }

    res.json({
      success: true,
      message: 'Personnel account deleted successfully.',
      personnel: mapPersonnel(personnel),
    });
  } catch (error) {
    next(error);
  }
};

const restorePersonnel = async (req, res, next) => {
  try {
    const adminId = getAdminId(req);
    const personnelId = validatePersonnelId(req.params.id);
    const existing = await findRequiredPersonnel(personnelId);

    if (!existing.deleted_at) {
      throw createHttpError(409, 'Personnel account is not deleted.');
    }

    const personnel = await personnelRepository.restorePersonnel(
      personnelId,
      adminId
    );

    if (!personnel) {
      throw createHttpError(
        409,
        'Personnel cannot be restored while a report assignment reference exists.'
      );
    }

    res.json({
      success: true,
      message: 'Personnel account restored successfully.',
      personnel: mapPersonnel(personnel),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  loginPersonnel,
  createPersonnel,
  listPersonnel,
  listPersonnelLegacy,
  getPersonnelDetails,
  editPersonnel,
  resetPersonnelPassword,
  updatePersonnelStatus,
  disablePersonnel,
  enablePersonnel,
  deletePersonnel,
  restorePersonnel,
  mapPersonnel,
};

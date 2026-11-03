const bcrypt = require('bcryptjs');
const personnelRepository = require('./personnelRepository');
const personnelAssignmentRepository = require('./personnelAssignmentRepository');
const vehicleRepository = require('../vehicles/vehicleRepository');
const reportRepository = require('../reports/reportRepository');
const historyRepository = require('../history/historyRepository');
const reportPhotoService = require('../reports/reportPhotoService');
const { uploadImage, destroyImage } = require('../../shared/cloudinaryService');
const generateToken = require('../../shared/generateToken');
const { logInfo, logError } = require('../../shared/logger');
const { CATEGORY, SUBJECT_TYPE } = require('../../shared/historyActions');
// Report and statistic shapes are shared with the reporter detail screen so
// both render identically; reusing the mappers keeps one wire contract.
const { mapReport, mapStatistics } = require('../residents/residentAdminController');

// The revision reason is a personnel-only note. Keep it off resident report
// payloads and add it only to the authenticated personnel history response.
const mapPersonnelReport = (report) => ({
  ...mapReport(report),
  personnelNote: report.personnel_note || '',
  // The cleaning lifecycle for this task. Only the personnel history renders it,
  // but it travels on the report so one request still fills the whole screen.
  timeline: Array.isArray(report.timeline) ? report.timeline : [],
});
const {
  createHttpError,
  requireObject,
  validateCreatePayload,
  validateUpdatePayload,
  validatePassword,
  validatePersonnelId,
  validateStatusPayload,
  parseListQuery,
  PERSONNEL_OCCUPATIONS,
} = require('../../shared/personnelValidation');
const { VEHICLE_STATUSES } = require('../vehicles/vehicleValidation');
const { parseReportPageQuery } = require('../../shared/residentValidation');

const BCRYPT_ROUNDS = 12;
const DUMMY_PASSWORD_HASH =
  '$2b$12$qbjGRNsYkcKw5q4PRNWJ0uHN/C4rzcqGTaUqUvUH6HapMZqfpsp.m';

const getAdminId = (req) => {
  const adminId = req.admin?.admin_id;

  if (!adminId) {
    throw createHttpError(403, 'Authenticated administrator identity is missing.');
  }

  return adminId;
};

/**
 * Records an ESP account-management decision in the Admin History trail.
 *
 * Best-effort for the same reason as the announcement trail: the account change
 * is already committed and the administrator has seen it accepted, so a failed
 * audit write is logged rather than turned into a failed action. The worst case
 * is one missing row; the worst case of throwing would be an account change the
 * administrator believes was rolled back when it was not.
 */
const recordPersonnelHistory = async (personnelId, {
  action,
  description,
  adminId,
  label = null,
  oldStatus = null,
  newStatus = null,
}) => {
  try {
    await historyRepository.createHistory({
      action,
      category: CATEGORY.ACCOUNT,
      subjectType: SUBJECT_TYPE.PERSONNEL,
      subjectId: personnelId,
      subjectLabel: label,
      adminId: adminId || null,
      oldStatus,
      newStatus,
      description,
    });
  } catch (error) {
    logError(
      null,
      'PERSONNEL_HISTORY',
      `Personnel ${personnelId} was handled but its history record failed: ${error.message}`
    );
  }
};

/** "Juan Dela Cruz" for the card label, falling back to the id alone. */
const personnelLabel = (personnel) => {
  if (!personnel) return null;

  const first = String(personnel.first_name || '').trim();
  const last = String(personnel.last_name || '').trim();
  const full = [first, last].filter(Boolean).join(' ');

  return full || personnel.personnel_id || null;
};

const mapCurrentAssignment = (personnel) => {
  if (!personnel.current_assignment_report_id) {
    return null;
  }

  const storedLocation = personnel.current_assignment_location || {};

  return {
    reportId: personnel.current_assignment_report_id,
    title: personnel.current_assignment || personnel.assignment_title || null,
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

/**
 * The truck a driver is assigned to, for the Admin card.
 *
 * <p>Null rather than omitted for a Regular cleaner, so the app can tell "not a
 * driver" from "a driver whose truck is missing" without inspecting the
 * occupation too.
 */
const mapAssignedVehicle = (personnel) => {
  if (!personnel.assigned_vehicle_id) {
    return null;
  }

  return {
    vehicleId: personnel.assigned_vehicle_id,
    plateNumber: personnel.assigned_vehicle_plate_number || null,
    vehicleType: personnel.assigned_vehicle_type || null,
    status: personnel.assigned_vehicle_status || null,
    isDeleted: personnel.assigned_vehicle_is_deleted === true,
  };
};

const mapPersonnel = (personnel) => {
  const cleaning = personnel.is_cleaning === true
    || String(personnel.status || '').toUpperCase() === 'CLEANING';

  return {
    personnelId: personnel.personnel_id,
    serverId: personnel.personnel_id,
    firstName: personnel.first_name,
    lastName: personnel.last_name,
    fullName: `${personnel.first_name} ${personnel.last_name}`.trim(),
    address: personnel.address || '',
    gmail: personnel.email,
    email: personnel.email,
    username: personnel.username,
    profileImage: personnel.profile_image || '',
    profileImageUrl: personnel.profile_image || '',
    avatarUrl: personnel.profile_image || '',
    role: personnel.role || 'PERSONNEL',
    status: personnel.status,
    online: personnel.status === 'ONLINE' && !cleaning,
    cleaning,
    is_cleaning: cleaning,
    isOnline: personnel.status === 'ONLINE' && !cleaning,
    isCleaning: cleaning,
    isActive: personnel.enabled === true && !personnel.deleted_at,
    isDisabled: personnel.enabled === false,
    isDeleted: Boolean(personnel.deleted_at),
    lastActive: personnel.last_active || null,
    currentAssignment: mapCurrentAssignment(personnel),
    currentAssignmentText: personnel.current_assignment || null,
    current_assignment: personnel.current_assignment || null,
    current_assignment_report_id: personnel.current_assignment_report_id || null,
    current_assignment_location: personnel.current_assignment_location || null,
    current_assignment_assigned_at: personnel.current_assignment_assigned_at || null,
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
    messengerLink: personnel.messenger_link || '',
    // Sent under both spellings: the Admin client reads `occupation`, and the
    // create payload accepts either. One vocabulary on the wire, two names it is
    // reachable by, so a client that has only been half updated still paints the
    // right card.
    occupation: personnel.occupation || PERSONNEL_OCCUPATIONS.REGULAR,
    occupationType: personnel.occupation || PERSONNEL_OCCUPATIONS.REGULAR,
    assignedVehicleId: personnel.assigned_vehicle_id || null,
    vehicleId: personnel.assigned_vehicle_id || null,
    teamName: personnel.team_name || null,
    teamRole: personnel.team_role || null,
    assignedVehiclePlateNumber: personnel.assigned_vehicle_plate_number || null,
    vehiclePlateNumber: personnel.assigned_vehicle_plate_number || null,
    assignedVehicle: mapAssignedVehicle(personnel),
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
  };
};

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

/**
 * Checks that a truck can actually be handed to a driver.
 *
 * <p>Three separate refusals, each with its own status, because they mean
 * different things to whoever pressed the button: the truck is not in the fleet
 * (404, it was removed or the id is a typo), it cannot be driven right now (409,
 * it is on a collection or in the workshop), or another working driver already
 * holds it (409, one truck has one driver).
 *
 * <p>Assigning a driver does NOT change the vehicle's status. Status there means
 * what the truck is doing — 'Assigned' is out on a collection, set by report
 * dispatch — so overloading it with "has a driver" would put a truck parked in
 * the depot on the fleet cards as though it were working.
 */
const assertAssignableVehicle = async (
  assignedVehicleId,
  { excludePersonnelId = null } = {}
) => {
  if (!assignedVehicleId) {
    return null;
  }

  const vehicle = await vehicleRepository.findByVehicleId(assignedVehicleId);

  if (!vehicle || vehicle.isDeleted) {
    throw createHttpError(404, 'That vehicle is not in the fleet.');
  }

  if (vehicle.status !== VEHICLE_STATUSES.AVAILABLE) {
    throw createHttpError(
      409,
      `Vehicle ${vehicle.plateNumber} is ${vehicle.status.toLowerCase()} and cannot be assigned to a driver.`
    );
  }

  const currentDriver = await personnelRepository.findByAssignedVehicleId(
    assignedVehicleId,
    { excludePersonnelId }
  );

  if (currentDriver) {
    const name = [currentDriver.first_name, currentDriver.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();
    throw createHttpError(
      409,
      `Vehicle ${vehicle.plateNumber} is already assigned to ${name || currentDriver.personnel_id}.`
    );
  }

  return vehicle;
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

    // Hash the validated plaintext before crossing the repository boundary.
    // Never spread payload into the repository: payload.password is plaintext
    // and the repository intentionally accepts only passwordHash.
    const passwordHash = await bcrypt.hash(payload.password, BCRYPT_ROUNDS);

    // Checked before the account is written so a bad truck id leaves no half-made
    // personnel row behind for the administrator to clean up.
    const vehicle = await assertAssignableVehicle(payload.assignedVehicleId);

    const personnel = await personnelRepository.createPersonnel({
      firstName: payload.firstName,
      lastName: payload.lastName,
      address: payload.address,
      email: payload.email,
      username: payload.username,
      passwordHash,
      phoneNumber: payload.phoneNumber,
      messengerLink: payload.messengerLink,
      occupation: payload.occupation,
      assignedVehicleId: payload.assignedVehicleId,
      createdByAdminId: adminId,
    });

    logInfo(
      req.requestId,
      'PERSONNEL',
      `Personnel account created: ${personnel.personnel_id} by ${adminId}`
    );

    await recordPersonnelHistory(personnel.personnel_id, {
      action: 'PERSONNEL_CREATED',
      label: personnelLabel(personnel),
      adminId,
      description: `ESP account created for ${personnelLabel(personnel)} `
        + `(Personnel ID: ${personnel.personnel_id}). Created by Admin.`,
    });

    res.set('Cache-Control', 'no-store');
    res.status(201).json({
      success: true,
      message: 'Personnel account created successfully.',
      personnel: mapPersonnel(personnel),
      temporaryPassword: payload.password,
      // Echoed so a client can confirm what was stored without a second read.
      // The app already refreshes the roster, but a create response that omitted
      // the fields it just accepted would be indistinguishable from one that
      // dropped them.
      occupation: payload.occupation,
      assignedVehicleId: payload.assignedVehicleId,
      assignedVehiclePlateNumber: vehicle ? vehicle.plateNumber : null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Saves the personnel photograph taken by the administrator during account
 * creation (or any later replacement of it).
 *
 * The multer middleware in the route hands the image over as an in-memory
 * buffer so the storage provider stays a service-layer choice, exactly like
 * report and evidence photos. The row is only updated after the upload
 * succeeds, so a failed storage write never leaves a dangling URL behind.
 */
const uploadPersonnelPhoto = async (req, res, next) => {
  try {
    const adminId = getAdminId(req);
    const personnelId = validatePersonnelId(req.params.id);
    const existing = await findRequiredPersonnel(personnelId);

    if (!req.file) {
      throw createHttpError(400, 'Please upload an image.');
    }

    if (existing.deleted_at) {
      throw createHttpError(
        409,
        'Deleted personnel accounts cannot be updated.'
      );
    }

    const stored = await uploadImage(
      req.file.buffer,
      'ecowatch/personnel'
    );

    const personnel = await personnelRepository.updateProfileImage(
      personnelId,
      stored.secure_url,
      adminId
    );

    if (!personnel) {
      throw createHttpError(404, 'Personnel account not found.');
    }

    // Best-effort removal of the replaced photo. destroyImage always resolves,
    // so an orphaned asset is the only outcome of a failure here.
    if (
      existing.profile_image &&
      existing.profile_image !== stored.secure_url
    ) {
      await destroyImage(existing.profile_image);
    }

    logInfo(
      req.requestId,
      'PERSONNEL',
      `Personnel photo saved: ${personnelId} by ${adminId}`
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      message: 'Personnel photo saved successfully.',
      personnel: mapPersonnel(personnel),
      profileImage: personnel.profile_image || '',
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

/**
 * Reports with current or historical assignments for one personnel member,
 * newest first. Historical assignment rows keep completed and revised work
 * discoverable after the live report assignment has been released.
 *
 * The account is looked up first so an unknown personnel ID returns the same
 * 404 as the details endpoint instead of an empty page that looks like a
 * personnel member with no work.
 */
const getPersonnelReports = async (req, res, next) => {
  try {
    getAdminId(req);
    const personnelId = validatePersonnelId(req.params.id);
    const personnel = await findRequiredPersonnel(personnelId);
    const options = parseReportPageQuery(req.query);
    const reportPage = await reportRepository.findPageForPersonnel(
      personnel.personnel_id,
      options
    );
    const total = reportPage.total;
    const reportIds = reportPage.reports.map((report) => report.report_id);
    const revisionRequested = await historyRepository.findRevisionRequestedReportIds(
      reportIds
    );
    const timelines = await historyRepository.findTaskTimelinesByReportIds(reportIds);
    const reports = reportPage.reports.map((report) => mapPersonnelReport({
      ...report,
      revision_requested: revisionRequested.has(report.report_id),
      timeline: timelines.get(report.report_id) || [],
    }));

    await reportPhotoService.attachPhotoLists(reports);

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      reports,
      count: reportPage.reports.length,
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

/** Aggregate counts for the assigned-task stat cards on the details screen. */
const getPersonnelReportStatistics = async (req, res, next) => {
  try {
    getAdminId(req);
    const personnelId = validatePersonnelId(req.params.id);
    const personnel = await findRequiredPersonnel(personnelId);
    const statistics = await reportRepository.getReportCountsByPersonnelId(
      personnel.personnel_id
    );
    const mappedStatistics = mapStatistics(statistics);

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      statistics: mappedStatistics,
      counts: mappedStatistics,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Task counts for one cleaner, counted from the assignment rows rather than
 * from report status.
 *
 * The report-status aggregates above cannot answer "how much has this cleaner
 * finished", because a report only becomes `completed` once an administrator
 * signs it off. A cleaner who finishes ten tasks in a row still shows zero
 * completed until every one of those reports has been approved, which is why
 * the admin cards disagreed with the cleaner's own profile.
 *
 * The assignment row is the record of the cleaner's own work: it moves to
 * COMPLETED the moment they submit, and it is the same row the Personnel app
 * counts, so both screens now show the same numbers. `totalAssigned` is every
 * task this cleaner was ever given (including cancelled ones), and `onHand` is
 * defined the same way on both screens: work still in this cleaner's hands,
 * meaning assigned, accepted or in progress.
 */
const getPersonnelTaskCounts = async (req, res, next) => {
  try {
    getAdminId(req);
    const personnelId = validatePersonnelId(req.params.id);
    const personnel = await findRequiredPersonnel(personnelId);
    const counts = await personnelAssignmentRepository.countsByPersonnelId(
      personnel.personnel_id
    );

    const total = Number(counts.total || 0);
    const assigned = Number(counts.assigned || 0);
    const accepted = Number(counts.accepted || 0);
    const inProgress = Number(counts.in_progress || 0);
    const completed = Number(counts.completed || 0);
    const cancelled = Number(counts.cancelled || 0);

    const taskCounts = {
      totalAssigned: total,
      total_assigned: total,
      onHand: assigned + accepted + inProgress,
      on_hand: assigned + accepted + inProgress,
      inProgress,
      in_progress: inProgress,
      completed,
      assigned,
      accepted,
      cancelled,
    };

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      counts: taskCounts,
      taskCounts,
      generatedAt: new Date().toISOString(),
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

    // Demoting to Regular takes the truck with it.
    //
    // Without this a demotion would be refused outright, because the account
    // still holds a vehicle the new occupation forbids. Making the demotion
    // release it is the behaviour an administrator expects: the person stopped
    // driving, so the truck is free again, and the fleet screen stops showing it
    // as spoken for.
    if (
      updates.occupation === PERSONNEL_OCCUPATIONS.REGULAR
      && updates.assignedVehicleId === undefined
    ) {
      updates.assignedVehicleId = null;
    }

    // The pair is only checkable here, where the account's current values are
    // visible. A vehicle carried into Regular from the stored row is the
    // contradiction worth refusing.
    const nextOccupation = updates.occupation ?? existing.occupation;
    const nextVehicleId =
      updates.assignedVehicleId !== undefined
        ? updates.assignedVehicleId
        : existing.assigned_vehicle_id;

    if (
      nextOccupation === PERSONNEL_OCCUPATIONS.REGULAR
      && nextVehicleId
    ) {
      throw createHttpError(400, 'Only a Driver can be assigned a vehicle.');
    }

    if (nextVehicleId && nextVehicleId !== existing.assigned_vehicle_id) {
      await assertAssignableVehicle(nextVehicleId, { excludePersonnelId: personnelId });
    }

    const personnel = await personnelRepository.updatePersonnel(
      personnelId,
      updates,
      adminId
    );

    if (!personnel) {
      throw createHttpError(404, 'Personnel account not found.');
    }

    // The changed field names are recorded rather than the whole payload: an
    // audit row naming every stored column would be noise, and the point is to
    // answer "what did the admin change about this account".
    const changedFields = Object.keys(updates).filter((key) => updates[key] !== undefined);

    await recordPersonnelHistory(personnelId, {
      action: 'PERSONNEL_UPDATED',
      label: personnelLabel(personnel),
      adminId,
      description: `ESP account information updated for ${personnelLabel(personnel)}`
        + (changedFields.length > 0 ? ` (${changedFields.join(', ')}).` : '.'),
    });

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

    // Recorded without the password, and stating explicitly that it was not
    // recorded. An audit trail that silently omits a credential reset is worse
    // than one that says so.
    await recordPersonnelHistory(personnelId, {
      action: 'PERSONNEL_PASSWORD_RESET',
      label: personnelLabel(personnel),
      adminId,
      description: `ESP account credentials reset for ${personnelLabel(personnel)} `
        + `(Personnel ID: ${personnelId}). The password itself is not recorded.`,
    });

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

    if (status !== 'CLEANING' && existing.current_assignment_report_id) {
      throw createHttpError(
        409,
        'Personnel cannot leave CLEANING while a report assignment is active. Unassign the report first.'
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

    await recordPersonnelHistory(personnelId, {
      action: 'PERSONNEL_UPDATED',
      label: personnelLabel(personnel),
      adminId,
      oldStatus: existing.status,
      newStatus: status,
      description: `ESP account status changed for ${personnelLabel(personnel)} `
        + `from ${existing.status} to ${status}.`,
    });

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

    await recordPersonnelHistory(personnelId, {
      action: 'PERSONNEL_DEACTIVATED',
      label: personnelLabel(personnel),
      adminId,
      oldStatus: 'ACTIVE',
      newStatus: 'DISABLED',
      description: `ESP account deactivated for ${personnelLabel(personnel)} `
        + `(Personnel ID: ${personnelId}). Deactivated by Admin.`,
    });

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

    await recordPersonnelHistory(personnelId, {
      action: 'PERSONNEL_ACTIVATED',
      label: personnelLabel(personnel),
      adminId,
      oldStatus: 'DISABLED',
      newStatus: 'ACTIVE',
      description: `ESP account activated for ${personnelLabel(personnel)} `
        + `(Personnel ID: ${personnelId}). Activated by Admin.`,
    });

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

    await recordPersonnelHistory(personnelId, {
      action: 'PERSONNEL_DELETED',
      label: personnelLabel(personnel),
      adminId,
      description: `ESP account deleted for ${personnelLabel(personnel)} `
        + `(Personnel ID: ${personnelId}). Deleted by Admin.`,
    });

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

    await recordPersonnelHistory(personnelId, {
      action: 'PERSONNEL_RESTORED',
      label: personnelLabel(personnel),
      adminId,
      oldStatus: 'DELETED',
      newStatus: existing.enabled ? 'ACTIVE' : 'DISABLED',
      description: `ESP account restored for ${personnelLabel(personnel)} `
        + `(Personnel ID: ${personnelId}). Restored by Admin.`,
    });

    res.json({
      success: true,
      message: 'Personnel account restored successfully.',
      personnel: mapPersonnel(personnel),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Checks a password without changing anything.
 *
 * <p>Used by the app before it registers a fingerprint for the current account.
 * That decision has to be gated on something the cleaner actually knows today,
 * otherwise anyone holding an unlocked phone could enrol their own biometric and
 * sign in as the account holder without ever seeing the password.
 *
 * <p>The attempt is deliberately not throttled differently from a failed login:
 * a distinct limit would tell an attacker which guesses were being made against
 * this endpoint rather than the login route.
 */
const verifyOwnPassword = async (req, res, next) => {
  try {
    const personnelId = req.personnel?.personnel_id;

    if (!personnelId) {
      throw createHttpError(401, 'Personnel identity is missing.');
    }

    const body = requireObject(req.body);
    const password = body.password ?? body.currentPassword;

    if (typeof password !== 'string' || !password) {
      throw createHttpError(400, 'Password is required.');
    }

    if (Buffer.byteLength(password, 'utf8') > 72) {
      throw createHttpError(400, 'Password must not exceed 72 UTF-8 bytes.');
    }

    const stored = await personnelRepository.findPasswordHashByPersonnelId(
      personnelId
    );

    const matches = await bcrypt.compare(
      password,
      stored?.password_hash || DUMMY_PASSWORD_HASH
    );

    if (!stored || !matches) {
      throw createHttpError(401, 'Incorrect password.');
    }

    res.set('Cache-Control', 'no-store');
    res.json({ success: true, message: 'Password verified.' });
  } catch (error) {
    next(error);
  }
};

/**
 * The cleaner changing their own password from the Security & Privacy screen.
 *
 * Distinct from resetPersonnelPassword, which is the administrator route: this
 * one proves ownership with the current password instead of an admin token, so a
 * shared phone with an open session cannot be used to take over the account.
 * Identity comes from protectPersonnel, never from the body.
 */
const changeOwnPassword = async (req, res, next) => {
  try {
    const personnelId = req.personnel?.personnel_id;

    if (!personnelId) {
      throw createHttpError(401, 'Personnel identity is missing.');
    }

    const body = requireObject(req.body);
    const currentPassword = body.oldPassword ?? body.currentPassword;
    const newPassword = validatePassword(
      body.newPassword ?? body.password,
      'New password'
    );

    if (typeof currentPassword !== 'string' || !currentPassword) {
      throw createHttpError(400, 'Current password is required.');
    }

    if (currentPassword === newPassword) {
      throw createHttpError(
        400,
        'The new password must be different from the current one.'
      );
    }

    const stored = await personnelRepository.findPasswordHashByPersonnelId(
      personnelId
    );

    // Compare against a dummy hash when the row is gone so a missing account and
    // a wrong password take the same time to answer.
    const matches = await bcrypt.compare(
      currentPassword,
      stored?.password_hash || DUMMY_PASSWORD_HASH
    );

    if (!stored || !matches) {
      throw createHttpError(401, 'Current password is incorrect.');
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const updated = await personnelRepository.updateOwnPassword(
      personnelId,
      passwordHash
    );

    if (!updated) {
      throw createHttpError(404, 'Personnel account not found.');
    }

    logInfo(
      req.requestId,
      'PERSONNEL',
      `Personnel changed own password: ${personnelId}`
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      message: 'Password updated successfully.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  loginPersonnel,
  verifyOwnPassword,
  changeOwnPassword,
  createPersonnel,
  uploadPersonnelPhoto,
  listPersonnel,
  listPersonnelLegacy,
  getPersonnelDetails,
  getPersonnelReports,
  getPersonnelReportStatistics,
  getPersonnelTaskCounts,
  editPersonnel,
  resetPersonnelPassword,
  updatePersonnelStatus,
  disablePersonnel,
  enablePersonnel,
  deletePersonnel,
  restorePersonnel,
  mapPersonnel,
};

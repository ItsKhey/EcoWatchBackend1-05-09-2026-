const { pool } = require('../../config/db');
const vehicleRepository = require('./vehicleRepository');
const reportRepository = require('../reports/reportRepository');
const historyRepository = require('../history/historyRepository');
const reportPhotoService = require('../reports/reportPhotoService');
const { mapReport } = require('../residents/residentAdminController');
const {
  VEHICLE_STATUSES,
  createHttpError,
  normalizeVehicleFilter,
  normalizeVehicleId,
  validateCreateVehiclePayload,
  validateUpdateVehiclePayload,
} = require('./vehicleValidation');

/**
 * The fleet behind the Admin app's Personnel/Vehicles selector.
 *
 * <p>Every route is administrator-only: the vehicle list is the same operational
 * picture as the personnel roster beside it, and neither is a resident-facing
 * surface.
 */

/** Assignment audit fields come from the authenticated admin, never the body. */
const requireAdminActor = (req) => {
  const adminId = req.admin?.admin_id;
  if (!adminId) {
    throw createHttpError(403, 'Authenticated administrator identity is missing.');
  }
  return String(adminId);
};

/**
 * Refuses a plate that a live vehicle already holds.
 *
 * <p>Checked here rather than only in the database so the administrator gets a
 * message naming the vehicle that owns it. The unique index is still the real
 * guarantee; this just turns the common case into something readable.
 */
const assertPlateAvailable = async (plateNumber, excludeVehicleId) => {
  const taken = await vehicleRepository.isPlateTaken(plateNumber, excludeVehicleId);
  if (!taken) return;

  throw createHttpError(409, `Plate number ${plateNumber} is already registered.`);
};

/**
 * Confirms the report a vehicle is being dispatched to actually exists and is
 * still open.
 *
 * <p>A vehicle parked on a deleted report would show a collection nobody can
 * open, which is the exact dead end the 'Assigned requires a report' constraint
 * was written to prevent from the other side.
 */
const assertReportIsAssignable = async (reportId, queryable = pool) => {
  const report = await reportRepository.findByReportId(reportId, queryable);
  if (!report || report.is_deleted === true || report.is_archived === true) {
    throw createHttpError(404, 'Report not found.');
  }

  const status = String(report.status || '').trim().toLowerCase();
  if (status === 'completed' || status === 'denied') {
    throw createHttpError(409, 'That report is already closed.');
  }

  return report;
};

/**
 * GET /api/vehicles
 * The whole live fleet, with the summary counts the cards show.
 *
 * <p>Counts ride along with the list because the cards and the rows are read
 * together every time the screen polls, and two reads could otherwise disagree
 * about what the fleet looked like.
 */
const listVehicles = async (req, res, next) => {
  try {
    requireAdminActor(req);
    const status = normalizeVehicleFilter(req.query.status);

    const [vehicles, counts] = await Promise.all([
      vehicleRepository.findAll({ status }),
      vehicleRepository.findStatusCounts(),
    ]);

    res.json({
      vehicles,
      counts,
      filter: status || 'All',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/vehicles/status-counts
 * The three card numbers on their own, for a pull-to-refresh that only needs the
 * totals.
 */
const getVehicleCounts = async (req, res, next) => {
  try {
    requireAdminActor(req);
    res.json(await vehicleRepository.findStatusCounts());
  } catch (error) {
    next(error);
  }
};

/** GET /api/vehicles/:vehicleId */
const getVehicle = async (req, res, next) => {
  try {
    requireAdminActor(req);
    const vehicleId = normalizeVehicleId(req.params.vehicleId);
    const vehicle = await vehicleRepository.findByVehicleId(vehicleId);

    if (!vehicle) throw createHttpError(404, 'Vehicle not found.');
    res.json(vehicle);
  } catch (error) {
    next(error);
  }
};

/** GET /api/vehicles/:vehicleId/task-counts */
const getVehicleTaskCounts = async (req, res, next) => {
  try {
    requireAdminActor(req);
    const vehicleId = normalizeVehicleId(req.params.vehicleId);
    const vehicle = await vehicleRepository.findByVehicleId(vehicleId);
    if (!vehicle) throw createHttpError(404, 'Vehicle not found.');

    const counts = await vehicleRepository.getTaskCountsByVehicleId(vehicleId);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, counts });
  } catch (error) {
    next(error);
  }
};

/** GET /api/vehicles/:vehicleId/task-history */
const getVehicleTaskHistory = async (req, res, next) => {
  try {
    requireAdminActor(req);
    const vehicleId = normalizeVehicleId(req.params.vehicleId);
    const vehicle = await vehicleRepository.findByVehicleId(vehicleId);
    if (!vehicle) throw createHttpError(404, 'Vehicle not found.');

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const result = await vehicleRepository.findTaskHistoryByVehicleId(vehicleId, {
      limit,
      offset: (page - 1) * limit,
    });
    const revisionRequested = await historyRepository.findRevisionRequestedReportIds(
      result.reports.map((report) => report.report_id)
    );
    const timelines = await historyRepository.findTaskTimelinesByReportIds(
      result.reports.map((report) => report.report_id)
    );
    const reports = result.reports.map((report) => ({
      ...mapReport({
        ...report,
        revision_requested: revisionRequested.has(report.report_id),
      }),
      personnelNote: report.personnel_note || '',
      // Same per-task timeline the personnel history renders. The vehicle log
      // shows the work this truck was sent on, not the truck's own movements.
      timeline: timelines.get(report.report_id) || [],
    }));
    await reportPhotoService.attachPhotoLists(reports);

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      reports,
      count: reports.length,
      pagination: {
        page,
        limit,
        total: result.total,
        totalPages: Math.ceil(result.total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

/** POST /api/vehicles */
const addVehicle = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const payload = validateCreateVehiclePayload(req.body);

    await assertPlateAvailable(payload.plateNumber);

    const vehicleId = await vehicleRepository.createVehicle(payload, adminId);
    if (!vehicleId) throw createHttpError(500, 'Vehicle could not be created.');

    const vehicle = await vehicleRepository.findByVehicleId(vehicleId);
    res.status(201).json(vehicle);
  } catch (error) {
    // The unique index is the real guarantee against two registrations racing
    // for the same plate between the check above and the insert.
    if (error.code === '23505') {
      return next(createHttpError(409, 'That plate number is already registered.'));
    }
    next(error);
  }
};

/** PATCH /api/vehicles/:vehicleId */
const editVehicle = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const vehicleId = normalizeVehicleId(req.params.vehicleId);
    const updates = validateUpdateVehiclePayload(req.body);

    const existing = await vehicleRepository.findByVehicleId(vehicleId);
    if (!existing) throw createHttpError(404, 'Vehicle not found.');

    if (updates.plateNumber) {
      await assertPlateAvailable(updates.plateNumber, vehicleId);
    }

    if (updates.currentReportId) {
      await assertReportIsAssignable(updates.currentReportId);
    }

    // Moving off a collection has to free the vehicles that were on it, or they
    // would keep reporting an assignment that is no longer live.
    const wasAssigned = existing.status === VEHICLE_STATUSES.ASSIGNED;
    const nowUnassigned = updates.status
      && updates.status !== VEHICLE_STATUSES.ASSIGNED;

    const updatedId = await vehicleRepository.updateVehicle(vehicleId, updates, adminId);
    if (!updatedId) throw createHttpError(404, 'Vehicle not found.');

    if (wasAssigned && nowUnassigned && existing.currentReportId) {
      await releaseVehiclesOnReport(existing.currentReportId, vehicleId);
    }

    res.json(await vehicleRepository.findByVehicleId(vehicleId));
  } catch (error) {
    if (error.code === '23505') {
      return next(createHttpError(409, 'That plate number is already registered.'));
    }
    next(error);
  }
};

/**
 * PATCH /api/vehicles/:vehicleId/service
 * Records that the vehicle has been serviced.
 */
const recordVehicleService = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const vehicleId = normalizeVehicleId(req.params.vehicleId);

    const servicedAt = req.body?.servicedAt || req.body?.serviced_at || null;
    if (servicedAt !== null && Number.isNaN(Date.parse(servicedAt))) {
      throw createHttpError(400, 'servicedAt must be a date.');
    }

    const updatedId = await vehicleRepository.recordService(vehicleId, servicedAt, adminId);
    if (!updatedId) throw createHttpError(404, 'Vehicle not found.');

    res.json(await vehicleRepository.findByVehicleId(vehicleId));
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/vehicles/:vehicleId */
const removeVehicle = async (req, res, next) => {
  try {
    const adminId = requireAdminActor(req);
    const vehicleId = normalizeVehicleId(req.params.vehicleId);

    const existing = await vehicleRepository.findByVehicleId(vehicleId);
    if (!existing) throw createHttpError(404, 'Vehicle not found.');

    const removedId = await vehicleRepository.softDeleteVehicle(vehicleId, adminId);
    if (!removedId) throw createHttpError(404, 'Vehicle not found.');

    if (existing.currentReportId) {
      await releaseVehiclesOnReport(existing.currentReportId, vehicleId);
    }

    res.json({ success: true, vehicleId: removedId });
  } catch (error) {
    next(error);
  }
};

/**
 * Frees every other vehicle on a report that just stopped being a collection.
 *
 * <p>Called when a vehicle leaves a collection on its own. Without it the other
 * trucks would keep an assignment to a report that is now closed or deleted, and
 * the fleet screen would show a collection that cannot be opened.
 */
const releaseVehiclesOnReport = async (reportId, exceptVehicleId = null) => {
  const vehicles = await vehicleRepository.findByCurrentReport(reportId);
  const others = vehicles.filter((vehicle) => vehicle.vehicleId !== exceptVehicleId);

  for (const vehicle of others) {
    await vehicleRepository.updateVehicle(
      vehicle.vehicleId,
      { status: VEHICLE_STATUSES.AVAILABLE },
      null
    );
  }

  return others.map((vehicle) => vehicle.vehicleId);
};

module.exports = {
  addVehicle,
  editVehicle,
  getVehicle,
  getVehicleTaskCounts,
  getVehicleTaskHistory,
  getVehicleCounts,
  listVehicles,
  recordVehicleService,
  removeVehicle,
  releaseVehiclesOnReport,
};

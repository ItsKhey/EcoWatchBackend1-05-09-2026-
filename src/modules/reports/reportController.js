const reportRepository = require('./reportRepository');
const archivedReportRepository = require('./archivedReportRepository');
const trashReportRepository = require('./trashReportRepository');
const historyRepository = require('../history/historyRepository');
const personnelRepository = require('../personnel/personnelRepository');
const personnelAssignmentRepository =
  require('../personnel/personnelAssignmentRepository');
const cleaningTeamRepository = require('../personnel/cleaningTeamRepository');
const clusterRepository = require('./clusterRepository');
const reportPhotoRepository = require('./reportPhotoRepository');
const reportPhotoService = require('./reportPhotoService');
const { withTransaction } = require('../../config/db');
const { generateReportId } = require('../../shared/generateId');
const { uploadImage, destroyImage } = require('../../shared/cloudinaryService');
const {
  releaseReportAssignment,
} = require('./reportAssignmentService');
const notificationService = require('../notifications/notificationService');
const {
  DEFAULT_WASTE_SCALE,
  normalizeWasteScale,
} = require('../../shared/wasteScaleValidation');
const { logInfo, logError } = require('../../shared/logger');

const normalizeAssignedPersonnelIds = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch (error) {
    // Fall through for the comma-separated legacy representation.
  }

  return value.split(',').map((id) => id.trim()).filter(Boolean);
};

const normalizeReport = (report, sourceCollection = 'reports') => {
  if (!report) return null;

  return {
    reportId: report.report_id,
    residentId: report.resident_id,
    title: report.title,
    category: report.category,
    description: report.description,
    latitude: report.latitude,
    longitude: report.longitude,
    imageUrl: report.image_url,
    clusterId: report.cluster_id || null,
    status: report.status,
    adminResponse: report.admin_response || '',
    // `personnel_note` is deliberately absent. It is the administrator's
    // working channel for the cleaner (assignment instructions, revision
    // reasons) and must never appear in a resident-facing payload. The
    // cleaner's own completion notes reach the resident separately, as
    // `personnelResponse`.
    assignedPersonnelIds: normalizeAssignedPersonnelIds(report.assigned_personnel_ids),
    assignedPersonnelId: report.assigned_personnel_id || null,
    assignedByAdminId: report.assigned_by_admin_id || null,
    assignedAt: report.assigned_at || null,
    priority: report.priority,
    // How big the reported waste is. It is the resident's own label for the
    // problem and it decides what the administrator sends to the site.
    wasteScale: report.waste_scale || DEFAULT_WASTE_SCALE,
    assignedTeamId: report.assigned_team_id || null,
    assignedTeamName: report.assigned_team_name || null,
    assignedVehicleId: report.assigned_vehicle_id || null,
    assignedVehiclePlateNumber: report.assigned_vehicle_plate_number || null,
    assignedVehicleType: report.assigned_vehicle_type || null,
    isDeleted: sourceCollection === 'trash_reports' || report.is_deleted === true,
    deletedAt: report.deleted_at || null,
    isArchived: sourceCollection === 'archived_reports',
    isRestored: report.is_restored || false,
    createdAt: report.created_at || report.report_created_at,
    updatedAt: report.updated_at || report.report_updated_at,
    handledById: report.handled_by_id || null,
    resolutionImageUrl: report.resolution_image_url || null,
    resolvedAt: report.resolved_at || null,
    sourceCollection,
  };
};

/**
 * Adds the per-report photo list to normalized reports.
 *
 * <p>The `imageUrl` field is only the cover photo, so a multi-photo report
 * cannot be fully rendered from it. This resolves the `report_photos` rows in
 * one batched query and exposes them as `photos`.
 *
 * <p>A failure to read the photo rows must never fail the report itself, so any
 * error degrades to the cover image only.
 */
const attachPhotoLists = (normalizedReports) =>
  reportPhotoService.attachPhotoLists(normalizedReports);

/**
 * Adds the cleaner's completion note to each report as `personnelResponse`.
 *
 * The resident filed the report, so what the crew actually did is reassurance
 * they are entitled to, and it is the one personnel-side message that is
 * deliberately shared. It is read from `personnel_assignments`, not from the
 * report row: `reports.personnel_note` holds the administrator's internal
 * instructions to the cleaner and must never appear in a resident payload, which
 * is why this is a separate lookup rather than another normalized column.
 *
 * One batched query covers the whole list, and a failure degrades to "no note
 * shown" rather than failing the list the resident is trying to read.
 */
const attachPersonnelResponses = async (normalizedReports) => {
  if (!Array.isArray(normalizedReports) || normalizedReports.length === 0) {
    return normalizedReports;
  }

  let notesByReportId;
  try {
    notesByReportId = await personnelAssignmentRepository
      .findLatestCompletionNotesByReportIds(
        normalizedReports.map((report) => report?.reportId)
      );
  } catch (error) {
    logError(
      null,
      'PERSONNEL_RESPONSE',
      `Unable to read personnel completion notes: ${error.message}`
    );
    return normalizedReports.map((report) => ({ ...report, personnelResponse: null }));
  }

  return normalizedReports.map((report) => ({
    ...report,
    personnelResponse: report?.reportId
      ? notesByReportId.get(report.reportId) || null
      : null,
  }));
};

/**
 * Adds the crew and the collection vehicle that were dispatched for each report.
 *
 * <p>A resident is entitled to know who turned out and what they brought: a
 * Medium-Scale Waste is cleared by a crew, and a Large-Scale Waste by a crew
 * with a truck. The report row only carries the ids, and the resident should
 * not have to learn a team id, so the names are resolved here.
 *
 * <p>The lookup is batched across the whole list, so a resident with many
 * reports still costs one query per kind rather than one per report. A failure
 * degrades to "no crew shown" instead of failing the list the resident is
 * trying to read.
 */
const attachDispatchDetails = async (normalizedReports) => {
  if (!Array.isArray(normalizedReports) || normalizedReports.length === 0) {
    return normalizedReports;
  }

  let resolved;
  try {
    resolved = await cleaningTeamRepository.resolveTeamAndVehicle({
      teamIds: normalizedReports.map((report) => report?.assignedTeamId),
      vehicleIds: normalizedReports.map((report) => report?.assignedVehicleId),
    });
  } catch (error) {
    logError(
      null,
      'DISPATCH_DETAILS',
      `Unable to read the dispatched team and vehicle: ${error.message}`
    );
    return normalizedReports.map((report) => ({
      ...report,
      assignedTeamName: null,
      assignedVehiclePlateNumber: null,
      assignedVehicleType: null,
    }));
  }

  return normalizedReports.map((report) => {
    const team = report?.assignedTeamId
      ? resolved.teams.get(report.assignedTeamId)
      : null;
    const vehicle = report?.assignedVehicleId
      ? resolved.vehicles.get(report.assignedVehicleId)
      : null;

    return {
      ...report,
      assignedTeamName: team?.team_name || null,
      assignedVehiclePlateNumber: vehicle?.plate_number || null,
      assignedVehicleType: vehicle?.vehicle_type || null,
    };
  });
};

/**
 * The identity of one crew member, as a resident is allowed to see it.
 *
 * <p>Only the identity travels: a name, a picture and the truck the person is
 * normally assigned to. Nothing about the account itself, its status or the
 * other jobs it has, and no internal identifier beyond the one the report
 * already carried.
 */
const toResidentCrewMember = (member) => ({
  personnelId: member?.personnelId || null,
  fullName: member?.fullName || null,
  profileImage: member?.profileImage || null,
  assignedVehiclePlateNumber: member?.assignedVehiclePlateNumber || null,
});

/**
 * Adds the people who turned out for each report as `assignedCrew`.
 *
 * <p>A Medium- or Large-Scale Waste is cleared by a team, and the resident
 * filed the report, so who came is part of what happened to it. The report
 * row only carries the identifiers; the names are resolved here.
 *
 * <p>The ids the report carries are authoritative -- they are the people who
 * actually went out, whether they came from a saved team or were picked ad
 * hoc. The team's own membership is the fallback for a report whose ids were
 * never filled in.
 *
 * <p>The lookup is batched across the whole list, and a failure degrades to
 * "no crew shown" rather than failing the list the resident is trying to
 * read.
 */
const attachDispatchCrew = async (normalizedReports) => {
  if (!Array.isArray(normalizedReports) || normalizedReports.length === 0) {
    return normalizedReports;
  }

  let resolved;
  try {
    resolved = await cleaningTeamRepository.resolveDispatchCrews({
      teamIds: normalizedReports.map((report) => report?.assignedTeamId),
      personnelIds: normalizedReports.flatMap(
        (report) => report?.assignedPersonnelIds || []
      ),
    });
  } catch (error) {
    logError(
      null,
      'DISPATCH_CREW',
      `Unable to read the dispatched crew: ${error.message}`
    );
    return normalizedReports.map((report) => ({ ...report, assignedCrew: [] }));
  }

  return normalizedReports.map((report) => {
    const assignedIds = Array.isArray(report?.assignedPersonnelIds)
      ? report.assignedPersonnelIds
      : [];

    let crew = assignedIds
      .map((id) => resolved.membersByPersonnelId.get(String(id).trim().toUpperCase()))
      .filter(Boolean);

    if (!crew.length && report?.assignedTeamId) {
      crew = resolved.membersByTeamId.get(report.assignedTeamId) || [];
    }

    return { ...report, assignedCrew: crew.map(toResidentCrewMember) };
  });
};

/**
 * Everything a resident-facing report needs beyond its own columns: the photo
 * list, the cleaner's completion note, and the crew and vehicle that were
 * dispatched. Kept as one entry point so a new resident endpoint cannot
 * accidentally return one and forget the others.
 */
const attachResidentReportDetails = async (normalizedReports) => {
  const withPhotos = await attachPhotoLists(normalizedReports);
  const withNotes = await attachPersonnelResponses(withPhotos);
  const withDispatch = await attachDispatchDetails(withNotes);
  return attachDispatchCrew(withDispatch);
};

const logHistory = async (data) => {
  try {
    await historyRepository.createHistory(data);
    return true;
  } catch (error) {
    logError(null, 'HISTORY', `Failed to log history: ${error.message}`);
    return false;
  }
};

const findReportInAnyCollection = async (reportId, residentId) => {
  const report = await reportRepository.findByReportId(reportId);

  if (report && report.resident_id === residentId) {
    if (!report.is_deleted && !report.is_archived) {
      return { report, source: 'reports' };
    }

    if (report.is_deleted) {
      const trash = await trashReportRepository.findByReportId(report.report_id);
      if (trash) return { report, source: 'trash_reports' };
    }
  }

  const archived = await archivedReportRepository.findByReportId(reportId);
  if (archived && archived.resident_id === residentId) {
    return { report: archived, source: 'archived_reports' };
  }

  return null;
};

const releaseAssignmentBeforeLifecycleMove = async (found) => {
  if (!found?.report) return;

  if (found.source === 'archived_reports') {
    // Archived rows do not have the active reports foreign key, so clear any
    // stale personnel pointer and assignment metadata before the row is
    // restored, archived again, or deleted.
    await personnelRepository.clearCurrentAssignmentsForReport(
      found.report.report_id,
      null
    );
    await archivedReportRepository.updateByReportId(
      found.report.report_id,
      {
        assignedPersonnelIds: [],
        assignedPersonnelId: null,
        handledById: null,
        status: String(found.report.status || '').trim().toLowerCase() === 'in progress'
          ? 'Pending' : (found.report.status || 'Pending'),
      }
    );
    return;
  }

  await releaseReportAssignment({
    reportId: found.report.report_id,
  });
};

const reportInput = (report, overrides = {}) => ({
  reportId: report.report_id,
  residentId: report.resident_id,
  title: report.title,
  category: report.category,
  description: report.description,
  latitude: report.latitude,
  longitude: report.longitude,
  imageUrl: report.image_url,
  status: String(report.status || '').trim().toLowerCase() === 'in progress'
    ? 'Pending' : (report.status || 'Pending'),
  adminResponse: report.admin_response || '',
  // Carried so a report keeps its administrator<->personnel note when it moves
  // between the active and archived collections, exactly as admin_response is.
  personnelResponse: report.personnel_note || null,
  // Lifecycle moves release the active assignment. Keep the last admin/timestamp
  // audit fields, but never carry an actionable personnel pointer into a new
  // collection row.
  assignedPersonnelIds: [],
  assignedPersonnelId: null,
  assignedByAdminId: report.assigned_by_admin_id || null,
  assignedAt: report.assigned_at || null,
  priority: report.priority || 'Normal',
  // The scale is the resident's own label for the problem, so it travels with
  // the report between collections. The crew and the truck do not: a lifecycle
  // move releases the assignment, and so does the dispatch.
  wasteScale: report.waste_scale || DEFAULT_WASTE_SCALE,
  assignedTeamId: null,
  assignedVehicleId: null,
  isDeleted: false,
  deletedAt: null,
  isArchived: false,
  isRestored: true,
  handledById: null,
  resolutionImageUrl: report.resolution_image_url || null,
  resolvedAt: report.resolved_at || null,
  ...overrides,
});

const CLIENT_REPORT_ID_PATTERN = /^REP-[A-Z0-9]{8,32}$/i;
const CLUSTER_RADIUS_METERS = 10;
const ACTIVE_CLUSTER_STATUSES = ['Pending', 'In Progress'];
const DOUBLE_TAP_WINDOW_MS = 5000; // 5 seconds

/**
 * In-memory submission fingerprint store for double-tap protection.
 * Maps residentId -> { fingerprint, timestamp }
 * Entries expire after DOUBLE_TAP_WINDOW_MS.
 */
const submissionFingerprints = new Map();

/**
 * Cleans up expired entries from the fingerprint store.
 */
const cleanupExpiredFingerprints = () => {
  const now = Date.now();
  for (const [key, value] of submissionFingerprints.entries()) {
    if (now - value.timestamp > DOUBLE_TAP_WINDOW_MS) {
      submissionFingerprints.delete(key);
    }
  }
};

/**
 * Creates a submission fingerprint from resident ID and coordinates.
 * Returns null if coordinates are missing.
 */
const createSubmissionFingerprint = (residentId, latitude, longitude) => {
  if (latitude === undefined || longitude === undefined) return null;
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  // Round to 5 decimal places (~1 meter precision) for fingerprint stability
  const latRounded = Math.round(lat * 100000) / 100000;
  const lngRounded = Math.round(lng * 100000) / 100000;
  return `${residentId}:${latRounded}:${lngRounded}`;
};

/**
 * Checks if this is a duplicate submission within the cooldown window.
 * Returns true if duplicate, false if allowed.
 */
const isDuplicateSubmission = (fingerprint) => {
  if (!fingerprint) return false;
  cleanupExpiredFingerprints();
  const existing = submissionFingerprints.get(fingerprint);
  if (!existing) return false;
  return (Date.now() - existing.timestamp) < DOUBLE_TAP_WINDOW_MS;
};

/**
 * Records a submission fingerprint.
 */
const recordSubmission = (fingerprint) => {
  if (!fingerprint) return;
  submissionFingerprints.set(fingerprint, {
    fingerprint,
    timestamp: Date.now(),
  });
};

/**
 * Uploads multiple photo buffers to Cloudinary sequentially, preserving order.
 * Returns an array of secure URLs.
 */
const uploadPhotosInOrder = async (files) => {
  const urls = [];
  for (const file of files) {
    const result = await uploadImage(file.buffer, 'ecowatch/reports');
    urls.push(result.secure_url);
  }
  return urls;
};

const createReport = async (req, res, next) => {
  const { title, description, latitude, longitude } = req.body;
  const category = req.body.category || req.body.waste_type || req.body.wasteType || '';
  const requestedReportId = typeof req.body.report_id === 'string'
    ? req.body.report_id.trim()
    : '';
  const clientReportId = CLIENT_REPORT_ID_PATTERN.test(requestedReportId)
    ? requestedReportId
    : null;
  const continueInCluster = req.body.continue_in_cluster === true
    || req.body.continue_in_cluster === 'true';

  // How big the waste is. The resident picks this on the create-report form and
  // it is the label the administrator dispatches against. A report filed
  // without one is treated as Small-Scale Waste, the only way it could have
  // been handled before.
  const wasteScale = normalizeWasteScale(
    req.body.waste_scale ?? req.body.wasteScale ?? null
  ) || DEFAULT_WASTE_SCALE;

  // Support both single (legacy) and multiple photo uploads
  const files = req.files || (req.file ? [req.file] : []);

  try {
    const residentId = req.resident.residentId || req.resident.resident_id;
    logInfo(req.requestId, 'REPORT', `New report submission from resident: ${residentId}`);

    if (!residentId) {
      res.status(401);
      throw new Error('Authenticated resident identity is missing');
    }
    if (String(req.resident.role || '').toUpperCase() !== 'RESIDENT') {
      res.status(403);
      throw new Error('Only resident accounts can submit reports');
    }
    if (!title || !String(title).trim()) {
      res.status(400);
      throw new Error('Report title is required');
    }
    if (!category || !String(category).trim()) {
      res.status(400);
      throw new Error('Report category is required');
    }
    if (files.length === 0) {
      res.status(400);
      throw new Error('Please upload at least one photo');
    }

    // A client retry may reuse its provisional report ID. Check for an
    // already-created report before uploading another image so an ambiguous
    // network failure cannot create duplicate production reports.
    if (clientReportId) {
      const existing = await findReportInAnyCollection(clientReportId, residentId);
      if (existing) {
        logInfo(req.requestId, 'REPORT', `Idempotent replay accepted: ${clientReportId}`);
        return res.status(200).json(normalizeReport(existing.report, existing.source));
      }

      const [activeWithSameId, archivedWithSameId, trashWithSameId] = await Promise.all([
        reportRepository.findByReportId(clientReportId),
        archivedReportRepository.findByReportId(clientReportId),
        trashReportRepository.findByReportId(clientReportId),
      ]);
      const conflictingReport = [activeWithSameId, archivedWithSameId, trashWithSameId]
        .find((candidate) => candidate && candidate.resident_id !== residentId);
      if (conflictingReport) {
        res.status(409);
        throw new Error('Report identifier is already in use');
      }
    }

    const hasCoordinates = latitude !== undefined && latitude !== ''
      && longitude !== undefined && longitude !== ''
      && !Number.isNaN(Number(latitude)) && !Number.isNaN(Number(longitude));

    // Double-tap protection: check for duplicate submission within cooldown window
    const fingerprint = createSubmissionFingerprint(residentId, latitude, longitude);
    if (isDuplicateSubmission(fingerprint)) {
      logInfo(req.requestId, 'REPORT', `Duplicate submission blocked for resident: ${residentId}`);
      return res.status(429).json({
        status: 'duplicate_submission',
        message: 'Your previous submission is still being processed.',
      });
    }

    // Check for nearby active cluster when coordinates are present
    let nearbyCluster = null;
    if (hasCoordinates) {
      nearbyCluster = await clusterRepository.getNearbyClusterWithPreview(
        Number(latitude),
        Number(longitude),
        CLUSTER_RADIUS_METERS
      );

      // If a nearby cluster exists and the resident hasn't confirmed they want
      // to continue, return the cluster info so the app can show a dialog.
      if (nearbyCluster && !continueInCluster) {
        logInfo(req.requestId, 'CLUSTER', `Nearby cluster found: ${nearbyCluster.clusterId} at ${nearbyCluster.distance}m`);
        return res.status(200).json({
          status: 'existing_cluster',
          clusterId: nearbyCluster.clusterId,
          distance: nearbyCluster.distance,
          // The location row's status is kept for older clients. New clients
          // read reportStatus, which describes the open reports themselves
          // rather than the location row that never advances past Pending.
          clusterStatus: nearbyCluster.status,
          reportStatus: nearbyCluster.reportStatus,
          reportCount: nearbyCluster.reportCount,
          spotCount: nearbyCluster.spotCount,
          previewPhoto: nearbyCluster.previewPhoto,
          previewReportId: nearbyCluster.previewReportId,
          lastActivityAt: nearbyCluster.lastActivityAt,
        });
      }
    }

    logInfo(req.requestId, 'REPORT', `Report fields received: clientReportId=${clientReportId || 'none'} photoCount=${files.length} clusterId=${nearbyCluster?.clusterId || 'none'}`);

    // Upload all photos to Cloudinary
    const photoUrls = await uploadPhotosInOrder(files);

    // Use existing cluster or create a new one
    let clusterId = nearbyCluster?.clusterId || null;
    let isNewCluster = false;

    const report = await withTransaction(async (client) => {
      // Double-check for existing cluster inside the transaction (race condition protection)
      if (hasCoordinates && !clusterId) {
        const existingCluster = await clusterRepository.findNearbyActiveCluster(
          Number(latitude),
          Number(longitude),
          CLUSTER_RADIUS_METERS,
          client
        );
        if (existingCluster) {
          clusterId = existingCluster.clusterId;
        }
      }

      // Create new cluster if none exists
      if (!clusterId && hasCoordinates) {
        const newCluster = await clusterRepository.createCluster(
          Number(latitude),
          Number(longitude),
          client
        );
        clusterId = newCluster.cluster_id;
        isNewCluster = true;
      }

      // Create the report
      const newReport = await reportRepository.createReport({
        reportId: clientReportId || generateReportId(),
        residentId,
        title,
        category,
        description,
        latitude: hasCoordinates ? Number(latitude) : null,
        longitude: hasCoordinates ? Number(longitude) : null,
        imageUrl: photoUrls[0] || null,
        clusterId,
        wasteScale,
      }, client);

      // Create photo records for all uploaded photos
      if (photoUrls.length > 0) {
        await reportPhotoRepository.createPhotos(newReport.report_id, photoUrls, client);
      }

      // Update cluster activity timestamp
      if (clusterId) {
        await clusterRepository.touchClusterActivity(clusterId, client);
      }

      return newReport;
    });

    // Record submission fingerprint after successful creation (outside transaction)
    recordSubmission(fingerprint);

    logInfo(req.requestId, 'DATABASE', `Report created: ${report.report_id} in cluster: ${clusterId || 'none'}`);
    const historyLogged = await logHistory({
      residentId: report.resident_id,
      reportId: report.report_id,
      action: 'SUBMITTED',
      newStatus: report.status,
      description: `Report '${title}' was submitted.`,
    });
    if (!historyLogged) {
      logError(req.requestId, 'REPORT', `Report ${report.report_id} was created but submission history could not be written`);
    }

    // Phase 3A: notify administrators. The report is already committed, so a
    // notification or push failure must never fail the resident's submission.
    try {
      await notificationService.createForAdminReportEvent({
        reportId: report.report_id,
        type: notificationService.NOTIFICATION_TYPES.NEW_REPORT,
        report,
        requestId: req.requestId,
      });
    } catch (error) {
      logError(
        req.requestId,
        'NEW_REPORT',
        `Report ${report.report_id} was created but the administrator notification failed: ${error.message}`
      );
    }

    const responseStatus = isNewCluster ? 'new_cluster' : 'report_created';

    const [createdReport] = await attachResidentReportDetails([normalizeReport(report)]);

    return res.status(201).json({
      status: responseStatus,
      clusterId,
      reportId: report.report_id,
      ...createdReport,
    });
  } catch (error) {
    logError(req.requestId, 'REPORT_CREATE', `submission failed status=${res.statusCode} code=${error.code || error.name || 'Error'} message=${error.message}`);
    return next(error);
  }
};

const getMyReports = async (req, res, next) => {
  try {
    const residentId = req.resident.residentId;
    const [reports, archivedReports, trashReports] = await Promise.all([
      reportRepository.findByResidentId(residentId),
      archivedReportRepository.findByResidentId(residentId),
      trashReportRepository.findByResidentId(residentId),
    ]);

    const normalizedReports = await attachResidentReportDetails([
      ...reports
        .filter((report) => !report.is_deleted && !report.is_archived)
        .map((report) => normalizeReport(report)),
      ...archivedReports.map((report) => normalizeReport(report, 'archived_reports')),
      ...trashReports.map((report) => normalizeReport(report, 'trash_reports')),
    ]);

    normalizedReports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(normalizedReports);
  } catch (error) {
    next(error);
  }
};

const softDeleteReport = async (req, res, next) => {
  try {
    const found = await findReportInAnyCollection(req.params.id, req.resident.residentId);
    if (!found) {
      res.status(404);
      throw new Error('Report not found');
    }

    await releaseAssignmentBeforeLifecycleMove(found);

    if (found.source === 'trash_reports') {
      return res.json(normalizeReport(found.report, 'trash_reports'));
    }

    let report = found.report;
    if (found.source === 'archived_reports') {
      report = await reportRepository.createReport(reportInput(found.report));
      await archivedReportRepository.deleteByReportId(found.report.report_id);
    }

    const updatedReport = await reportRepository.updateReport(report.report_id, {
      isDeleted: true,
      deletedAt: new Date(),
      isArchived: false,
    });

    await trashReportRepository.createTrashRecord({
      reportId: report.report_id,
      residentId: report.resident_id,
      deletedAt: new Date(),
    });

    await logHistory({
      residentId: report.resident_id,
      reportId: report.report_id,
      action: 'MOVED_TO_TRASH',
      description: `Report '${report.title}' moved to trash.`,
    });

    res.json(normalizeReport(updatedReport, 'trash_reports'));
  } catch (error) {
    next(error);
  }
};

const restoreReport = async (req, res, next) => {
  try {
    const found = await findReportInAnyCollection(req.params.id, req.resident.residentId);
    if (!found) {
      res.status(404);
      throw new Error('Report not found');
    }

    await releaseAssignmentBeforeLifecycleMove(found);

    if (found.source === 'reports') {
      return res.json(normalizeReport(found.report));
    }

    let restoredReport;
    if (found.source === 'trash_reports') {
      restoredReport = await reportRepository.updateReport(found.report.report_id, {
        isDeleted: false,
        deletedAt: null,
        isArchived: false,
        isRestored: true,
      });
      await trashReportRepository.deleteByReportId(found.report.report_id);
    } else {
      restoredReport = await reportRepository.createReport(reportInput(found.report));
      await archivedReportRepository.deleteByReportId(found.report.report_id);
    }

    await logHistory({
      residentId: restoredReport.resident_id,
      reportId: restoredReport.report_id,
      action: 'RESTORED',
      description: `Report '${restoredReport.title}' restored to inbox.`,
    });

    res.json(normalizeReport(restoredReport));
  } catch (error) {
    next(error);
  }
};

const archiveReport = async (req, res, next) => {
  try {
    const found = await findReportInAnyCollection(req.params.id, req.resident.residentId);
    if (!found) {
      res.status(404);
      throw new Error('Report not found');
    }

    await releaseAssignmentBeforeLifecycleMove(found);

    if (found.source === 'archived_reports') {
      return res.json(normalizeReport(found.report, 'archived_reports'));
    }

    let report = found.report;
    if (found.source === 'trash_reports') {
      await trashReportRepository.deleteByReportId(report.report_id);
      report = await reportRepository.updateReport(report.report_id, {
        isDeleted: false,
        deletedAt: null,
      });
    }

    const archivedReport = await archivedReportRepository.createArchivedReport(reportInput(report));
    await reportRepository.deleteByReportId(report.report_id);

    await logHistory({
      residentId: report.resident_id,
      reportId: report.report_id,
      action: 'ARCHIVED',
      description: `Report '${report.title}' moved to archive.`,
    });

    res.json(normalizeReport(archivedReport, 'archived_reports'));
  } catch (error) {
    next(error);
  }
};

const bulkMoveReportsHandler = (targetCollection) => async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body) ? req.body : (req.body?.ids || []);
    let modifiedCount = 0;

    for (const id of ids) {
      const found = await findReportInAnyCollection(id, req.resident.residentId);
      if (!found) continue;
      await releaseAssignmentBeforeLifecycleMove(found);
      if (found.source === targetCollection) continue;

      const report = found.report;
      if (targetCollection === 'trash_reports') {
        let currentReport = report;
        if (found.source === 'archived_reports') {
          currentReport = await reportRepository.createReport(reportInput(report));
          await archivedReportRepository.deleteByReportId(report.report_id);
        }
        await reportRepository.updateReport(currentReport.report_id, {
          isDeleted: true,
          deletedAt: new Date(),
          isArchived: false,
        });
        await trashReportRepository.createTrashRecord({
          reportId: currentReport.report_id,
          residentId: currentReport.resident_id,
          deletedAt: new Date(),
        });
      } else if (targetCollection === 'reports') {
        if (found.source === 'trash_reports') {
          await reportRepository.updateReport(report.report_id, {
            isDeleted: false,
            deletedAt: null,
            isArchived: false,
            isRestored: true,
          });
          await trashReportRepository.deleteByReportId(report.report_id);
        } else {
          await reportRepository.createReport(reportInput(report));
          await archivedReportRepository.deleteByReportId(report.report_id);
        }
      } else {
        let currentReport = report;
        if (found.source === 'trash_reports') {
          await trashReportRepository.deleteByReportId(report.report_id);
          currentReport = await reportRepository.updateReport(report.report_id, {
            isDeleted: false,
            deletedAt: null,
          });
        }
        await archivedReportRepository.createArchivedReport(currentReport);
        await reportRepository.deleteByReportId(currentReport.report_id);
      }

      const action = targetCollection === 'archived_reports'
        ? 'ARCHIVED'
        : targetCollection === 'trash_reports'
          ? 'MOVED_TO_TRASH'
          : 'RESTORED';

      await logHistory({
        residentId: req.resident.residentId,
        reportId: report.report_id,
        action,
        description: `Report '${report.title}' ${action.toLowerCase()} (Bulk action).`,
      });
      modifiedCount++;
    }

    res.json({ message: `Moved ${modifiedCount} reports`, modifiedCount });
  } catch (error) {
    next(error);
  }
};

const bulkSoftDeleteReports = bulkMoveReportsHandler('trash_reports');
const bulkRestoreReports = bulkMoveReportsHandler('reports');
const bulkArchiveReports = bulkMoveReportsHandler('archived_reports');

const bulkDeleteReports = async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body) ? req.body : (req.body?.ids || []);
    let modifiedCount = 0;

    for (const id of ids) {
      const found = await findReportInAnyCollection(id, req.resident.residentId);
      if (!found) continue;
      await releaseAssignmentBeforeLifecycleMove(found);

      if (found.source === 'reports') {
        await reportRepository.permanentlyDeleteByReportId(found.report.report_id);
      } else if (found.source === 'trash_reports') {
        await trashReportRepository.deleteByReportId(found.report.report_id);
        await reportRepository.permanentlyDeleteByReportId(found.report.report_id);
      } else {
        await reportRepository.releaseReportImage(found.report.report_id);
        await archivedReportRepository.deleteByReportId(found.report.report_id);
      }

      await logHistory({
        residentId: req.resident.residentId,
        reportId: found.report.report_id,
        action: 'PERMANENTLY_DELETED',
        description: `Report '${found.report.title}' permanently removed via bulk delete.`,
      });
      modifiedCount++;
    }

    res.json({ message: `Permanently removed ${modifiedCount} reports`, modifiedCount });
  } catch (error) {
    next(error);
  }
};

/**
 * Resident-editable report fields, in the order they are reported back in the
 * "Updated" history entry.
 */
const RESIDENT_EDITABLE_FIELDS = Object.freeze([
  ['image', 'report photo'],
  ['title', 'report title'],
  ['category', 'waste type'],
  ['location', 'location'],
  ['description', 'description'],
  ['wasteScale', 'waste scale'],
]);

/** "photo" -> "photo and title"; used for a single grouped history entry. */
const joinEditFieldLabels = (labels) => {
  if (labels.length <= 1) return labels[0] || '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
};

/** Builds the grouped audit line, e.g. "Updated report photo and location." */
const describeResidentEdit = (changedFields) => {
  const labels = changedFields
    .map((field) => (RESIDENT_EDITABLE_FIELDS.find(([key]) => key === field) || [])[1])
    .filter(Boolean);
  if (!labels.length) return null;
  return `Updated ${joinEditFieldLabels(labels)}.`;
};

const isPresent = (value) => value !== undefined && value !== null;

/** True when the client sent at least one of the accepted aliases. */
const wasSent = (body, keys) => keys.some((key) => isPresent(body[key]));

/** Reads the first alias actually present, trimmed. */
const readTextField = (body, keys) => {
  for (const key of keys) {
    if (isPresent(body[key])) return String(body[key]).trim();
  }
  return null;
};

/**
 * Reads a coordinate, ignoring blank values so an omitted key keeps the stored
 * position while a real number replaces it.
 */
const readCoordinateField = (body, keys, fallback) => {
  for (const key of keys) {
    const raw = body[key];
    if (!isPresent(raw) || String(raw).trim() === '') continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const sameText = (left, right) =>
  String(left === null || left === undefined ? '' : left).trim()
    === String(right === null || right === undefined ? '' : right).trim();

/**
 * @desc    Update a report the authenticated resident owns
 * @route   PATCH /api/reports/:id
 * @access  Private
 *
 * Writes only the resident-editable fields (photo, title, waste type, location
 * and description) plus updated_at. report_id, resident_id and created_at are
 * never touched, and every applied change is recorded as a single grouped
 * "UPDATED" history entry written by the real backend.
 */
const updateReport = async (req, res, next) => {
  const residentId = req.resident.residentId || req.resident.resident_id;
  const body = req.body || {};

  try {
    const forbiddenAdminFields = [
      'status',
      'adminResponse',
      'admin_response',
      'assignedPersonnelId',
      'assigned_personnel_id',
      'assignedPersonnelIds',
      'assigned_personnel_ids',
    ].filter((field) => Object.prototype.hasOwnProperty.call(body, field));
    if (forbiddenAdminFields.length) {
      const error = new Error(
        `Report status and response are administrator-owned; remove: ${forbiddenAdminFields.join(', ')}.`
      );
      error.statusCode = 400;
      throw error;
    }

    const report = await reportRepository.findByReportId(req.params.id);
    if (!report || report.resident_id !== residentId || report.is_deleted || report.is_archived) {
      res.status(404);
      throw new Error('Report not found');
    }

    const updates = {};
    const changedFields = new Set();

    if (wasSent(body, ['title'])) {
      const title = readTextField(body, ['title']);
      if (!title) {
        res.status(400);
        throw new Error('Report title is required');
      }
      if (!sameText(report.title, title)) {
        updates.title = title;
        changedFields.add('title');
      }
    }

    if (wasSent(body, ['category', 'waste_type', 'wasteType'])) {
      const category = readTextField(body, ['category', 'waste_type', 'wasteType']);
      if (!category) {
        res.status(400);
        throw new Error('Report category is required');
      }
      if (!sameText(report.category, category)) {
        updates.category = category;
        changedFields.add('category');
      }
    }

    // The description is intentionally clearable: an empty submission is a
    // deliberate "no description" rather than "field not provided".
    if (wasSent(body, ['description'])) {
      const description = readTextField(body, ['description']) || '';
      if (!sameText(report.description, description)) {
        updates.description = description;
        changedFields.add('description');
      }
    }

    // The size of the waste is the resident's own call and can be corrected
    // while the report is still open. It is normalised onto the canonical
    // vocabulary, so a client that spells it differently still stores the same
    // label the dispatcher reads.
    if (wasSent(body, ['waste_scale', 'wasteScale'])) {
      const wasteScale = normalizeWasteScale(
        readTextField(body, ['waste_scale', 'wasteScale'])
      );
      const currentScale = report.waste_scale || DEFAULT_WASTE_SCALE;
      if (wasteScale && wasteScale !== currentScale) {
        // The scale is settled once a crew is on the job. The dispatch was made
        // under the label the report carried then, and that label is what the
        // administrator dispatches against -- so relabelling the report now
        // would leave the crew that went out contradicting the report, and
        // would lock the administrator out of sending a crew to it at all.
        const dispatched = Boolean(report.assigned_personnel_id)
          || (Array.isArray(report.assigned_personnel_ids)
            && report.assigned_personnel_ids.length > 0);
        if (dispatched) {
          res.status(400);
          throw new Error(
            'The waste scale cannot be changed once a cleanup crew has been assigned.'
          );
        }
        updates.wasteScale = wasteScale;
        changedFields.add('wasteScale');
      }
    }

    const latitude = readCoordinateField(body, ['latitude'], report.latitude);
    const longitude = readCoordinateField(body, ['longitude'], report.longitude);
    const currentLatitude = report.latitude === null || report.latitude === undefined
      ? report.latitude
      : Number(report.latitude);
    const currentLongitude = report.longitude === null || report.longitude === undefined
      ? report.longitude
      : Number(report.longitude);
    if (latitude !== currentLatitude || longitude !== currentLongitude) {
      updates.latitude = latitude;
      updates.longitude = longitude;
      changedFields.add('location');
    }

    // Upload before the row is written so a failed upload can never leave the
    // report pointing at an image that does not exist.
    let replacementImageUrl = null;
    if (req.file) {
      const uploaded = await uploadImage(req.file.buffer, 'ecowatch/reports');
      replacementImageUrl = uploaded.secure_url || null;
      if (replacementImageUrl && replacementImageUrl !== report.image_url) {
        updates.imageUrl = replacementImageUrl;
        changedFields.add('image');
      }
    }

    const orderedChangedFields = RESIDENT_EDITABLE_FIELDS
      .map(([key]) => key)
      .filter((key) => changedFields.has(key));

    if (orderedChangedFields.length === 0) {
      // Nothing actually changed, so leave updated_at and the audit trail
      // untouched instead of recording a no-op edit.
      const [unchangedReport] = await attachResidentReportDetails([normalizeReport(report)]);
      return res.json({
        ...unchangedReport,
        changedFields: [],
      });
    }

    // updateReport only writes the columns present in `updates` and always
    // refreshes updated_at, so report_id, resident_id and created_at are
    // preserved by construction.
    const updatedReport = await reportRepository.updateReport(report.report_id, updates);
    if (!updatedReport) {
      res.status(404);
      throw new Error('Report not found');
    }

    logInfo(
      req.requestId,
      'REPORT',
      `Report ${report.report_id} edited by resident ${residentId}: ${orderedChangedFields.join(', ')}`
    );

    // The row is committed and already references the replacement asset, so
    // removing the previous photo is a best-effort cleanup only.
    if (replacementImageUrl && report.image_url && report.image_url !== replacementImageUrl) {
      await destroyImage(report.image_url);
    }

    // oldStatus/newStatus stay null: an edit is not a status transition, and
    // recording the status here would double-count the report in the
    // Completed/Denied history filters.
    const historyLogged = await logHistory({
      residentId: report.resident_id,
      reportId: report.report_id,
      action: 'UPDATED',
      oldStatus: null,
      newStatus: null,
      description: describeResidentEdit(orderedChangedFields),
      timestamp: new Date(),
    });
    if (!historyLogged) {
      logError(
        req.requestId,
        'REPORT',
        `Report ${report.report_id} was updated but the edit history could not be written`
      );
    }

    const [editedReport] = await attachResidentReportDetails([normalizeReport(updatedReport)]);

    return res.json({
      ...editedReport,
      changedFields: orderedChangedFields,
    });
  } catch (error) {
    logError(
      req.requestId,
      'REPORT_UPDATE',
      `edit failed status=${res.statusCode} code=${error.code || error.name || 'Error'} message=${error.message}`
    );
    return next(error);
  }
};

/**
 * GET /api/reports/nearby-clusters
 * Returns active clusters near the given coordinates.
 * Used by the resident app to preview nearby waste areas before submitting.
 */
const getNearbyClusters = async (req, res, next) => {
  try {
    const { latitude, longitude, radius } = req.query;

    if (latitude === undefined || longitude === undefined) {
      res.status(400);
      throw new Error('Both latitude and longitude query parameters are required');
    }

    const lat = Number(latitude);
    const lng = Number(longitude);

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      res.status(400);
      throw new Error('Latitude and longitude must be valid numbers');
    }

    const radiusMeters = radius !== undefined ? Number(radius) : CLUSTER_RADIUS_METERS;
    if (Number.isNaN(radiusMeters) || radiusMeters <= 0) {
      res.status(400);
      throw new Error('Radius must be a positive number');
    }

    const clusters = await clusterRepository.findNearbyActiveClusters(lat, lng, radiusMeters);

    // Batch-fetch preview info for all clusters
    const clusterIds = clusters.map((c) => c.clusterId);
    const previewInfoMap = await clusterRepository.getClustersPreviewInfo(clusterIds);

    // Enrich each cluster with report count, spotCount, preview info, and activity
    const enrichedClusters = await Promise.all(
      clusters.map(async (cluster) => {
        const full = await clusterRepository.getClusterById(cluster.clusterId);
        const previewInfo = previewInfoMap[cluster.clusterId] || {};
        return {
          clusterId: cluster.clusterId,
          distance: cluster.distance,
          clusterStatus: cluster.status,
          reportCount: full?.reportCount || 0,
          spotCount: full?.spotCount || full?.reportCount || 0,
          previewPhoto: previewInfo.previewPhoto || null,
          previewReportId: previewInfo.previewReportId || null,
          lastActivityAt: full?.lastActivityAt || cluster.lastActivityAt,
        };
      })
    );

    res.json({
      clusters: enrichedClusters,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Helper: gets the most recent report ID in a cluster for preview purposes.
 */
const getFirstReportIdInCluster = async (clusterId) => {
  const { pool } = require('../../config/db');
  const result = await pool.query(
    'SELECT report_id FROM reports WHERE cluster_id = $1 AND is_deleted = false AND is_archived = false ORDER BY created_at DESC LIMIT 1',
    [clusterId]
  );
  return result.rows[0]?.report_id || null;
};

const deleteReport = async (req, res, next) => {
  try {
    const found = await findReportInAnyCollection(req.params.id, req.resident.residentId);
    if (!found) {
      res.status(404);
      throw new Error('Report not found');
    }

    await releaseAssignmentBeforeLifecycleMove(found);

    if (found.source === 'reports') {
      await reportRepository.permanentlyDeleteByReportId(found.report.report_id);
    } else if (found.source === 'trash_reports') {
      await trashReportRepository.deleteByReportId(found.report.report_id);
      await reportRepository.permanentlyDeleteByReportId(found.report.report_id);
    } else {
      await reportRepository.releaseReportImage(found.report.report_id);
      await archivedReportRepository.deleteByReportId(found.report.report_id);
    }

    await logHistory({
      residentId: req.resident.residentId,
      reportId: found.report.report_id,
      action: 'PERMANENTLY_DELETED',
      description: `Report '${found.report.title}' permanently deleted.`,
    });

    res.json({ message: 'Report permanently removed' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createReport,
  getMyReports,
  getNearbyClusters,
  updateReport,
  deleteReport,
  softDeleteReport,
  restoreReport,
  archiveReport,
  bulkSoftDeleteReports,
  bulkRestoreReports,
  bulkArchiveReports,
  bulkDeleteReports,
  attachPhotoLists,
};



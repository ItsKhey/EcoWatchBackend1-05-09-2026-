const reportRepository = require('../repositories/reportRepository');
const archivedReportRepository = require('../repositories/archivedReportRepository');
const trashReportRepository = require('../repositories/trashReportRepository');
const historyRepository = require('../repositories/historyRepository');
const { generateReportId } = require('../utils/generateId');
const { uploadImage } = require('../services/cloudinaryService');
const { logInfo, logError } = require('../utils/logger');

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
    status: report.status,
    adminResponse: report.admin_response || '',
    assignedPersonnelIds: report.assigned_personnel_ids || [],
    priority: report.priority,
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

const reportInput = (report, overrides = {}) => ({
  reportId: report.report_id,
  residentId: report.resident_id,
  title: report.title,
  category: report.category,
  description: report.description,
  latitude: report.latitude,
  longitude: report.longitude,
  imageUrl: report.image_url,
  status: report.status,
  adminResponse: report.admin_response || '',
  assignedPersonnelIds: report.assigned_personnel_ids || [],
  priority: report.priority || 'Normal',
  isDeleted: false,
  deletedAt: null,
  isArchived: false,
  isRestored: true,
  handledById: report.handled_by_id || null,
  resolutionImageUrl: report.resolution_image_url || null,
  resolvedAt: report.resolved_at || null,
  ...overrides,
});

const CLIENT_REPORT_ID_PATTERN = /^REP-[A-Z0-9]{8,32}$/i;

const createReport = async (req, res, next) => {
  const { title, description, latitude, longitude } = req.body;
  const category = req.body.category || req.body.waste_type || req.body.wasteType || '';
  const requestedReportId = typeof req.body.report_id === 'string'
    ? req.body.report_id.trim()
    : '';
  const clientReportId = CLIENT_REPORT_ID_PATTERN.test(requestedReportId)
    ? requestedReportId
    : null;

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
    if (!req.file) {
      res.status(400);
      throw new Error('Please upload an image');
    }

    // A client retry may reuse its provisional report ID.  Check for an
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

    logInfo(req.requestId, 'REPORT', `Report fields received: clientReportId=${clientReportId || 'none'} imageBytes=${req.file.size} imageType=${req.file.mimetype}`);

    const result = await uploadImage(req.file.buffer, 'ecowatch/reports');
    const report = await reportRepository.createReport({
      reportId: clientReportId || generateReportId(),
      residentId,
      title,
      category,
      description,
      latitude: latitude !== undefined && latitude !== '' ? latitude : null,
      longitude: longitude !== undefined && longitude !== '' ? longitude : null,
      imageUrl: result.secure_url,
    });

    logInfo(req.requestId, 'DATABASE', `Report created: ${report.report_id}`);
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

    return res.status(201).json(normalizeReport(report));
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

    const normalizedReports = [
      ...reports
        .filter((report) => !report.is_deleted && !report.is_archived)
        .map((report) => normalizeReport(report)),
      ...archivedReports.map((report) => normalizeReport(report, 'archived_reports')),
      ...trashReports.map((report) => normalizeReport(report, 'trash_reports')),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

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
    const { ids = [] } = req.body;
    let modifiedCount = 0;

    for (const id of ids) {
      const found = await findReportInAnyCollection(id, req.resident.residentId);
      if (!found || found.source === targetCollection) continue;

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
    const { ids = [] } = req.body;
    let modifiedCount = 0;

    for (const id of ids) {
      const found = await findReportInAnyCollection(id, req.resident.residentId);
      if (!found) continue;

      if (found.source === 'reports') {
        await reportRepository.deleteByReportId(found.report.report_id);
      } else if (found.source === 'trash_reports') {
        await trashReportRepository.deleteByReportId(found.report.report_id);
        await reportRepository.deleteByReportId(found.report.report_id);
      } else {
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

const updateReport = async (req, res, next) => {
  const { title, description, latitude, longitude } = req.body;
  const category = req.body.category || req.body.waste_type || req.body.wasteType;
  const residentId = req.resident.residentId || req.resident.resident_id;

  try {
    const report = await reportRepository.findByReportId(req.params.id);
    if (!report || report.resident_id !== residentId || report.is_deleted || report.is_archived) {
      res.status(404);
      throw new Error('Report not found');
    }

    let imageUrl = report.image_url;
    if (req.file) {
      const result = await uploadImage(req.file.buffer, 'ecowatch/reports');
      imageUrl = result.secure_url;
    }

    const updates = {
      title: title || report.title,
      category: category || report.category,
      description: description || report.description,
      latitude: latitude !== undefined && latitude !== '' ? latitude : report.latitude,
      longitude: longitude !== undefined && longitude !== '' ? longitude : report.longitude,
      imageUrl,
    };

    if (req.body.status && req.body.status !== report.status) {
      updates.status = req.body.status;
      await logHistory({
        residentId: req.resident.residentId,
        reportId: report.report_id,
        action: 'STATUS_CHANGED',
        oldStatus: report.status,
        newStatus: req.body.status,
        description: `Status changed from ${report.status} to ${req.body.status}`,
      });
    }

    const updatedReport = await reportRepository.updateReport(report.report_id, updates);
    res.json(normalizeReport(updatedReport));
  } catch (error) {
    next(error);
  }
};

const deleteReport = async (req, res, next) => {
  try {
    const found = await findReportInAnyCollection(req.params.id, req.resident.residentId);
    if (!found) {
      res.status(404);
      throw new Error('Report not found');
    }

    if (found.source === 'reports') {
      await reportRepository.deleteByReportId(found.report.report_id);
    } else if (found.source === 'trash_reports') {
      await trashReportRepository.deleteByReportId(found.report.report_id);
      await reportRepository.deleteByReportId(found.report.report_id);
    } else {
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
  updateReport,
  deleteReport,
  softDeleteReport,
  restoreReport,
  archiveReport,
  bulkSoftDeleteReports,
  bulkRestoreReports,
  bulkArchiveReports,
  bulkDeleteReports,
};

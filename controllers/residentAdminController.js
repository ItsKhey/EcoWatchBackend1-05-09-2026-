const residentRepository = require('../repositories/residentRepository');
const reportRepository = require('../repositories/reportRepository');
const reportPhotoService = require('../services/reportPhotoService');
const { createHttpError } = require('../utils/personnelValidation');
const {
  parseReportPageQuery,
  parseResidentListQuery,
  validateResidentId,
} = require('../utils/residentValidation');
const { DISABLED_RESIDENT_STATUSES } = require('../utils/residentAuth');

const requireAuthenticatedAdmin = (req) => {
  const adminId = req.admin?.admin_id;
  const role = String(req.admin?.role || '').toUpperCase();

  if (!adminId || role !== 'ADMIN') {
    throw createHttpError(403, 'Administrator access is required.');
  }

  return adminId;
};

const mapResident = (resident) => {
  const rawStatus = String(resident.status || 'AVAILABLE').trim();
  const normalizedStatus = rawStatus.toUpperCase();
  const disabled = DISABLED_RESIDENT_STATUSES.has(normalizedStatus)
    || resident.is_disabled === true
    || resident.enabled === false;
  const firstName = resident.first_name || '';
  const lastName = resident.last_name || '';

  const mapped = {
    residentId: resident.resident_id,
    serverId: resident.resident_id,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim() || 'Unnamed resident',
    username: resident.username || '',
    email: resident.email || '',
    address: resident.address || '',
    profileImage: resident.profile_image || '',
    profileImageUrl: resident.profile_image || '',
    role: resident.role || 'RESIDENT',
    status: rawStatus || 'AVAILABLE',
    accountStatus: disabled ? 'Disabled' : 'Active',
    isActive: !disabled,
    isDisabled: disabled,
    isVerified: resident.is_verified === true,
    phoneNumber: resident.phone_number || '',
    lastActive: resident.last_active || null,
    dateCreated: resident.created_at || null,
    createdAt: resident.created_at || null,
    updatedAt: resident.updated_at || null,
    totalReports: Number.isFinite(Number(resident.total_reports))
      ? Number(resident.total_reports)
      : 0,
  };
  mapped.reportCounts = { total: mapped.totalReports };
  return mapped;
};

const mapStatistics = (statistics) => ({
  total: Number(statistics?.total || 0),
  pending: Number(statistics?.pending || 0),
  inProgress: Number(statistics?.in_progress || 0),
  in_progress: Number(statistics?.in_progress || 0),
  completed: Number(statistics?.completed || 0),
  denied: Number(statistics?.denied || 0),
});

const mapReport = (report) => ({
  reportId: report.report_id,
  mongoId: report.report_id,
  residentId: report.resident_id,
  title: report.title || 'Untitled report',
  category: report.category || 'Uncategorized',
  description: report.description || '',
  latitude: report.latitude == null ? null : Number(report.latitude),
  longitude: report.longitude == null ? null : Number(report.longitude),
  imageUrl: report.image_url || '',
  photoUrl: report.image_url || '',
  status: report.status || 'Pending',
  adminResponse: report.admin_response || '',
  assignedPersonnelIds: Array.isArray(report.assigned_personnel_ids)
    ? report.assigned_personnel_ids
    : [],
  assignedPersonnelId: report.assigned_personnel_id || null,
  assignedByAdminId: report.assigned_by_admin_id || null,
  assignedAt: report.assigned_at || null,
  priority: report.priority || 'Normal',
  isDeleted: report.is_deleted === true,
  deletedAt: report.deleted_at || null,
  isArchived: report.is_archived === true,
  isRestored: report.is_restored === true,
  createdAt: report.created_at || null,
  updatedAt: report.updated_at || null,
  handledById: report.handled_by_id || null,
  resolutionImageUrl: report.resolution_image_url || null,
  resolvedAt: report.resolved_at || null,
});

const findRequiredResident = async (rawResidentId) => {
  const residentId = validateResidentId(rawResidentId);
  const resident = await residentRepository.findPublicByResidentId(residentId);

  if (!resident) {
    throw createHttpError(404, 'Resident account not found.');
  }

  return resident;
};

const listResidents = async (req, res, next) => {
  try {
    requireAuthenticatedAdmin(req);
    const options = parseResidentListQuery(req.query);
    const [residents, total] = await Promise.all([
      residentRepository.findAllForAdmin(options),
      residentRepository.countAllForAdmin(options),
    ]);

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      residents: residents.map(mapResident),
      count: residents.length,
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

const getResidentDetails = async (req, res, next) => {
  try {
    requireAuthenticatedAdmin(req);
    const resident = await findRequiredResident(req.params.residentId);
    const statistics = await reportRepository.getReportCountsByResidentId(
      resident.resident_id
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      resident: mapResident(resident),
      statistics: mapStatistics(statistics),
      // Alias retained for clients that call the aggregate block counts.
      counts: mapStatistics(statistics),
    });
  } catch (error) {
    next(error);
  }
};

const getResidentReports = async (req, res, next) => {
  try {
    requireAuthenticatedAdmin(req);
    const resident = await findRequiredResident(req.params.residentId);
    const options = parseReportPageQuery(req.query);
    const reportPage = await reportRepository.findPageForResident(
      resident.resident_id,
      options
    );
    const total = reportPage.total;
    const totalPages = Math.ceil(total / options.limit);

    res.set('Cache-Control', 'no-store');
    const reports = reportPage.reports.map(mapReport);
    await reportPhotoService.attachPhotoLists(reports);
    res.json({
      success: true,
      reports,
      count: reportPage.reports.length,
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    next(error);
  }
};

const getResidentReportStatistics = async (req, res, next) => {
  try {
    requireAuthenticatedAdmin(req);
    const resident = await findRequiredResident(req.params.residentId);
    const statistics = await reportRepository.getReportCountsByResidentId(
      resident.resident_id
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

module.exports = {
  listResidents,
  getResidentDetails,
  getResidentReports,
  getResidentReportStatistics,
  mapResident,
  mapReport,
  mapStatistics,
};

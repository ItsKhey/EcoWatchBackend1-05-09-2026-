const { withTransaction } = require('../config/db');
const reportRepository = require('../repositories/reportRepository');
const personnelRepository = require('../repositories/personnelRepository');
const residentRepository = require('../repositories/residentRepository');
const {
  PERSONNEL_ID_PATTERN,
  ASSIGNMENT_ID_PATTERN,
  createHttpError,
} = require('../utils/personnelValidation');

const uniqueAssignmentIds = (values) => [
  ...new Set(
    (Array.isArray(values) ? values : [])
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim().toUpperCase())
      .filter((value) => ASSIGNMENT_ID_PATTERN.test(value))
  ),
];

const personnelAccountIds = (values) =>
  uniqueAssignmentIds(values).filter((value) =>
    PERSONNEL_ID_PATTERN.test(value)
  );

const assignPersonnelToReport = async ({
  report,
  assignedPersonnelIds = [],
  priority,
  handledById = null,
  updatedByAdminId,
}) => {
  const requestedIds = uniqueAssignmentIds(assignedPersonnelIds);
  const legacyAssignmentIds = requestedIds.filter(
    (value) => !PERSONNEL_ID_PATTERN.test(value)
  );
  const currentAssignmentIds = personnelAccountIds([
    ...requestedIds,
    handledById,
  ]);
  const previousAssignmentIds = personnelAccountIds([
    ...(report.assigned_personnel_ids || []),
    report.handled_by_id,
  ]);

  return withTransaction(async (client) => {
    if (legacyAssignmentIds.length) {
      const legacyPersonnel =
        await residentRepository.findLegacyPersonnelByIds(
          legacyAssignmentIds,
          { queryable: client, lock: true }
        );

      if (legacyPersonnel.length !== legacyAssignmentIds.length) {
        const foundIds = new Set(
          legacyPersonnel.map((account) => account.resident_id)
        );
        const missingIds = legacyAssignmentIds.filter(
          (id) => !foundIds.has(id)
        );

        throw createHttpError(
          400,
          `Legacy personnel account is missing or is not a legacy Environmental Services Personnel record: ${missingIds.join(', ')}`
        );
      }
    }

    const personnel = await personnelRepository.findActiveByIds(
      currentAssignmentIds,
      { lock: true, queryable: client }
    );

    if (personnel.length !== currentAssignmentIds.length) {
      const foundIds = new Set(personnel.map((account) => account.personnel_id));
      const missingIds = currentAssignmentIds.filter((id) => !foundIds.has(id));

      throw createHttpError(
        400,
        `Personnel account is missing, disabled, or deleted: ${missingIds.join(', ')}`
      );
    }

    const conflictingAssignments = personnel.filter(
      (account) =>
        account.current_assignment_report_id &&
        account.current_assignment_report_id !== report.report_id
    );

    if (conflictingAssignments.length) {
      throw createHttpError(
        409,
        `Personnel already assigned to another report: ${conflictingAssignments
          .map((account) => account.personnel_id)
          .join(', ')}`
      );
    }

    const location = {
      latitude: report.latitude ?? null,
      longitude: report.longitude ?? null,
    };
    const updatedReport = await reportRepository.updateReport(
      report.report_id,
      {
        assignedPersonnelIds: requestedIds,
        priority: priority || report.priority,
        handledById: handledById || null,
        status: 'In Progress',
      },
      client
    );

    if (!updatedReport) {
      throw createHttpError(404, 'Report not found.');
    }

    await personnelRepository.syncReportAssignments(
      {
        reportId: report.report_id,
        location,
        previousPersonnelIds: previousAssignmentIds,
        nextPersonnelIds: currentAssignmentIds,
        updatedByAdminId,
      },
      client
    );

    return updatedReport;
  });
};

const completePersonnelReport = async ({ report, updatedByAdminId }) =>
  withTransaction(async (client) => {
    const updatedReport = await reportRepository.updateReport(
      report.report_id,
      {
        status: 'Completed',
        resolvedAt: new Date(),
      },
      client
    );

    if (!updatedReport) {
      throw createHttpError(404, 'Report not found.');
    }

    const clearedPersonnelIds =
      await personnelRepository.clearCurrentAssignmentsForReport(
        report.report_id,
        updatedByAdminId,
        client
      );

    return {
      report: updatedReport,
      clearedPersonnelIds,
    };
  });

module.exports = {
  assignPersonnelToReport,
  completePersonnelReport,
};

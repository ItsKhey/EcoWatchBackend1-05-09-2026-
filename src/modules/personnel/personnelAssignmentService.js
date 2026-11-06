const { withTransaction } = require('../../config/db');
const personnelAssignmentRepository = require('./personnelAssignmentRepository');
const personnelEvidenceRepository = require('./personnelEvidenceRepository');
const reportRepository = require('../reports/reportRepository');
const historyRepository = require('../history/historyRepository');
const cloudinaryService = require('../../shared/cloudinaryService');
const notificationService = require('../notifications/notificationService');
const {
  createHttpError,
} = require('../../shared/personnelValidation');
const { CATEGORY: HISTORY_CATEGORY } = require('../../shared/historyActions');
const { DEFAULT_WASTE_SCALE, requiresTeam } = require('../../shared/wasteScaleValidation');
const { logError } = require('../../shared/logger');

/**
 * Personnel-side execution of an assignment.
 *
 * The administrator's assignment flow already owns the report lifecycle
 * (`reports.status`). This service only advances the personnel-owned
 * `personnel_assignments.status` through
 * ASSIGNED -> ACCEPTED -> IN_PROGRESS -> COMPLETED, enforcing that a cleaner
 * acknowledges the task, records before evidence, starts, records after
 * evidence, and finishes. Completion never approves the report: only the admin
 * approval path moves the report to Completed, so the resident-facing status is
 * untouched here.
 */

const STATUS = Object.freeze({
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
});

const PHASE = Object.freeze({
  BEFORE: 'BEFORE',
  AFTER: 'AFTER',
});

const PERSONNEL_ID_PATTERN = /^PERS-[0-9]{4}$/;
const ASSIGNMENT_ID_PATTERN = /^ASG-[0-9]{1,12}$/i;
const MAX_NOTES_LENGTH = 1000;
const MAX_PAGE_SIZE = 100;

const normalizePersonnelId = (personnelId) => {
  if (typeof personnelId !== 'string') {
    throw createHttpError(401, 'Personnel identity is missing.');
  }

  const id = personnelId.trim().toUpperCase();
  if (!PERSONNEL_ID_PATTERN.test(id)) {
    throw createHttpError(401, 'Personnel identity is missing.');
  }

  return id;
};

const normalizeAssignmentId = (assignmentId) => {
  if (typeof assignmentId !== 'string' || !ASSIGNMENT_ID_PATTERN.test(assignmentId.trim())) {
    throw createHttpError(400, 'Invalid assignment ID.');
  }

  return assignmentId.trim().toUpperCase();
};

const normalizePhase = (phase) => {
  const value = String(phase || '').trim().toUpperCase();
  if (value !== PHASE.BEFORE && value !== PHASE.AFTER) {
    throw createHttpError(400, 'phase must be BEFORE or AFTER.');
  }

  return value;
};

const normalizeNotes = (notes) => {
  if (notes === undefined || notes === null) {
    return null;
  }

  if (typeof notes !== 'string') {
    throw createHttpError(400, 'Completion notes must be a string.');
  }

  const value = notes.trim();
  if (value.length > MAX_NOTES_LENGTH) {
    throw createHttpError(
      400,
      `Completion notes must be at most ${MAX_NOTES_LENGTH} characters.`
    );
  }

  return value || null;
};

const parsePagination = (query = {}) => {
  const rawLimit = query.limit === undefined ? 50 : Number(query.limit);
  const rawPage = query.page === undefined ? 1 : Number(query.page);

  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_PAGE_SIZE) {
    throw createHttpError(400, `limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
  }

  if (!Number.isInteger(rawPage) || rawPage < 1) {
    throw createHttpError(400, 'page must be a positive integer.');
  }

  return { limit: rawLimit, offset: (rawPage - 1) * rawLimit, page: rawPage };
};

const parseStatusFilter = (status) => {
  if (status === undefined || status === null || status === '') {
    return null;
  }

  const value = String(status).trim().toUpperCase();
  if (!Object.values(STATUS).includes(value)) {
    throw createHttpError(
      400,
      'status must be ASSIGNED, ACCEPTED, IN_PROGRESS, COMPLETED, or CANCELLED.'
    );
  }

  return value;
};

const isTeamTaskRow = (row) => Boolean(row && row.assigned_team_id)
  && requiresTeam(row.waste_scale || row.report_waste_scale || DEFAULT_WASTE_SCALE);

const assertTeamLeader = (row, personnelId, action) => {
  if (isTeamTaskRow(row)
      && String(row.assigned_team_leader_personnel_id || '').toUpperCase()
        !== String(personnelId).toUpperCase()) {
    throw createHttpError(403, `Only your team leader can ${action} for this task.`);
  }
};

const mapEvidence = (rows = []) => {
  const before = [];
  const after = [];

  for (const row of rows) {
    const item = {
      evidenceId: row.evidence_id,
      assignmentId: row.assignment_id,
      reportId: row.report_id,
      phase: row.phase,
      imageUrl: row.image_url,
      uploadedAt: row.uploaded_at,
    };

    if (row.phase === PHASE.AFTER) {
      after.push(item);
    } else {
      before.push(item);
    }
  }

  return { before, after };
};

/**
 * Presents one assignment row as the task shape the Android client renders.
 *
 * `permissions` is computed server-side from the current status plus the
 * recorded evidence, so the app never has to re-implement the workflow rules
 * and can never enable a button the backend would reject.
 */
const presentTask = (row, evidenceRows = [], personnelId = null) => {
  if (!row) return null;

  const evidence = mapEvidence(evidenceRows);
  const status = row.status;
  const beforeCount = evidence.before.length;
  const afterCount = evidence.after.length;
  const teamTask = isTeamTaskRow(row);
  const isTeamLeader = teamTask
    && personnelId
    && row.assigned_team_leader_personnel_id
    && String(row.assigned_team_leader_personnel_id).toUpperCase()
      === String(personnelId).toUpperCase();
  const canPerformTeamActions = !teamTask || isTeamLeader;

  return {
    assignmentId: row.assignment_id,
    reportId: row.report_id,
    personnelId: row.personnel_id,
    clusterId: row.cluster_id || row.report_cluster_id || null,
    status,
    assignedByAdminId: row.assigned_by_admin_id || null,
    assignedAt: row.assigned_at || null,
    acceptedAt: row.accepted_at || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    completionNotes: row.completion_notes || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    // How big the job is, and what turned out with it. A cleaner on a
    // Large-Scale Waste needs to know a truck is coming, and a cleaner on a
    // Medium-Scale Waste needs to know they are part of a crew.
    wasteScale: row.waste_scale || row.report_waste_scale || DEFAULT_WASTE_SCALE,
    assignedTeamId: row.assigned_team_id || null,
    assignedTeamName: row.assigned_team_name || null,
    isTeamTask: teamTask,
    isTeamLeader: Boolean(isTeamLeader),
    assignedVehicleId: row.assigned_vehicle_id || null,
    assignedVehiclePlateNumber: row.assigned_vehicle_plate_number || null,
    assignedVehicleType: row.assigned_vehicle_type || null,
    report: {
      reportId: row.report_id,
      title: row.report_title || null,
      category: row.report_category || null,
      description: row.report_description || null,
      latitude: row.report_latitude ?? null,
      longitude: row.report_longitude ?? null,
      imageUrl: row.report_image_url || null,
      status: row.report_status || null,
      priority: row.report_priority || null,
      adminResponse: row.report_admin_response || '',
      // The administrator's note for the cleaner. Separate from
      // `adminResponse`, which is the answer the resident reads. Present so a
      // cleaner reopened after a revision sees why, not just that they were.
      personnelNote: row.report_personnel_note || '',
      clusterId: row.report_cluster_id || null,
      createdAt: row.report_created_at || null,
      resolvedAt: row.report_resolved_at || null,
      wasteScale: row.report_waste_scale || row.waste_scale || DEFAULT_WASTE_SCALE,
    },
    evidence,
    beforeCount,
    afterCount,
    permissions: {
      canAccept: status === STATUS.ASSIGNED && canPerformTeamActions,
      canUploadBefore: canPerformTeamActions
        && (status === STATUS.ACCEPTED || status === STATUS.IN_PROGRESS),
      canStart: status === STATUS.ACCEPTED && beforeCount > 0,
      canUploadAfter: status === STATUS.IN_PROGRESS && canPerformTeamActions,
      canComplete:
        status === STATUS.IN_PROGRESS && beforeCount > 0 && afterCount > 0,
      canDeleteEvidence: canPerformTeamActions && [
        STATUS.ASSIGNED,
        STATUS.ACCEPTED,
        STATUS.IN_PROGRESS,
      ].includes(status),
    },
  };
};

/** One dispatched crew member, shaped the way the cleaner app renders it. */
const mapCrewMember = (row) => ({
  personnelId: row.personnel_id,
  fullName: `${row.first_name || ''} ${row.last_name || ''}`.trim() || null,
  profileImage: row.profile_image || null,
  assignedVehiclePlateNumber: row.assigned_vehicle_plate_number || null,
  isTeamLeader: row.is_leader === true,
});

/**
 * The dispatched crew for each of the given reports, keyed by report id.
 *
 * <p>A Medium- or Large-Scale Waste is cleared by a crew, and a cleaner needs
 * to know who else turned out. The assignment rows are the authoritative list:
 * they are the people the administrator actually dispatched, whether they came
 * from a saved team or were picked ad hoc. The team roster is not used here
 * because it can change after the dispatch and would then name people who were
 * never sent.
 *
 * <p>Resolved in one query for a page of tasks, so the list endpoint stays one
 * round trip regardless of how many reports it returns.
 */
const crewByReportId = async (reportIds, queryable) => {
  const ids = [
    ...new Set(
      (Array.isArray(reportIds) ? reportIds : [])
        .filter(Boolean)
        .map((id) => String(id).trim())
        .filter(Boolean)
    ),
  ];

  if (!ids.length) return new Map();

  const rows = await personnelAssignmentRepository.listCrewByReportIds(
    ids,
    queryable
  );

  const crews = new Map();
  for (const row of rows) {
    const crew = crews.get(row.report_id) || [];
    crew.push(mapCrewMember(row));
    crews.set(row.report_id, crew);
  }

  // Leader first, then by name, so the summary line reads the way a crew is
  // introduced rather than in personnel-id order.
  for (const crew of crews.values()) {
    crew.sort((a, b) => {
      if (a.isTeamLeader !== b.isTeamLeader) return a.isTeamLeader ? -1 : 1;
      return String(a.fullName || '').localeCompare(String(b.fullName || ''));
    });
  }

  return crews;
};

/**
 * Adds the report's cleaning timeline and its current-cycle revision flag.
 *
 * <p>The revision flag and the timeline are recorded in {@code report_histories}
 * rather than on the assignment row, so they are attached here instead of being
 * selected by {@code presentTask}. The flag answers "was this assignment sent
 * back for revision", which is what the history tab filters on; the timeline
 * carries the {@code REVISION_REQUESTED} timestamp the detail screen shows.
 */
const attachTaskHistory = (task, timeline, revisionRequested) => {
  if (!task) return task;
  return {
    ...task,
    revisionRequested: Boolean(revisionRequested),
    report: task.report
      ? {
          ...task.report,
          revisionRequested: Boolean(revisionRequested),
          timeline: Array.isArray(timeline) ? timeline : [],
        }
      : task.report,
  };
};

/**
 * {@link presentTask} plus the named crew that was dispatched with it.
 *
 * <p>Every route that returns a task goes through here: the detail screen
 * re-renders from the response of accept/start/complete, so a task that only
 * carried the crew on the initial GET would lose it the moment the cleaner
 * tapped a button.
 */
const presentTaskWithCrew = async (row, evidenceRows, personnelId, queryable) => {
  const task = presentTask(row, evidenceRows, personnelId);
  if (!task) return task;

  const reportIds = [task.reportId];
  const [crews, timelines, revisionIds] = await Promise.all([
    crewByReportId(reportIds, queryable),
    historyRepository.findTaskTimelinesByReportIds(reportIds, queryable),
    historyRepository.findRevisionRequestedReportIds(reportIds, queryable),
  ]);

  return attachTaskHistory(
    { ...task, assignedCrew: crews.get(task.reportId) || [] },
    timelines.get(task.reportId) || [],
    revisionIds.has(task.reportId)
  );
};

const findTaskOrThrow = async (assignmentId, personnelId, db) => {
  const row = await personnelAssignmentRepository.findById(assignmentId, db);
  if (!row || String(row.personnel_id).toUpperCase() !== personnelId) {
    throw createHttpError(404, 'Assignment not found.');
  }

  return row;
};

/** Row-locked variant used inside a transition transaction. */
const lockOwnedTask = async (assignmentId, personnelId, client) => {
  const row = await personnelAssignmentRepository.findByIdForUpdate(
    assignmentId,
    client
  );

  if (!row || String(row.personnel_id).toUpperCase() !== personnelId) {
    throw createHttpError(404, 'Assignment not found.');
  }

  return row;
};

const evidenceRowsForTask = (row, assignmentId, queryable) => isTeamTaskRow(row)
  ? personnelEvidenceRepository.listForReport(row.report_id, queryable)
  : personnelEvidenceRepository.listForAssignment(assignmentId, queryable);

const evidenceCountsForTask = async (row, assignmentId, queryable) => {
  const rows = await evidenceRowsForTask(row, assignmentId, queryable);
  return rows.reduce((counts, evidence) => {
    if (evidence.phase === PHASE.BEFORE || evidence.phase === PHASE.AFTER) {
      counts[evidence.phase] += 1;
    }
    return counts;
  }, { BEFORE: 0, AFTER: 0 });
};

const getCurrentTask = async (personnelId) => {
  const id = normalizePersonnelId(personnelId);
  const row = await personnelAssignmentRepository.findActiveByPersonnelId(id);

  if (!row) {
    return null;
  }

  const evidence = await evidenceRowsForTask(row, row.assignment_id);
  return presentTaskWithCrew(row, evidence, id);
};

const getTask = async (personnelId, assignmentId) => {
  const id = normalizePersonnelId(personnelId);
  const normalizedId = normalizeAssignmentId(assignmentId);
  const row = await findTaskOrThrow(normalizedId, id);
  const evidence = await evidenceRowsForTask(row, row.assignment_id);
  return presentTaskWithCrew(row, evidence, id);
};

const listTasks = async (personnelId, query = {}) => {
  const id = normalizePersonnelId(personnelId);
  const { limit, offset, page } = parsePagination(query);
  const status = parseStatusFilter(query.status);
  const rows = await personnelAssignmentRepository.listForPersonnel(id, {
    status,
    limit,
    offset,
  });

  const evidenceRows = await personnelEvidenceRepository.listForAssignments(
    rows.map((row) => row.assignment_id)
  );
  const evidenceByAssignment = new Map();
  for (const evidence of evidenceRows) {
    const list = evidenceByAssignment.get(evidence.assignment_id) || [];
    list.push(evidence);
    evidenceByAssignment.set(evidence.assignment_id, list);
  }

  const total = rows.length ? Number(rows[0].total_count) : 0;
  const reportIds = rows.map((row) => row.report_id);
  const [crewsByReport, timelines, revisionIds] = await Promise.all([
    crewByReportId(reportIds),
    historyRepository.findTaskTimelinesByReportIds(reportIds),
    historyRepository.findRevisionRequestedReportIds(reportIds),
  ]);
  return {
    tasks: rows.map((row) => attachTaskHistory(
      {
        ...presentTask(row, evidenceByAssignment.get(row.assignment_id) || [], id),
        assignedCrew: crewsByReport.get(row.report_id) || [],
      },
      timelines.get(row.report_id) || [],
      revisionIds.has(row.report_id)
    )),
    pagination: {
      page,
      limit,
      total,
      totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
    },
  };
};

/**
 * The cleaner's task totals, counted over every assignment row.
 *
 * `totalAssigned` is the whole history (every task this cleaner was ever given),
 * `onHand` is what is still in their hands, and `completed` is what they have
 * finished. The admin app counts the same three from the same rows for the same
 * cleaner, so the two screens agree.
 */
const getTaskCounts = async (personnelId) => {
  const id = normalizePersonnelId(personnelId);
  const counts = await personnelAssignmentRepository.countsByPersonnelId(id);

  return {
    total: Number(counts.total || 0),
    totalAssigned: Number(counts.total || 0),
    total_assigned: Number(counts.total || 0),
    assigned: Number(counts.assigned || 0),
    accepted: Number(counts.accepted || 0),
    inProgress: Number(counts.in_progress || 0),
    completed: Number(counts.completed || 0),
    cancelled: Number(counts.cancelled || 0),
  };
};

const acceptTask = async (personnelId, assignmentId) => {
  const id = normalizePersonnelId(personnelId);
  const normalizedId = normalizeAssignmentId(assignmentId);

  return withTransaction(async (client) => {
    const current = await lockOwnedTask(normalizedId, id, client);

    if (current.status !== STATUS.ASSIGNED) {
      throw createHttpError(
        409,
        `This task cannot be accepted while it is ${current.status}.`
      );
    }

    assertTeamLeader(current, id, 'accept');

    const updated = await personnelAssignmentRepository.updateStatus(
      normalizedId,
      { status: STATUS.ACCEPTED, acceptedAt: new Date() },
      client
    );
    if (isTeamTaskRow(current)) {
      await personnelAssignmentRepository.acceptTeamAssignments(
        current.report_id,
        current.assigned_team_id,
        updated.accepted_at || new Date(),
        client
      );
    }

    const evidence = await evidenceRowsForTask(updated, normalizedId, client);
    return presentTaskWithCrew(updated, evidence, id, client);
  });
};

/**
 * Best-effort resident notice that cleaning actually began. The personnel
 * transition is already committed, so a notification failure is logged and the
 * Alerts list reconciles it rather than failing the cleaner's action.
 */
const notifyCleaningStartedSafely = async ({ reportId, requestId = null }) => {
  try {
    await notificationService.createForReportEvent({
      reportId,
      type: notificationService.NOTIFICATION_TYPES.CLEANING_STARTED,
      requestId,
    });
  } catch (error) {
    logError(
      requestId,
      'CLEANING_STARTED',
      `Unable to notify the resident that cleaning started for report ${reportId}: ${error.message}`
    );
  }
};

const startTask = async (personnelId, assignmentId, { requestId = null } = {}) => {
  const id = normalizePersonnelId(personnelId);
  const normalizedId = normalizeAssignmentId(assignmentId);

  const task = await withTransaction(async (client) => {
    const current = await lockOwnedTask(normalizedId, id, client);

    if (current.status !== STATUS.ACCEPTED) {
      throw createHttpError(
        409,
        `This task cannot be started while it is ${current.status}.`
      );
    }

    const counts = await evidenceCountsForTask(current, normalizedId, client);
    if (!counts.BEFORE) {
      throw createHttpError(
        409,
        'Upload at least one BEFORE photo before starting the task.'
      );
    }

    const updated = await personnelAssignmentRepository.updateStatus(
      normalizedId,
      { status: STATUS.IN_PROGRESS, startedAt: new Date() },
      client
    );

    // Recorded inside the transaction that moves the task, so the audit trail and
    // the state it describes cannot disagree: either both land or neither does.
    // The resident is read from the report rather than from the assignment row,
    // which does not carry it, so the record stays attributed to the account the
    // report belongs to.
    const report = await reportRepository.findByReportId(current.report_id, client);

    await historyRepository.createHistory(
      {
        residentId: report ? report.resident_id : null,
        reportId: current.report_id,
        action: 'CLEANING_STARTED',
        category: HISTORY_CATEGORY.CLEANING,
        oldStatus: STATUS.ACCEPTED,
        newStatus: STATUS.IN_PROGRESS,
        description: `Cleaning started for report ${current.report_id} by ${id}.`,
      },
      client
    );

    const evidence = await evidenceRowsForTask(updated, normalizedId, client);
    return presentTaskWithCrew(updated, evidence, id, client);
  });

  await notifyCleaningStartedSafely({
    reportId: task.reportId,
    requestId,
  });

  return task;
};

const completeTask = async (
  personnelId,
  assignmentId,
  { notes = null, requestId = null } = {}
) => {
  const id = normalizePersonnelId(personnelId);
  const normalizedId = normalizeAssignmentId(assignmentId);
  const completionNotes = normalizeNotes(notes);

  return withTransaction(async (client) => {
    // Serialise against the admin assignment/approval commands, which take the
    // same advisory lock before touching the report row, so the report status
    // write below cannot interleave with an approval or a revision request.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('myecowatch:phase-2b:assignment-command:v1'))"
    );

    const current = await lockOwnedTask(normalizedId, id, client);

    if (current.status !== STATUS.IN_PROGRESS) {
      throw createHttpError(
        409,
        `This task cannot be completed while it is ${current.status}.`
      );
    }

    const counts = await evidenceCountsForTask(current, normalizedId, client);
    if (!counts.BEFORE || !counts.AFTER) {
      throw createHttpError(
        409,
        'Both BEFORE and AFTER photos are required before completing the task.'
      );
    }

    const updated = await personnelAssignmentRepository.updateStatus(
      normalizedId,
      {
        status: STATUS.COMPLETED,
        completedAt: new Date(),
        completionNotes,
      },
      client
    );
    const evidence = await evidenceRowsForTask(updated, normalizedId, client);

    // Finishing the work does not approve the report. It moves the report into
    // the administrator's review queue so they can inspect the before/after
    // photos and either accept (Completed) or request a revision. A report that
    // is no longer In Progress has already been handled elsewhere and is left
    // untouched.
    const report = await reportRepository.findByReportIdForUpdate(
      current.report_id,
      client
    );

    // The cleaning itself, recorded before the status change below. This is the
    // event the administrator's Cleaning tab is for: the work was done and is now
    // waiting on their review, which the following STATUS_CHANGED row does not
    // say on its own.
    await historyRepository.createHistory(
      {
        residentId: report ? report.resident_id : null,
        reportId: current.report_id,
        action: 'CLEANING_COMPLETED',
        category: HISTORY_CATEGORY.CLEANING,
        oldStatus: STATUS.IN_PROGRESS,
        newStatus: STATUS.COMPLETED,
        description: `Cleaning completed for report ${current.report_id}. `
          + `Personnel: ${id}.`,
      },
      client
    );

    if (
      report
      && String(report.status || '').trim().toLowerCase() === 'in progress'
    ) {
      await reportRepository.updateReport(
        report.report_id,
        { status: 'Under Review' },
        client
      );
      await historyRepository.createHistory(
        {
          residentId: report.resident_id,
          reportId: report.report_id,
          action: 'STATUS_CHANGED',
          oldStatus: report.status,
          newStatus: 'Under Review',
          description: 'Personnel submitted completed work for administrator review.',
        },
        client
      );
    }

    // `requestId` is accepted for symmetry with the other transitions and so a
    // future admin-side notification can correlate the event.
    void requestId;
    return presentTaskWithCrew(updated, evidence, id, client);
  });
};

/**
 * Stores one before/after photo against the cleaner's own task.
 *
 * The storage upload happens inside the transaction that validates the state so
 * a rejected phase can never leave an orphaned asset, and a failed write removes
 * the just-uploaded asset before re-throwing.
 */
const uploadEvidence = async (
  personnelId,
  assignmentId,
  { phase, file }
) => {
  const id = normalizePersonnelId(personnelId);
  const normalizedId = normalizeAssignmentId(assignmentId);
  const normalizedPhase = normalizePhase(phase);

  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw createHttpError(400, 'An image file is required.');
  }

  let uploadedUrl = null;

  try {
    return await withTransaction(async (client) => {
      const current = await lockOwnedTask(normalizedId, id, client);
      assertTeamLeader(current, id, 'upload or remove photos');

      if (normalizedPhase === PHASE.BEFORE) {
        if (![STATUS.ACCEPTED, STATUS.IN_PROGRESS].includes(current.status)) {
          throw createHttpError(
            409,
            'BEFORE photos can only be uploaded after accepting the task.'
          );
        }
      } else if (current.status !== STATUS.IN_PROGRESS) {
        throw createHttpError(
          409,
          'AFTER photos can only be uploaded after starting the task.'
        );
      }

      const uploaded = await cloudinaryService.uploadImage(
        file.buffer,
        'ecowatch/evidence'
      );
      uploadedUrl = uploaded?.secure_url || null;

      if (!uploadedUrl) {
        throw new Error('Image upload returned no URL.');
      }

      const evidence = await personnelEvidenceRepository.addEvidence(
        {
          assignmentId: normalizedId,
          reportId: current.report_id,
          personnelId: id,
          phase: normalizedPhase,
          imageUrl: uploadedUrl,
        },
        client
      );

      const evidenceRows = await evidenceRowsForTask(current, normalizedId, client);

      // Evidence submission is recorded rather than inferred from the photos
      // themselves: the administrator's Cleaning tab needs to show that a phase
      // was submitted, and the count of photos is not the same statement. One row
      // per upload, because a second BEFORE photo is a separate submission and
      // collapsing them would hide how the work actually progressed.
      const report = await reportRepository.findByReportId(current.report_id, client);
      const isFirstForPhase = evidenceRows.filter(
        (row) => row.phase === normalizedPhase
      ).length === 1;

      if (isFirstForPhase) {
        await historyRepository.createHistory(
          {
            residentId: report ? report.resident_id : null,
            reportId: current.report_id,
            action: normalizedPhase === PHASE.BEFORE
              ? 'BEFORE_EVIDENCE_SUBMITTED'
              : 'AFTER_EVIDENCE_SUBMITTED',
            category: HISTORY_CATEGORY.CLEANING,
            description: `${normalizedPhase === PHASE.BEFORE ? 'Before' : 'After'}-cleaning `
              + `evidence submitted for report ${current.report_id}. Personnel: ${id}.`,
          },
          client
        );
      }

      return {
        evidence: {
          evidenceId: evidence.evidence_id,
          assignmentId: evidence.assignment_id,
          reportId: evidence.report_id,
          phase: evidence.phase,
          imageUrl: evidence.image_url,
          uploadedAt: evidence.uploaded_at,
        },
        task: await presentTaskWithCrew(
          await personnelAssignmentRepository.findById(normalizedId, client),
          evidenceRows,
          id,
          client
        ),
      };
    });
  } catch (error) {
    // The row was not committed; remove the asset so a rejected phase cannot
    // accumulate files nobody can reach.
    if (uploadedUrl) {
      try {
        await cloudinaryService.destroyImage(uploadedUrl);
      } catch (cleanupError) {
        logError(
          null,
          'EVIDENCE_STORAGE',
          `Unable to clean up rejected evidence photo: ${cleanupError.message}`
        );
      }
    }

    throw error;
  }
};

const deleteEvidence = async (personnelId, assignmentId, evidenceId) => {
  const id = normalizePersonnelId(personnelId);
  const normalizedId = normalizeAssignmentId(assignmentId);

  const deleted = await withTransaction(async (client) => {
    const current = await lockOwnedTask(normalizedId, id, client);
    assertTeamLeader(current, id, 'upload or remove photos');

    if (![STATUS.ASSIGNED, STATUS.ACCEPTED, STATUS.IN_PROGRESS].includes(current.status)) {
      throw createHttpError(
        409,
        'Evidence cannot be changed after the task is completed.'
      );
    }

    const owned = await personnelEvidenceRepository.findOwned(
      {
        assignmentId: normalizedId,
        evidenceId,
        personnelId: id,
      },
      client
    );

    if (!owned) {
      throw createHttpError(404, 'Evidence photo not found.');
    }

    const removed = await personnelEvidenceRepository.deleteOwned(
      {
        assignmentId: normalizedId,
        evidenceId,
        personnelId: id,
      },
      client
    );

    const updatedRow = await personnelAssignmentRepository.findById(normalizedId, client);
    const evidenceRows = await evidenceRowsForTask(updatedRow, normalizedId, client);

    return {
      removed,
      task: await presentTaskWithCrew(
        updatedRow,
        evidenceRows,
        id,
        client
      ),
    };
  });

  if (deleted.removed?.image_url) {
    try {
      await cloudinaryService.destroyImage(deleted.removed.image_url);
    } catch (cleanupError) {
      logError(
        null,
        'EVIDENCE_STORAGE',
        `Unable to delete evidence photo asset: ${cleanupError.message}`
      );
    }
  }

  return deleted.task;
};

module.exports = {
  STATUS,
  PHASE,
  presentTask,
  getCurrentTask,
  getTask,
  listTasks,
  getTaskCounts,
  acceptTask,
  startTask,
  completeTask,
  uploadEvidence,
  deleteEvidence,
};

const cleaningTeamRepository = require('./cleaningTeamRepository');
const personnelRepository = require('./personnelRepository');
const {
  MINIMUM_TEAM_MEMBERS,
  normalizeTeamId,
} = require('../../shared/cleaningTeamValidation');
const { createHttpError } = require('../../shared/personnelValidation');

/**
 * The cleaning team service.
 *
 * A team is a named crew the administrator maintains once and then dispatches
 * as a unit when a report is filed under Medium- or Large-Scale Waste. The
 * service owns the wire shape and the rules; the repository owns the SQL.
 */

/**
 * The leader's display name.
 *
 * The list endpoint joins the leader row so a card can name them without a
 * second request; the detail endpoint has the member list, which is the more
 * current answer. Both fall back to the id only when no name is stored.
 */
const resolveLeaderName = (row, members, leaderId) => {
  if (members && leaderId) {
    const leader = members.find(
      (member) => member.personnelId &&
        String(member.personnelId).trim().toUpperCase() === leaderId
    );
    if (leader && leader.fullName) return leader.fullName;
  }

  const joined = `${row.leader_first_name || ''} ${row.leader_last_name || ''}`.trim();
  return joined || null;
};

const presentTeam = (row, members = null) => {
  if (!row) return null;

  const leaderId = row.leader_personnel_id
    ? String(row.leader_personnel_id).trim().toUpperCase()
    : null;

  return {
    teamId: row.team_id,
    teamName: row.team_name,
    description: row.description || null,
    parentTeamId: row.parent_team_id || null,
    parentTeamName: row.parent_team_name || null,
    leaderPersonnelId: leaderId,
    leaderId,
    leaderName: resolveLeaderName(row, members, leaderId),
    memberCount:
      row.member_count === undefined || row.member_count === null
        ? (members ? members.length : 0)
        : Number(row.member_count),
    isDeleted: row.is_deleted === true,
    deletedAt: row.deleted_at || null,
    createdByAdminId: row.created_by_admin_id || null,
    updatedByAdminId: row.updated_by_admin_id || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    members: members
      ? members.map((member) => ({
        personnelId: member.personnelId,
        leader: member.leader === true || (
          leaderId !== null &&
          String(member.personnelId).trim().toUpperCase() === leaderId
        ),
        fullName: member.fullName,
        firstName: member.firstName,
        lastName: member.lastName,
        username: member.username,
        occupation: member.occupation,
        status: member.status,
        enabled: member.enabled,
        profileImage: member.profileImage,
        assignedVehicleId: member.assignedVehicleId,
        assignedVehiclePlateNumber: member.assignedVehiclePlateNumber,
        addedAt: member.addedAt,
      }))
      : undefined,
  };
};

const listCleaningTeams = async ({ includeDeleted = false } = {}) => {
  const rows = await cleaningTeamRepository.listTeams({ includeDeleted });
  return rows.map((row) => presentTeam(row));
};

const getCleaningTeam = async ({ teamId: rawTeamId }) => {
  const teamId = normalizeTeamId(rawTeamId);
  if (!teamId) {
    throw createHttpError(400, 'A cleaning team id is required.');
  }

  const row = await cleaningTeamRepository.findTeamById(teamId);
  if (!row || row.is_deleted === true) {
    throw createHttpError(404, 'Cleaning team not found.');
  }

  const members = await cleaningTeamRepository.listTeamMembers(teamId);
  return presentTeam(row, members);
};

/**
 * Creates a team.
 *
 * The membership can be set at the same time as the name, because a team with
 * nobody on it cannot be dispatched and would only be a name in a list.
 */
const createCleaningTeam = async ({ payload, adminId = null }) => {
  const leaderId = payload.leaderId || null;

  // The leader is also on the crew. Sending them separately would let a client
  // create a team whose leader is not a member, which no dispatch rule can make
  // sense of, so the leader is folded into the membership here.
  let memberIds = Array.isArray(payload.memberIds) ? [...payload.memberIds] : null;
  if (leaderId) {
    if (memberIds === null) {
      memberIds = [leaderId];
    } else if (!memberIds.includes(leaderId)) {
      memberIds = [...memberIds, leaderId];
    }
  }

  if (memberIds !== null && memberIds.length < MINIMUM_TEAM_MEMBERS) {
    throw createHttpError(
      400,
      `A cleaning team needs at least ${MINIMUM_TEAM_MEMBERS} members.`
    );
  }

  const row = await cleaningTeamRepository.createTeam({
    teamName: payload.teamName,
    description: payload.description,
    parentTeamId: payload.parentTeamId,
    leaderPersonnelId: leaderId,
    createdByAdminId: adminId,
  });

  if (!row) {
    throw createHttpError(500, 'The cleaning team could not be created.');
  }

  if (Array.isArray(memberIds)) {
    await cleaningTeamRepository.replaceTeamMembers(
      row.team_id,
      memberIds,
      adminId
    );
  }

  const members = await cleaningTeamRepository.listTeamMembers(row.team_id);
  return presentTeam(row, members);
};

/**
 * Updates a team.
 *
 * The membership is replaced wholesale when it is supplied: the list is the
 * whole truth, so a member who is dropped simply stops being on this crew.
 */
const updateCleaningTeam = async ({ teamId: rawTeamId, payload, adminId = null }) => {
  const teamId = normalizeTeamId(rawTeamId);
  if (!teamId) {
    throw createHttpError(400, 'A cleaning team id is required.');
  }

  const existing = await cleaningTeamRepository.findTeamById(teamId);
  if (!existing || existing.is_deleted === true) {
    throw createHttpError(404, 'Cleaning team not found.');
  }

  // The effective leader is the one being written, or the one already on the
  // team when the caller only touched the name. Either way they must stay on the
  // crew, so the membership is reconciled against that answer.
  const leaderId = payload.leaderId !== undefined
    ? payload.leaderId
    : (existing.leader_personnel_id
      ? String(existing.leader_personnel_id).trim().toUpperCase()
      : null);

  let memberIds = null;
  if (Array.isArray(payload.memberIds)) {
    memberIds = [...payload.memberIds];
    if (leaderId && !memberIds.includes(leaderId)) {
      memberIds = [...memberIds, leaderId];
    }
    if (memberIds.length < MINIMUM_TEAM_MEMBERS) {
      throw createHttpError(
        400,
        `A cleaning team needs at least ${MINIMUM_TEAM_MEMBERS} members.`
      );
    }
  }

  if (payload.parentTeamId === teamId) {
    throw createHttpError(400, 'A cleaning team cannot be its own parent.');
  }

  const updated = await cleaningTeamRepository.updateTeam(teamId, {
    teamName: payload.teamName,
    description: payload.description,
    parentTeamId: payload.parentTeamId,
    leaderPersonnelId: payload.leaderId,
    updatedByAdminId: adminId,
  });

  if (!updated) {
    throw createHttpError(404, 'Cleaning team not found.');
  }

  if (memberIds !== null) {
    await cleaningTeamRepository.replaceTeamMembers(teamId, memberIds, adminId);
  } else if (payload.leaderId !== undefined && leaderId) {
    // A leader was changed without a membership list: put the new leader on the
    // crew without disturbing the rest of it. Add is idempotent.
    await cleaningTeamRepository.addTeamMember(teamId, leaderId, adminId);
  }

  const members = await cleaningTeamRepository.listTeamMembers(teamId);
  return presentTeam(updated, members);
};

/**
 * Removes a team.
 *
 * Soft, like everything else in this schema: a team that was dispatched stays
 * readable on the reports it worked, and its id is never reused.
 */
const deleteCleaningTeam = async ({ teamId: rawTeamId, adminId = null }) => {
  const teamId = normalizeTeamId(rawTeamId);
  if (!teamId) {
    throw createHttpError(400, 'A cleaning team id is required.');
  }

  const removed = await cleaningTeamRepository.softDeleteTeam(teamId, adminId);
  if (!removed) {
    throw createHttpError(404, 'Cleaning team not found.');
  }

  return presentTeam(removed);
};

const listCleaningTeamMembers = async ({ teamId: rawTeamId }) => {
  const teamId = normalizeTeamId(rawTeamId);
  if (!teamId) {
    throw createHttpError(400, 'A cleaning team id is required.');
  }

  const team = await cleaningTeamRepository.findTeamById(teamId);
  if (!team || team.is_deleted === true) {
    throw createHttpError(404, 'Cleaning team not found.');
  }

  return cleaningTeamRepository.listTeamMembers(teamId);
};

const addCleaningTeamMember = async ({
  teamId: rawTeamId,
  personnelId,
  adminId = null,
}) => {
  const teamId = normalizeTeamId(rawTeamId);
  if (!teamId) {
    throw createHttpError(400, 'A cleaning team id is required.');
  }

  const team = await cleaningTeamRepository.findTeamById(teamId);
  if (!team || team.is_deleted === true) {
    throw createHttpError(404, 'Cleaning team not found.');
  }

  const personnel = await personnelRepository.findByPersonnelId(personnelId);
  if (!personnel) {
    throw createHttpError(404, 'Personnel account not found.');
  }

  await cleaningTeamRepository.addTeamMember(teamId, personnel.personnel_id, adminId);
  return cleaningTeamRepository.listTeamMembers(teamId);
};

const removeCleaningTeamMember = async ({
  teamId: rawTeamId,
  personnelId,
}) => {
  const teamId = normalizeTeamId(rawTeamId);
  if (!teamId) {
    throw createHttpError(400, 'A cleaning team id is required.');
  }

  const team = await cleaningTeamRepository.findTeamById(teamId);
  if (!team || team.is_deleted === true) {
    throw createHttpError(404, 'Cleaning team not found.');
  }

  await cleaningTeamRepository.removeTeamMember(teamId, personnelId);
  return cleaningTeamRepository.listTeamMembers(teamId);
};

/**
 * The teams one cleaner belongs to.
 *
 * The cleaner app shows this so a cleaner can see the crew they are part of
 * before they are dispatched.
 */
const listTeamsForPersonnel = async ({ personnelId }) => {
  const rows = await cleaningTeamRepository.listTeamsForPersonnel(personnelId);
  return rows.map((row) => presentTeam(row));
};

module.exports = {
  listCleaningTeams,
  getCleaningTeam,
  createCleaningTeam,
  updateCleaningTeam,
  deleteCleaningTeam,
  listCleaningTeamMembers,
  addCleaningTeamMember,
  removeCleaningTeamMember,
  listTeamsForPersonnel,
  presentTeam,
};

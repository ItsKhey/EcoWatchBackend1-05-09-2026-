// End-to-end test for the waste-scale dispatch chain.
//
// The feature is a chain: the resident picks a scale when filing, the
// administrator dispatches against it, and the crew and the truck that went
// out have to come back to the resident's own view. This test walks that whole
// chain against the real database, because every interesting failure in it
// lives in the interaction between the request, the report row, and the
// assignment rows -- none of which a unit test can see.

const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../src/config/db');
const reportRepository = require('../src/modules/reports/reportRepository');
const adminController = require('../src/modules/admin/adminController');
const reportController = require('../src/modules/reports/reportController');

const RESIDENT_ID = 'RES-SCALE-E2E';
const ADMIN_ID = 'ADM-SCALE-E2E';

const reportIds = [];
const personnelIds = [];
const vehicleIds = [];
const teamIds = [];

/** Minimal stand-in for the Express response used by the controllers. */
const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
  set() {
    return this;
  },
});

const runAdmin = async (handler, request) => {
  const res = createResponse();
  let forwarded = null;
  await handler(request, res, (error) => {
    forwarded = error;
  });
  if (forwarded) throw forwarded;
  return res;
};

const runResident = async (handler, request) => {
  const res = createResponse();
  let forwarded = null;
  await handler(request, res, (error) => {
    forwarded = error;
  });
  if (forwarded) throw forwarded;
  return res;
};

/**
 * Mirrors the status the error middleware will actually send, so the tests
 * assert the HTTP contract rather than an internal bookkeeping detail.
 */
const resolveStatus = (res, error) => {
  if (error && Number.isInteger(error.statusCode)) return error.statusCode;
  return res.statusCode === 200 ? 500 : res.statusCode;
};

/** Runs a resident handler and captures the response even when it fails. */
const runResidentRaw = async (handler, request) => {
  const res = createResponse();
  let forwarded = null;
  await handler(request, res, (error) => {
    forwarded = error;
  });
  return { res, error: forwarded };
};

const assignRequest = (reportId, body) => ({
  requestId: 'test-waste-scale-dispatch',
  params: { id: reportId },
  body,
  admin: { admin_id: ADMIN_ID },
});

const seedAdmin = () => pool.query(
  `INSERT INTO admins (admin_id, first_name, last_name, username, email, password_hash, role, is_verified)
   VALUES ($1, 'Scale', 'Tester', $2, $3, 'not-a-real-hash', 'ADMIN', true)
   ON CONFLICT (admin_id) DO NOTHING`,
  [ADMIN_ID, ADMIN_ID.toLowerCase(), `${ADMIN_ID.toLowerCase()}@gmail.com`]
);

const seedResident = () => pool.query(
  `INSERT INTO residents (
       resident_id, first_name, last_name, username, email,
       password_hash, role, status, is_verified
     )
   VALUES ($1, 'Scale', 'Reporter', $2, $3, 'not-a-real-hash', 'RESIDENT', 'AVAILABLE', true)
   ON CONFLICT (resident_id) DO NOTHING`,
  [RESIDENT_ID, RESIDENT_ID.toLowerCase(), `${RESIDENT_ID.toLowerCase()}@gmail.com`]
);

/** Two active personnel the crew can be made of. */
const seedPersonnel = async () => {
  const created = [];
  // A fresh tag per call, so the same account is never seeded twice.
  const tag = Math.random().toString(36).slice(2, 10);
  for (let index = 0; index < 2; index += 1) {
    const result = await pool.query(
      `INSERT INTO personnel_accounts (
           first_name, last_name, address, email, username, password_hash,
           role, status, enabled, occupation
         )
       VALUES ($1, $2, '', $3, $4, 'not-a-real-hash', 'PERSONNEL', 'OFFLINE', true, 'Regular')
       RETURNING personnel_id`,
      [
        'Crew',
        `Member${index}`,
        `scale.e2e.${tag}.member${index}@gmail.com`,
        `scale.e2e.${tag}.member${index}`,
      ]
    );
    created.push(result.rows[0].personnel_id);
  }
  personnelIds.push(...created);
  return created;
};

/** A truck sitting at the depot, ready to be sent. */
const seedVehicle = async () => {
  const tag = Math.random().toString(36).slice(2, 8).toUpperCase();
  const result = await pool.query(
    `INSERT INTO vehicles (plate_number, vehicle_type, status, is_deleted)
     VALUES ($1, 'Garbage Truck', 'Available', false)
     RETURNING vehicle_id`,
    [`SCALE-E2E-${tag}`]
  );
  vehicleIds.push(result.rows[0].vehicle_id);
  return result.rows[0].vehicle_id;
};

/**
 * A Driver account bound to one truck.
 *
 * <p>Deliberately not added to the cleaning team: the point of the regression
 * test below is that a large dispatch reaches the person who drives the truck
 * even when the crew roster does not name them.
 */
const seedDriver = async (vehicleId) => {
  const tag = Math.random().toString(36).slice(2, 10);
  const result = await pool.query(
    `INSERT INTO personnel_accounts (
         first_name, last_name, address, email, username, password_hash,
         role, status, enabled, occupation, assigned_vehicle_id
       )
     VALUES ($1, $2, '', $3, $4, 'not-a-real-hash', 'PERSONNEL', 'OFFLINE', true, 'Driver', $5)
     RETURNING personnel_id`,
    [
      'Truck',
      `Driver${tag}`,
      `scale.e2e.${tag}.driver@gmail.com`,
      `scale.e2e.${tag}.driver`,
      vehicleId,
    ]
  );
  personnelIds.push(result.rows[0].personnel_id);
  return result.rows[0].personnel_id;
};

/** A crew with both people on it. */
const seedTeam = async (members) => {
  const result = await pool.query(
    `INSERT INTO cleaning_teams (team_name, description, created_by_admin_id)
     VALUES ($1, $2, $3)
     RETURNING team_id`,
    ['Scale End-to-End Crew', 'Crew seeded for the dispatch test', ADMIN_ID]
  );
  const teamId = result.rows[0].team_id;
  teamIds.push(teamId);
  for (const personnelId of members) {
    await pool.query(
      `INSERT INTO cleaning_team_members (team_id, personnel_id, added_by_admin_id)
       VALUES ($1, $2, $3)`,
      [teamId, personnelId, ADMIN_ID]
    );
  }
  return teamId;
};

const seedReport = async (wasteScale) => {
  const reportId = `REP-SCALE${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  reportIds.push(reportId);
  const report = await reportRepository.createReport({
    reportId,
    residentId: RESIDENT_ID,
    title: 'Waste pile',
    category: 'Recyclable',
    description: 'A pile of waste on the corner.',
    latitude: 14.5995,
    longitude: 120.9842,
    wasteScale,
  });
  return report;
};

/** The resident's own view of their report. */
const residentView = async (reportId) => {
  const res = await runResident(reportController.getMyReports, {
    requestId: 'test-waste-scale-resident-view',
    body: {},
    resident: { residentId: RESIDENT_ID, role: 'RESIDENT' },
  });
  return res.body.find((report) => report.reportId === reportId) || null;
};

test.before(async () => {
  await seedAdmin();
  await seedResident();
});

test.after(async () => {
  await pool.query('DELETE FROM personnel_notifications WHERE report_id = ANY($1)', [reportIds]);
  await pool.query('DELETE FROM personnel_assignments WHERE report_id = ANY($1)', [reportIds]);
  await pool.query('DELETE FROM report_histories WHERE report_id = ANY($1)', [reportIds]);
  await pool.query('DELETE FROM reports WHERE report_id = ANY($1)', [reportIds]);
  await pool.query('DELETE FROM cleaning_team_members WHERE team_id = ANY($1)', [teamIds]);
  await pool.query('DELETE FROM cleaning_teams WHERE team_id = ANY($1)', [teamIds]);
  await pool.query('DELETE FROM vehicles WHERE vehicle_id = ANY($1)', [vehicleIds]);
  await pool.query('DELETE FROM personnel_accounts WHERE personnel_id = ANY($1)', [personnelIds]);
  await pool.query('DELETE FROM residents WHERE resident_id = $1', [RESIDENT_ID]);
  await pool.query('DELETE FROM admins WHERE admin_id = $1', [ADMIN_ID]);
  await pool.end();
});

test('a large job is dispatched to a crew with a truck, and the resident sees it', async () => {
  const [first, second] = await seedPersonnel();
  const vehicleId = await seedVehicle();
  const teamId = await seedTeam([first, second]);
  const report = await seedReport('Large-Scale Waste');

  const res = await runAdmin(adminController.assignPersonnel, assignRequest(report.report_id, {
    assignedPersonnelIds: [first, second],
    teamId,
    vehicleId,
    wasteScale: 'Large-Scale Waste',
    adminResponse: 'A crew and a truck are on the way.',
  }));

  assert.equal(res.statusCode, 200);

  // The report row carries the scale, the crew and the truck.
  const stored = await reportRepository.findByReportId(report.report_id);
  assert.equal(stored.waste_scale, 'Large-Scale Waste');
  assert.equal(stored.assigned_team_id, teamId);
  assert.equal(stored.assigned_vehicle_id, vehicleId);
  assert.equal(stored.assigned_personnel_id, null, 'a crew has no single pointer');
  assert.deepEqual(
    [...(stored.assigned_personnel_ids || [])].sort(),
    [first, second].sort()
  );

  // The truck followed the report.
  const vehicle = await pool.query(
    'SELECT status, current_report_id FROM vehicles WHERE vehicle_id = $1',
    [vehicleId]
  );
  assert.equal(vehicle.rows[0].status, 'Assigned');
  assert.equal(vehicle.rows[0].current_report_id, report.report_id);

  // And the resident can see who turned out.
  const view = await residentView(report.report_id);
  assert.ok(view, 'the report is in the resident list');
  assert.equal(view.wasteScale, 'Large-Scale Waste');
  assert.equal(view.assignedTeamName, 'Scale End-to-End Crew');
  assert.equal(view.assignedVehicleId, vehicleId);
  assert.ok(view.assignedVehiclePlateNumber, 'the truck is identified');
  assert.equal(view.assignedVehicleType, 'Garbage Truck');

  // The crew is named, not just numbered: the resident gets the people by
  // their full names, which is what the details dialog puts on their cards.
  assert.equal(view.assignedCrew.length, 2, 'the resident sees the whole crew');
  assert.deepEqual(
    view.assignedCrew.map((member) => member.fullName).sort(),
    ['Crew Member0', 'Crew Member1']
  );
  assert.deepEqual(
    view.assignedCrew.map((member) => member.personnelId).sort(),
    [first, second].sort()
  );
});

test('the truck driver is assigned and notified even when the crew does not name them', async () => {
  const [first, second] = await seedPersonnel();
  const vehicleId = await seedVehicle();
  const driverId = await seedDriver(vehicleId);
  const teamId = await seedTeam([first, second]);
  const report = await seedReport('Large-Scale Waste');

  const res = await runAdmin(adminController.assignPersonnel, assignRequest(report.report_id, {
    assignedPersonnelIds: [first, second],
    teamId,
    vehicleId,
    wasteScale: 'Large-Scale Waste',
    adminResponse: 'A crew and a truck are on the way.',
  }));

  assert.equal(res.statusCode, 200);

  // The driver travels with the truck: they are part of the dispatch even
  // though the admin only picked the cleaning team.
  const stored = await reportRepository.findByReportId(report.report_id);
  assert.ok(
    stored.assigned_personnel_ids.includes(driverId),
    'the driver is written into the report crew'
  );

  const assignment = await pool.query(
    `SELECT assigned_vehicle_id, waste_scale, status
       FROM personnel_assignments
      WHERE report_id = $1
        AND personnel_id = $2`,
    [report.report_id, driverId]
  );
  assert.equal(assignment.rowCount, 1, 'the driver gets a task of their own');
  assert.equal(assignment.rows[0].status, 'ASSIGNED');
  assert.equal(assignment.rows[0].assigned_vehicle_id, vehicleId);
  assert.equal(assignment.rows[0].waste_scale, 'Large-Scale Waste');

  // And the same ASSIGNMENT_ASSIGNED notice every crew member receives.
  const notices = await pool.query(
    `SELECT title, message
       FROM personnel_notifications
      WHERE personnel_id = $1
        AND report_id = $2
        AND type = 'ASSIGNMENT_ASSIGNED'`,
    [driverId, report.report_id]
  );
  assert.equal(notices.rowCount, 1, 'the driver is notified exactly once');
  assert.equal(notices.rows[0].title, 'New Cleaning Task');
  assert.match(notices.rows[0].message, /Waste pile/);

  // Adding the driver must not cost the cleaners their own notices.
  const crewNotices = await pool.query(
    `SELECT personnel_id
       FROM personnel_notifications
      WHERE personnel_id = ANY($1)
        AND report_id = $2
        AND type = 'ASSIGNMENT_ASSIGNED'`,
    [[first, second], report.report_id]
  );
  assert.deepEqual(
    crewNotices.rows.map((row) => row.personnel_id).sort(),
    [first, second].sort()
  );

  // The driver is marked busy so a second dispatch cannot double-book them.
  const account = await pool.query(
    `SELECT current_assignment_report_id, occupation
       FROM personnel_accounts
      WHERE personnel_id = $1`,
    [driverId]
  );
  assert.equal(account.rows[0].current_assignment_report_id, report.report_id);
  assert.equal(account.rows[0].occupation, 'Driver');
});

test('a request cannot scale a large job down to dodge the crew and the truck', async () => {
  const [first] = await seedPersonnel();
  const report = await seedReport('Large-Scale Waste');

  // The client asks for the small scale so a single cleaner will do.
  await assert.rejects(
    () => runAdmin(adminController.assignPersonnel, assignRequest(report.report_id, {
      personnelId: first,
      wasteScale: 'Small-Scale Waste',
      adminResponse: 'One cleaner will take care of it.',
    })),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /cleaning team|collection vehicle/i);
      return true;
    }
  );

  // The report kept the scale the resident filed it under.
  const stored = await reportRepository.findByReportId(report.report_id);
  assert.equal(stored.waste_scale, 'Large-Scale Waste');
  assert.equal(stored.assigned_personnel_id, null, 'nothing was dispatched');
});

test('a medium job is dispatched to a crew and refuses a truck', async () => {
  const [first, second] = await seedPersonnel();
  const vehicleId = await seedVehicle();
  const teamId = await seedTeam([first, second]);
  const report = await seedReport('Medium-Scale Waste');

  await assert.rejects(
    () => runAdmin(adminController.assignPersonnel, assignRequest(report.report_id, {
      assignedPersonnelIds: [first, second],
      teamId,
      vehicleId,
      wasteScale: 'Medium-Scale Waste',
      adminResponse: 'A crew is on the way.',
    })),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /without a collection vehicle/i);
      return true;
    }
  );

  // Without the truck, the same crew is dispatched.
  const res = await runAdmin(adminController.assignPersonnel, assignRequest(report.report_id, {
    assignedPersonnelIds: [first, second],
    teamId,
    wasteScale: 'Medium-Scale Waste',
    adminResponse: 'A crew is on the way.',
  }));

  assert.equal(res.statusCode, 200);
  const stored = await reportRepository.findByReportId(report.report_id);
  assert.equal(stored.assigned_team_id, teamId);
  assert.equal(stored.assigned_vehicle_id, null, 'a medium job takes no truck');
});

test('a small job is dispatched to one person and refuses a crew', async () => {
  const [first, second] = await seedPersonnel();
  const teamId = await seedTeam([first, second]);
  const report = await seedReport('Small-Scale Waste');

  await assert.rejects(
    () => runAdmin(adminController.assignPersonnel, assignRequest(report.report_id, {
      assignedPersonnelIds: [first, second],
      teamId,
      wasteScale: 'Small-Scale Waste',
      adminResponse: 'A crew is on the way.',
    })),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /cleaning team/i);
      return true;
    }
  );

  const res = await runAdmin(adminController.assignPersonnel, assignRequest(report.report_id, {
    personnelId: first,
    wasteScale: 'Small-Scale Waste',
    adminResponse: 'One cleaner will take care of it.',
  }));

  assert.equal(res.statusCode, 200);
  const stored = await reportRepository.findByReportId(report.report_id);
  assert.equal(stored.assigned_personnel_id, first);
  assert.equal(stored.assigned_team_id, null);
  assert.equal(stored.assigned_vehicle_id, null);

  // The second person was never sent.
  const assignments = await pool.query(
    'SELECT personnel_id FROM personnel_assignments WHERE report_id = $1',
    [report.report_id]
  );
  assert.deepEqual(
    assignments.rows.map((row) => row.personnel_id),
    [first]
  );
});

test('a crew may not be made of people who are not on the crew', async () => {
  const [first, second] = await seedPersonnel();
  const [outsider] = await seedPersonnel();
  const teamId = await seedTeam([first]);
  const report = await seedReport('Medium-Scale Waste');

  await assert.rejects(
    () => runAdmin(adminController.assignPersonnel, assignRequest(report.report_id, {
      assignedPersonnelIds: [first, outsider],
      teamId,
      wasteScale: 'Medium-Scale Waste',
      adminResponse: 'A crew is on the way.',
    })),
    (error) => {
      assert.equal(error.statusCode, 400);
      return true;
    }
  );

  // The crew was too small to begin with, and the outsider is not on it.
  const stored = await reportRepository.findByReportId(report.report_id);
  assert.equal(stored.assigned_personnel_id, null, 'nothing was dispatched');
  assert.equal(stored.assigned_team_id, null);
});

test('the scale is settled once a crew is on the job', async () => {
  const [first, second] = await seedPersonnel();
  const vehicleId = await seedVehicle();
  const teamId = await seedTeam([first, second]);
  const report = await seedReport('Large-Scale Waste');

  await runAdmin(adminController.assignPersonnel, assignRequest(report.report_id, {
    assignedPersonnelIds: [first, second],
    teamId,
    vehicleId,
    wasteScale: 'Large-Scale Waste',
    adminResponse: 'A crew is on the way.',
  }));

  // Relabelling the report now would contradict the crew that went out.
  const refusal = await runResidentRaw(reportController.updateReport, {
    requestId: 'test-waste-scale-settled',
    params: { id: report.report_id },
    body: { wasteScale: 'Small-Scale Waste' },
    resident: { residentId: RESIDENT_ID, role: 'RESIDENT' },
  });
  assert.equal(resolveStatus(refusal.res, refusal.error), 400);
  assert.match(refusal.error.message, /cannot be changed once a cleanup crew/i);

  const stored = await reportRepository.findByReportId(report.report_id);
  assert.equal(stored.waste_scale, 'Large-Scale Waste');
});

test('a report that is being cleaned can still be edited', async () => {
  const [first, second] = await seedPersonnel();
  const vehicleId = await seedVehicle();
  const teamId = await seedTeam([first, second]);
  const report = await seedReport('Large-Scale Waste');

  await runAdmin(adminController.assignPersonnel, assignRequest(report.report_id, {
    assignedPersonnelIds: [first, second],
    teamId,
    vehicleId,
    wasteScale: 'Large-Scale Waste',
    adminResponse: 'A crew is on the way.',
  }));

  // The resident app sends the scale on every edit, so an ordinary edit has to
  // go through even though the report is being cleaned.
  const res = await runResident(reportController.updateReport, {
    requestId: 'test-waste-scale-edit',
    params: { id: report.report_id },
    body: {
      description: 'The pile grew overnight.',
      wasteScale: 'Large-Scale Waste',
    },
    resident: { residentId: RESIDENT_ID, role: 'RESIDENT' },
  });

  assert.equal(res.statusCode, 200);
  const stored = await reportRepository.findByReportId(report.report_id);
  assert.equal(stored.description, 'The pile grew overnight.');
  assert.equal(stored.waste_scale, 'Large-Scale Waste');
});

test('a medium job is dispatched to an ad hoc crew with no named team', async () => {
  const [first, second] = await seedPersonnel();
  const report = await seedReport('Medium-Scale Waste');

  // The administrator bulk-selected two personnel cards; no preset team was
  // picked, so the crew exists only as the selection itself.
  const res = await runAdmin(adminController.assignPersonnel, assignRequest(report.report_id, {
    assignedPersonnelIds: [first, second],
    wasteScale: 'Medium-Scale Waste',
    adminResponse: 'An ad hoc crew is on the way.',
  }));

  assert.equal(res.statusCode, 200);

  const stored = await reportRepository.findByReportId(report.report_id);
  assert.equal(stored.waste_scale, 'Medium-Scale Waste');
  assert.equal(stored.assigned_team_id, null, 'an ad hoc crew has no named team');
  assert.equal(stored.assigned_personnel_id, null, 'a crew has no single pointer');
  assert.deepEqual(
    [...(stored.assigned_personnel_ids || [])].sort(),
    [first, second].sort()
  );

  // The resident sees who turned out, just without a team name.
  const view = await residentView(report.report_id);
  assert.ok(view, 'the report is in the resident list');
  assert.ok(
    view.assignedTeamName == null,
    'there is no team name behind an ad hoc crew'
  );

  // The people are still named. An ad hoc crew has no team behind it, but the
  // resident still sees who came.
  assert.equal(view.assignedCrew.length, 2, 'the resident sees the whole crew');
  assert.deepEqual(
    view.assignedCrew.map((member) => member.fullName).sort(),
    ['Crew Member0', 'Crew Member1']
  );
});

test('an ad hoc crew still has to meet the minimum size', async () => {
  const [first] = await seedPersonnel();
  const report = await seedReport('Medium-Scale Waste');

  await assert.rejects(
    () => runAdmin(adminController.assignPersonnel, assignRequest(report.report_id, {
      assignedPersonnelIds: [first],
      wasteScale: 'Medium-Scale Waste',
      adminResponse: 'One person for a medium job?',
    })),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /at least 2 personnel/i);
      return true;
    }
  );

  const stored = await reportRepository.findByReportId(report.report_id);
  assert.equal(stored.assigned_personnel_id, null, 'nothing was dispatched');
});

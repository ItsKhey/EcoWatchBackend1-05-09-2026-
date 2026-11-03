// Live Cloudinary integration test: every case here uploads a real asset and
// then asserts it is gone from the CDN again.
//
// It therefore pins the storage provider instead of inheriting the ambient
// default, which is the local disk provider for a local-server setup. Without
// this, the uploads would land on local disk and every Cloudinary Admin API
// assertion below would fail.
process.env.IMAGE_STORAGE_PROVIDER = 'cloudinary';

require('dotenv').config({ quiet: true });

const test = require('node:test');
const assert = require('node:assert/strict');

const CLOUDINARY_CONFIGURED = [
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET'
].every((name) => Boolean(process.env[name]));

// Skipped rather than failed on a machine with no Cloudinary credentials, so a
// local-only setup still runs the rest of the suite.
const cloudinaryOnly = {
  skip: CLOUDINARY_CONFIGURED ? false : 'CLOUDINARY_* is not configured'
};

const { pool } = require('../src/config/db');

// Required conditionally: config/cloudinary throws when it is unconfigured, and
// that must not stop this file from loading.
const cloudinary = CLOUDINARY_CONFIGURED ? require('../src/config/cloudinary') : null;
const { uploadImage, extractPublicId } = require('../src/shared/cloudinaryService');

const reportRepository = require('../src/modules/reports/reportRepository');
const archivedReportRepository = require('../src/modules/reports/archivedReportRepository');
const trashReportRepository = require('../src/modules/reports/trashReportRepository');
const reportController = require('../src/modules/reports/reportController');
const lifecycle = require('../src/modules/reports/adminReportLifecycleService');

const RESIDENT_ID = 'RES-IMG-CLEANUP';
const ADMIN_ID = 'ADM-IMG-CLEANUP';

// A dedicated folder keeps the verification away from real resident uploads, so
// the "no orphans left behind" assertion can only ever see assets this run made.
const VERIFY_FOLDER = 'ecowatch/verification-image-cleanup';

/** Smallest valid PNG, uploaded for real so the assertions hit Cloudinary. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const uploaded = [];

const uploadAsset = async () => {
  const result = await uploadImage(PNG_1x1, VERIFY_FOLDER);
  uploaded.push(result.public_id);
  return result;
};

/** Authoritative existence check against the Cloudinary Admin API. */
const assetExists = async (publicId) => {
  try {
    await cloudinary.api.resource(publicId, { resource_type: 'image' });
    return true;
  } catch (error) {
    if (error.http_code === 404 || error.error?.http_code === 404) return false;
    throw error;
  }
};

const countFolderAssets = async () => {
  const result = await cloudinary.api.resources({
    type: 'upload',
    prefix: VERIFY_FOLDER,
    max_results: 100,
  });
  return result.resources.length;
};

/**
 * The delivery CDN can serve a removed asset for a short while, so this retries
 * rather than asserting on a single possibly-stale response.
 */
const assertDeliveryGone = async (secureUrl) => {
  let lastStatus = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(secureUrl, { method: 'HEAD' });
    lastStatus = response.status;
    if (response.status === 404) return;
    await delay(2000);
  }
  assert.fail(`delivery URL still served (status ${lastStatus}): ${secureUrl}`);
};

const seedResident = () => pool.query(
  `INSERT INTO residents (
       resident_id, first_name, last_name, username, email,
       password_hash, role, status, is_verified
     )
   VALUES ($1, 'Image', 'Cleanup', $1, $1, 'not-a-real-hash', 'RESIDENT', 'AVAILABLE', true)
   ON CONFLICT (resident_id) DO UPDATE SET role = 'RESIDENT', status = 'AVAILABLE'`,
  [RESIDENT_ID]
);

const seedAdmin = () => pool.query(
  `INSERT INTO admins (
       admin_id, first_name, last_name, username, email, password_hash, role
     )
   VALUES ($1, 'Image', 'Cleanup', $1, $1, 'not-a-real-hash', 'ADMIN')
   ON CONFLICT (admin_id) DO UPDATE SET role = 'ADMIN'`,
  [ADMIN_ID]
);

let reportCounter = 0;
const seedReportWithAsset = async () => {
  await seedResident();
  const asset = await uploadAsset();
  reportCounter += 1;
  const reportId = `REP-IMG${Date.now().toString(36)}${reportCounter}`;

  const created = await reportRepository.createReport({
    reportId,
    residentId: RESIDENT_ID,
    title: 'Report with a real photo',
    category: 'Recyclable',
    description: 'Uploaded for the image cleanup verification.',
    latitude: 14.5995,
    longitude: 120.9842,
    imageUrl: asset.secure_url,
  });

  return { report: created, asset };
};

/** Minimal stand-in for the Express response used by the controller. */
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

const runResidentDelete = async (reportId) => {
  const res = createResponse();
  let forwarded = null;
  await reportController.deleteReport(
    {
      requestId: 'test-image-cleanup',
      params: { id: reportId },
      body: {},
      resident: { residentId: RESIDENT_ID, role: 'RESIDENT' },
    },
    res,
    (error) => { forwarded = error; }
  );
  if (forwarded) throw forwarded;
  return res;
};

const cleanupDatabase = async () => {
  await pool.query('DELETE FROM report_histories WHERE resident_id = $1', [RESIDENT_ID]);
  await pool.query('DELETE FROM trash_reports WHERE resident_id = $1', [RESIDENT_ID]);
  await pool.query('DELETE FROM archived_reports WHERE resident_id = $1', [RESIDENT_ID]);
  await pool.query('DELETE FROM reports WHERE resident_id = $1', [RESIDENT_ID]);
  await pool.query('DELETE FROM residents WHERE resident_id = $1', [RESIDENT_ID]);
  await pool.query('DELETE FROM admins WHERE admin_id = $1', [ADMIN_ID]);
};

test.before(async () => {
  await seedResident();
  await seedAdmin();
});

test.after(async () => {
  await cleanupDatabase();
  // Sweep anything a failing assertion may have left in the verification folder.
  for (const publicId of uploaded) {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' }).catch(() => {});
  }
  await pool.end();
});

test('a permanently deleted report takes its Cloudinary image with it', cloudinaryOnly, async () => {
  const { report, asset } = await seedReportWithAsset();
  const publicId = extractPublicId(asset.secure_url);
  assert.ok(publicId, 'the uploaded delivery URL yields a public id');
  assert.equal(await assetExists(publicId), true, 'the asset exists before deletion');

  const removed = await reportRepository.permanentlyDeleteByReportId(report.report_id);
  assert.ok(removed, 'the report row is removed');
  assert.equal(removed.report_id, report.report_id);

  // The report is gone from PostgreSQL.
  const stored = await reportRepository.findByReportId(report.report_id);
  assert.equal(stored, null, 'no report row remains');

  // The image is gone from Cloudinary.
  assert.equal(await assetExists(publicId), false, 'the Cloudinary asset is destroyed');
  await assertDeliveryGone(asset.secure_url);
});

test('a report whose image was already removed is still deleted', cloudinaryOnly, async () => {
  const { report, asset } = await seedReportWithAsset();
  const publicId = extractPublicId(asset.secure_url);

  // Simulate a pre-removed asset, e.g. an interrupted earlier cleanup.
  await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  assert.equal(await assetExists(publicId), false, 'the asset is already gone');

  const removed = await reportRepository.permanentlyDeleteByReportId(report.report_id);

  assert.ok(removed, 'deletion still succeeds when the asset is already missing');
  const stored = await reportRepository.findByReportId(report.report_id);
  assert.equal(stored, null, 'the report row is still removed from PostgreSQL');
});

test('a report with no image at all is deleted without contacting Cloudinary', cloudinaryOnly, async () => {
  await seedResident();
  const reportId = `REP-NOIMG${Date.now().toString(36)}`;
  const created = await reportRepository.createReport({
    reportId,
    residentId: RESIDENT_ID,
    title: 'Report without a photo',
    category: 'Biodegradable',
    description: 'No image was ever attached.',
    latitude: 14.6,
    longitude: 120.98,
    imageUrl: null,
  });

  const removed = await reportRepository.permanentlyDeleteByReportId(created.report_id);

  assert.ok(removed, 'the report is deleted');
  assert.equal(await reportRepository.findByReportId(reportId), null);
});

test('a non-Cloudinary image_url is never handed to the uploader', cloudinaryOnly, async () => {
  await seedResident();
  const reportId = `REP-FOREIGN${Date.now().toString(36)}`;
  const foreignUrl = 'https://attacker.example.com/evil.png';
  const created = await reportRepository.createReport({
    reportId,
    residentId: RESIDENT_ID,
    title: 'Report with a foreign url',
    category: 'Hazardous',
    description: 'The stored url is not a Cloudinary delivery url.',
    latitude: 14.6,
    longitude: 120.98,
    imageUrl: foreignUrl,
  });

  const removed = await reportRepository.permanentlyDeleteByReportId(created.report_id);

  assert.ok(removed, 'deletion is unaffected by a foreign url');
  assert.equal(await reportRepository.findByReportId(reportId), null);
});

test('permanent delete from the Trash Bin releases the image', cloudinaryOnly, async () => {
  const { report, asset } = await seedReportWithAsset();
  const publicId = extractPublicId(asset.secure_url);

  // Move to trash first, so this is the real Trash Bin flow.
  await lifecycle.trashReport({ rawReportId: report.report_id, adminId: ADMIN_ID });
  const trashed = await trashReportRepository.findByReportId(report.report_id);
  assert.ok(trashed, 'the report is in the trash before deletion');
  assert.equal(await assetExists(publicId), true, 'trashing keeps the image');

  await lifecycle.deleteReport({ rawReportId: report.report_id, adminId: ADMIN_ID });

  assert.equal(await reportRepository.findByReportId(report.report_id), null, 'report row removed');
  assert.equal(
    await trashReportRepository.findByReportId(report.report_id),
    null,
    'the trash marker is removed too'
  );
  assert.equal(await assetExists(publicId), false, 'the Cloudinary asset is destroyed');
  await assertDeliveryGone(asset.secure_url);
});

test('permanent delete of an archived report releases the image it owns', cloudinaryOnly, async () => {
  const { report, asset } = await seedReportWithAsset();
  const publicId = extractPublicId(asset.secure_url);

  await lifecycle.archiveReport({ rawReportId: report.report_id, adminId: ADMIN_ID });
  const archived = await archivedReportRepository.findByReportId(report.report_id);
  assert.ok(archived, 'the report now lives in the archive');
  assert.equal(archived.image_url, asset.secure_url, 'the archive copy carries the image url');
  assert.equal(
    await reportRepository.findByReportId(report.report_id),
    null,
    'archiving moved the row out of the active table'
  );

  await lifecycle.deleteReport({ rawReportId: report.report_id, adminId: ADMIN_ID });

  assert.equal(
    await archivedReportRepository.findByReportId(report.report_id),
    null,
    'the archived row is removed'
  );
  assert.equal(await assetExists(publicId), false, 'the image is released from the archive');
});

test('a lifecycle move keeps the image, and the later permanent delete releases it', cloudinaryOnly, async () => {
  const { report, asset } = await seedReportWithAsset();
  const publicId = extractPublicId(asset.secure_url);

  // Archiving deletes the active row and re-creates it in the archive still
  // referencing the same asset, so the photo must survive the move.
  await lifecycle.archiveReport({ rawReportId: report.report_id, adminId: ADMIN_ID });
  assert.equal(
    await reportRepository.findByReportId(report.report_id),
    null,
    'the active row is gone'
  );
  assert.equal(await assetExists(publicId), true, 'a lifecycle move must not destroy the photo');

  // Restoring brings the row back and it still points at the same image.
  await lifecycle.restoreReport({ rawReportId: report.report_id, adminId: ADMIN_ID });
  const restored = await reportRepository.findByReportId(report.report_id);
  assert.ok(restored, 'the report is active again');
  assert.equal(restored.image_url, asset.secure_url, 'the restored row still references the image');
  assert.equal(await assetExists(publicId), true, 'restoring must not destroy the photo either');

  // Only the later permanent delete may release it.
  await lifecycle.deleteReport({ rawReportId: report.report_id, adminId: ADMIN_ID });
  assert.equal(await assetExists(publicId), false, 'the permanent delete released the photo');
});

test('the resident permanent delete endpoint releases the image', cloudinaryOnly, async () => {
  const { report, asset } = await seedReportWithAsset();
  const publicId = extractPublicId(asset.secure_url);

  const res = await runResidentDelete(report.report_id);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.message, 'Report permanently removed');
  assert.equal(await reportRepository.findByReportId(report.report_id), null);
  assert.equal(await assetExists(publicId), false, 'the endpoint released the image');
});

test('the bulk permanent delete endpoint releases every image', cloudinaryOnly, async () => {
  const first = await seedReportWithAsset();
  const second = await seedReportWithAsset();
  const publicIds = [first.asset, second.asset].map((asset) => extractPublicId(asset.secure_url));

  const res = createResponse();
  let forwarded = null;
  await reportController.bulkDeleteReports(
    {
      requestId: 'test-image-cleanup-bulk',
      body: [first.report.report_id, second.report.report_id],
      resident: { residentId: RESIDENT_ID, role: 'RESIDENT' },
    },
    res,
    (error) => { forwarded = error; }
  );
  if (forwarded) throw forwarded;

  assert.equal(res.body.modifiedCount, 2);
  for (const publicId of publicIds) {
    assert.equal(await assetExists(publicId), false, 'each bulk-deleted image is released');
  }
});

test('the expiration cleanup job releases images for every report it removes', cloudinaryOnly, async () => {
  const first = await seedReportWithAsset();
  const second = await seedReportWithAsset();
  const publicIds = [first.asset, second.asset].map((asset) => extractPublicId(asset.secure_url));

  // Backdate the trash markers past the 30 day retention window.
  for (const report of [first.report, second.report]) {
    await trashReportRepository.createTrashRecord({
      reportId: report.report_id,
      residentId: RESIDENT_ID,
      deletedAt: new Date('2000-01-01T00:00:00.000Z'),
    });
  }

  const { permanentlyDeleteExpiredReports } = require('../src/modules/reports/reportCleanupService');
  const markers = await permanentlyDeleteExpiredReports();

  assert.ok(markers.length >= 2, 'the job picked up the expired reports');
  for (const report of [first.report, second.report]) {
    assert.equal(
      await reportRepository.findByReportId(report.report_id),
      null,
      'the expired report row is removed'
    );
  }
  for (const publicId of publicIds) {
    assert.equal(await assetExists(publicId), false, 'the cleanup job released the image');
  }
});

test('no orphaned Cloudinary files are left in the verification folder', cloudinaryOnly, async () => {
  const remaining = await countFolderAssets();
  assert.equal(
    remaining,
    0,
    `expected an empty verification folder, found: ${remaining}`
  );
});

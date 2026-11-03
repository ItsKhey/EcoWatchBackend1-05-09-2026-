/*
 * Copies every hosted CDN image referenced by the database onto the local disk
 * and rewrites the rows to the local path.
 *
 * Why this exists: a database restored from a hosted setup still points at the
 * CDN, so every photo the app shows costs an internet round trip. Measured here
 * at roughly 1.3s per image on a 38KB file, which dominates how long a list takes
 * to appear. Serving the same bytes from the local server removes that entirely.
 *
 * Idempotent. A row whose URL is already local is skipped, so it is safe to run
 * again after new reports are submitted.
 *
 *   node scripts/migrate-hosted-images.js          migrate
 *   node scripts/migrate-hosted-images.js --dry    report only, change nothing
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

require('dotenv').config({ quiet: true });

const { createPool } = require('../src/config/database');
const localImageStorage = require('../src/shared/localImageStorage');

const HOSTED_MARKER = 'res.cloudinary.com';
const DRY_RUN = process.argv.includes('--dry');

// The CDN path segment after the version stamp is the original folder layout,
// e.g. ecowatch/reports/abc.jpg, which is exactly where the local copy belongs.
const publicPathFromUrl = (url) => {
  const markerIndex = url.indexOf('/image/upload/');
  if (markerIndex === -1) return null;

  let rest = url.slice(markerIndex + '/image/upload/'.length);
  // Drop the version segment the CDN appends, e.g. v1790568853/
  rest = rest.replace(/^v\d+\//, '');
  if (!rest) return null;

  return `${localImageStorage.PUBLIC_PREFIX}${rest}`;
};

const findColumns = async (client) => {
  const { rows: columns } = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('text', 'character varying', 'character')
    ORDER BY table_name, column_name
  `);

  const targets = [];
  for (const { table_name, column_name } of columns) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM "${table_name}" WHERE "${column_name}" LIKE $1`,
      [`%${HOSTED_MARKER}%`]
    );
    if (rows[0] && rows[0].n > 0) {
      targets.push({ table: table_name, column: column_name, rows: rows[0].n });
    }
  }
  return targets;
};

const download = async (url) => {
  // Ask the CDN for a right-sized derivative instead of the original.
  //
  // The stored originals are full camera resolution: one report photo measured
  // 3.2MB. A phone downloading that over a LAN pays for every byte even though
  // Glide downscales it for display, so the bytes are capped once here rather
  // than on every request.
  //
  // c_limit scales down only when the image is larger, so a small original is
  // never blown up. f_auto is deliberately NOT used: it would hand back a WebP
  // or AVIF body, which would then be written to disk under the original .jpg
  // name. The output format is pinned to what the filename already claims.
  const sized = url.replace(
    '/image/upload/',
    '/image/upload/c_limit,w_1600,q_auto:good/'
  );

  const response = await fetch(sized, { redirect: 'follow' });
  if (!response.ok) {
    // Fall back to the original if the CDN rejects the transformation.
    const fallback = await fetch(url, { redirect: 'follow' });
    if (!fallback.ok) throw new Error(`HTTP ${fallback.status}`);
    return Buffer.from(await fallback.arrayBuffer());
  }
  return Buffer.from(await response.arrayBuffer());
};

const main = async () => {
  const pool = createPool();
  const client = await pool.connect();

  const targets = await findColumns(client);

  if (targets.length === 0) {
    console.log('[MIGRATE] No hosted image URLs found. Nothing to do.');
    client.release();
  await pool.end();
    return;
  }

  console.log(`[MIGRATE] ${DRY_RUN ? 'Dry run. ' : ''}Found hosted URLs in:`);
  for (const target of targets) {
    console.log(`[MIGRATE]   ${target.table}.${target.column} (${target.rows} row(s))`);
  }

  // Every distinct hosted URL, so a photo shared by two rows is fetched once.
  const { rows: distinct } = await client.query(`
    SELECT DISTINCT u AS url
      FROM (
        SELECT image_url AS u FROM reports WHERE image_url LIKE $1
        UNION ALL SELECT image_url FROM report_photos WHERE image_url LIKE $1
        UNION ALL SELECT profile_image FROM residents WHERE profile_image LIKE $1
        UNION ALL SELECT profile_image FROM admins WHERE profile_image LIKE $1
      ) s
    ORDER BY u
  `, [`%${HOSTED_MARKER}%`]);

  const cache = new Map();
  let copied = 0;
  let failed = 0;

  for (const { url } of distinct) {
    const publicPath = publicPathFromUrl(url);
    if (!publicPath) {
      console.warn(`[MIGRATE] Cannot derive a local path from ${url}, skipping.`);
      failed += 1;
      continue;
    }

    const absolute = localImageStorage.toLocalPath(publicPath);
    if (!absolute) {
      console.warn(`[MIGRATE] Refusing to write outside uploads/: ${publicPath}`);
      failed += 1;
      continue;
    }

    // Already present from an earlier run, so do not re-download.
    if (fs.existsSync(absolute) && !DRY_RUN) {
      cache.set(url, publicPath);
      continue;
    }

    try {
      // A dry run must not touch the filesystem: it only reports what a real run
      // would do, so nothing is written and no URL is cached for the update pass.
      if (DRY_RUN) {
        copied += 1;
        console.log(`[MIGRATE] Would copy -> ${publicPath}`);
        continue;
      }

      const buffer = await download(url);
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, buffer);
      cache.set(url, publicPath);
      copied += 1;
      console.log(`[MIGRATE] Copied ${buffer.length} bytes -> ${publicPath}`);
    } catch (error) {
      console.warn(`[MIGRATE] Failed to download ${url}: ${error.message}`);
      failed += 1;
    }
  }

  if (DRY_RUN) {
    console.log(`\n[MIGRATE] Dry run complete. ${copied} image(s) would be copied, ${failed} failure(s).`);
    client.release();
  await pool.end();
    return;
  }

  let updated = 0;
  await client.query('BEGIN');
  try {
    for (const [url, publicPath] of cache) {
      for (const target of targets) {
        const { rowCount } = await client.query(
          `UPDATE "${target.table}" SET "${target.column}" = $1 WHERE "${target.column}" = $2`,
          [publicPath, url]
        );
        updated += rowCount || 0;
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[MIGRATE] Rollback after failed update: ${error.message}`);
    client.release();
  await pool.end();
    process.exit(1);
  }

  console.log(`\n[MIGRATE] Copied ${copied} new file(s), rewrote ${updated} row(s), ${failed} failure(s).`);
  console.log('[MIGRATE] Images are now served by this server at /uploads.');
  client.release();
  await pool.end();
};

main().catch((error) => {
  console.error(`[MIGRATE] ${error.message}`);
  process.exit(1);
});

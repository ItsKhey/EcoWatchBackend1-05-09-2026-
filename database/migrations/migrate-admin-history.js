/**
 * Migration runner for the administrator-facing history columns.
 * Executes migration/sql/024-admin-history.sql against the PostgreSQL database.
 *
 * Usage: node migration/migrate-admin-history.js
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const { pool } = require('../../src/config/db');

const EXPECTED_CATEGORIES = ['REPORTS', 'ASSIGNMENTS', 'CLEANING', 'ANNOUNCEMENTS', 'ACCOUNT'];

const EXPECTED_COLUMNS = [
  'admin_id',
  'category',
  'subject_type',
  'subject_id',
  'subject_label',
];

async function migrate() {
  const client = await pool.connect();

  try {
    // Same advisory-lock convention as the other migration runners, so two
    // concurrent starts cannot both attempt the ALTERs.
    const lockId = 15024;
    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock($1) AS acquired',
      [lockId]
    );

    if (!lockResult.rows[0].acquired) {
      console.log('[MIGRATION] Another instance is running this migration. Skipping.');
      return;
    }

    const migrationPath = path.join(__dirname, 'sql', '024-admin-history.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    console.log('[MIGRATION] Running 024-admin-history.sql...');
    await client.query(sql);
    console.log('[MIGRATION] Successfully applied 024-admin-history.sql');

    await verifyColumns(client);
    await verifyConstraint(client);
    await verifyIndexes(client);
    await reportBackfill(client);
  } catch (error) {
    console.error('[MIGRATION] Failed:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

async function verifyColumns(client) {
  const result = await client.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'report_histories'
      AND column_name = ANY($1)
    ORDER BY column_name
    `,
    [EXPECTED_COLUMNS]
  );

  const present = result.rows.map((row) => row.column_name);
  const missing = EXPECTED_COLUMNS.filter((name) => !present.includes(name));

  if (missing.length > 0) {
    throw new Error(`Columns missing after migration: ${missing.join(', ')}`);
  }

  console.log('[MIGRATION] Columns present:', present.join(', '));
}

async function verifyConstraint(client) {
  const result = await client.query(
    `
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conname = 'report_histories_category_ck'
    `
  );

  if (result.rows.length === 0) {
    throw new Error('report_histories_category_ck is missing after migration.');
  }

  const definition = result.rows[0].definition;
  const missing = EXPECTED_CATEGORIES.filter((category) => !definition.includes(category));

  if (missing.length > 0) {
    throw new Error(
      `Category constraint does not admit: ${missing.join(', ')}. `
      + `A decision filed under one of these would be rejected at insert time.`
    );
  }

  console.log('[MIGRATION] Category constraint admits all', EXPECTED_CATEGORIES.length, 'categories.');
}

async function verifyIndexes(client) {
  const result = await client.query(
    `
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'report_histories'
      AND indexname IN (
        'idx_report_histories_admin_feed',
        'idx_report_histories_category'
      )
    ORDER BY indexname
    `
  );

  if (result.rows.length !== 2) {
    throw new Error(
      `Expected 2 admin-history indexes, found ${result.rows.length}. `
      + `Rows: ${result.rows.map((r) => r.indexname).join(', ')}`
    );
  }

  console.log('[MIGRATION] Admin history indexes present.');
}

/**
 * Reports how many rows are still uncategorised.
 *
 * Informational rather than fatal: a fresh install legitimately has none, and an
 * install with a genuinely unrecognised action also has none, because every
 * action this build writes is covered by the backfill. The number is printed so
 * a large count is visible rather than silently leaving history under Reports.
 */
async function reportBackfill(client) {
  const result = await client.query(
    `
    SELECT category, COUNT(*)::int AS total
    FROM report_histories
    WHERE category IS NULL
    GROUP BY category
    `
  );

  const uncategorised = result.rows.reduce((total, row) => total + row.total, 0);

  if (uncategorised === 0) {
    console.log('[MIGRATION] Every existing history row has a category.');
    return;
  }

  console.warn(
    `[MIGRATION] ${uncategorised} history row(s) are still uncategorised and will `
    + `be shown under Reports. Add the action to 024-admin-history.sql if that is wrong.`
  );
}

migrate().then(() => process.exit(process.exitCode || 0));

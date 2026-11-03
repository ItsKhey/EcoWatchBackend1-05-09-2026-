require('dotenv').config({ quiet: true });

const { poolOptions } = require('../src/config/database');

const { Pool } = require('pg');

const pool = new Pool(poolOptions());

const REQUIRED_COLUMNS = [
  ['admins', 'last_active'],
  ['residents', 'last_active'],
  ['reports', 'assigned_personnel_id'],
  ['reports', 'assigned_by_admin_id'],
  ['reports', 'assigned_at'],
  ['archived_reports', 'assigned_personnel_id'],
  ['archived_reports', 'assigned_by_admin_id'],
  ['archived_reports', 'assigned_at'],
  ['personnel_accounts', 'is_cleaning'],
  ['personnel_accounts', 'current_assignment'],
  ['personnel_accounts', 'profile_image'],
];

const REQUIRED_CONSTRAINTS = [
  'reports_assigned_personnel_fk',
  'reports_assigned_by_admin_fk',
  'reports_assigned_personnel_format_ck',
  'reports_assignment_timestamp_ck',
  'personnel_accounts_phase2b_assignment_ck',
];

const REQUIRED_INDEXES = [
  'reports_active_assigned_personnel_uidx',
  'archived_reports_assigned_personnel_idx',
  'personnel_accounts_phase2b_busy_idx',
];

async function verifySchema() {
  const failures = [];

  const columnResult = await pool.query(
    `
    WITH required(table_name, column_name) AS (
      VALUES ${REQUIRED_COLUMNS.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(', ')}
    )
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN required r
      ON r.table_name = c.table_name
     AND r.column_name = c.column_name
    WHERE c.table_schema = 'public'
    `,
    REQUIRED_COLUMNS.flat()
  );
  const columns = new Set(columnResult.rows.map((row) => `${row.table_name}.${row.column_name}`));
  for (const [table, column] of REQUIRED_COLUMNS) {
    if (!columns.has(`${table}.${column}`)) {
      failures.push(`missing column ${table}.${column}`);
    }
  }

  const constraintResult = await pool.query(
    `
    SELECT conname
    FROM pg_constraint
    WHERE conname = ANY($1::text[])
    `,
    [REQUIRED_CONSTRAINTS]
  );
  const constraints = new Set(constraintResult.rows.map((row) => row.conname));
  for (const name of REQUIRED_CONSTRAINTS) {
    if (!constraints.has(name)) failures.push(`missing constraint ${name}`);
  }

  const indexResult = await pool.query(
    `
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = ANY($1::text[])
    `,
    [REQUIRED_INDEXES]
  );
  const indexes = new Set(indexResult.rows.map((row) => row.indexname));
  for (const name of REQUIRED_INDEXES) {
    if (!indexes.has(name)) failures.push(`missing index ${name}`);
  }

  const [legacyAdminResult, invalidPersonnelResult, duplicateActiveResult] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM public.admins
      WHERE upper(coalesce(role, 'ADMIN')) = 'ADMIN'
        AND admin_id ~ '^RES-[A-Z0-9]{8}$'
    `),
    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM public.reports r
      LEFT JOIN public.personnel_accounts p
        ON p.personnel_id = r.assigned_personnel_id
      WHERE r.assigned_personnel_id IS NOT NULL
        AND p.personnel_id IS NULL
    `),
    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT assigned_personnel_id
        FROM public.reports
        WHERE assigned_personnel_id IS NOT NULL
          AND is_deleted = false
          AND is_archived = false
        GROUP BY assigned_personnel_id
        HAVING COUNT(*) > 1
      ) duplicates
    `),
  ]);

  const legacyAdminCount = Number(legacyAdminResult.rows[0]?.count || 0);
  const invalidPersonnelCount = Number(invalidPersonnelResult.rows[0]?.count || 0);
  const duplicateActiveCount = Number(duplicateActiveResult.rows[0]?.count || 0);
  if (legacyAdminCount > 0) {
    failures.push(`${legacyAdminCount} legacy RES-prefixed administrator ID(s) remain`);
  }
  if (invalidPersonnelCount > 0) {
    failures.push(`${invalidPersonnelCount} report assignment(s) reference missing personnel`);
  }
  if (duplicateActiveCount > 0) {
    failures.push(`${duplicateActiveCount} personnel account(s) have duplicate active assignments`);
  }

  console.log('[SCHEMA] Required columns:', columns.size);
  console.log('[SCHEMA] Required constraints:', constraints.size);
  console.log('[SCHEMA] Required indexes:', indexes.size);
  console.log('[SCHEMA] Legacy admin identifiers:', legacyAdminCount);
  console.log('[SCHEMA] Invalid personnel references:', invalidPersonnelCount);
  console.log('[SCHEMA] Duplicate active assignments:', duplicateActiveCount);

  if (failures.length) {
    console.error('[SCHEMA] Verification failed:');
    for (const failure of failures) console.error(` - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('[SCHEMA] Verification passed.');
  }
}

verifySchema()
  .catch((error) => {
    console.error('[SCHEMA] Verification could not run:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

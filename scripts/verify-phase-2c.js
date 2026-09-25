require('dotenv').config();

const { pool } = require('../config/db');

async function verifyPhase2C() {
  const requiredColumns = [
    ['notifications', 'notification_id'],
    ['notifications', 'resident_id'],
    ['notifications', 'report_id'],
    ['notifications', 'title'],
    ['notifications', 'message'],
    ['notifications', 'type'],
    ['notifications', 'is_read'],
    ['notifications', 'created_at'],
    ['residents', 'fcm_token'],
  ];

  const { rows: columns } = await pool.query(
    `
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('notifications', 'residents')
    `
  );
  const present = new Set(columns.map((row) => `${row.table_name}.${row.column_name}`));
  const missing = requiredColumns
    .map(([table, column]) => `${table}.${column}`)
    .filter((name) => !present.has(name));
  if (missing.length) {
    throw new Error(`Missing Phase 2C columns: ${missing.join(', ')}`);
  }

  const { rows: integrity } = await pool.query(
    `
    SELECT
      (SELECT COUNT(*)::int FROM public.reports WHERE created_at IS NULL)
        AS reports_missing_created_at,
      (SELECT COUNT(*)::int FROM public.archived_reports WHERE created_at IS NULL)
        AS archived_reports_missing_created_at,
      (SELECT COUNT(*)::int
       FROM public.notifications n
       WHERE NOT EXISTS (
         SELECT 1 FROM public.residents r WHERE r.resident_id = n.resident_id
       )) AS orphan_notifications
    `
  );
  if (Object.values(integrity[0]).some((value) => Number(value) !== 0)) {
    throw new Error(`Phase 2C integrity check failed: ${JSON.stringify(integrity[0])}`);
  }

  console.log('Phase 2C schema and timestamp integrity checks passed.');
}

verifyPhase2C()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(`[VERIFY] ${error.message}`);
    await pool.end();
    process.exitCode = 1;
  });

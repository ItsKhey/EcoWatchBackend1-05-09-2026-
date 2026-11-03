/**
 * Read-only browser for the EcoWatch database.
 *
 *   node scripts/db-inspect.js tables
 *   node scripts/db-inspect.js describe reports
 *   node scripts/db-inspect.js rows report_clusters 5
 *   node scripts/db-inspect.js query "SELECT status, count(*) FROM reports GROUP BY status"
 *
 * Every command runs inside a READ ONLY transaction, so this cannot write to the
 * database even by accident. It connects through config/database, which reads
 * .env for you: DATABASE_URL is the local server and SUPABASE_DATABASE_URL is
 * the hosted one. Set DB_TARGET=supabase to inspect production instead.
 */
require('dotenv').config({ quiet: true });

const { Pool } = require('pg');
const { poolOptions } = require('../src/config/database');

if (process.env.DB_TARGET === 'supabase' && process.env.SUPABASE_DATABASE_URL) {
  // config/database prefers DATABASE_URL, so point the pool at Supabase for
  // this process only. Nothing on disk changes.
  process.env.DATABASE_URL = process.env.SUPABASE_DATABASE_URL;
}

const pool = new Pool(poolOptions());

const usage = () => {
  console.log(`
Read-only database inspector

  tables                          list every table with its row count
  describe <table>                columns, types, nullability, defaults
  rows <table> [limit]            newest rows from a table
  query "<sql>"                   run a read-only statement

Target: DB_TARGET=supabase node scripts/db-inspect.js tables   (use Supabase)
`);
};

/** Guards the table name so it can never carry SQL of its own. */
const identifier = (name) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(String(name || ''))) {
    throw new Error(`"${name}" is not a plain table name.`);
  }
  return `"${name}"`;
};

const withReadOnly = async (work) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const printRows = (rows) => {
  if (!rows || rows.length === 0) {
    console.log('(no rows)');
    return;
  }
  console.table(rows);
};

const listTables = () => withReadOnly(async (client) => {
  const { rows } = await client.query(`
    SELECT table_name,
           (SELECT count(*) FROM information_schema.columns c
             WHERE c.table_schema = t.table_schema
               AND c.table_name = t.table_name) AS columns
      FROM information_schema.tables t
     WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
     ORDER BY table_name
  `);
  for (const row of rows) {
    const count = await client.query(`SELECT count(*)::int AS n FROM ${identifier(row.table_name)}`);
    console.log(`  ${String(count.rows[0].n).padStart(6)}  ${row.columns} cols  ${row.table_name}`);
  }
  console.log(`\n${rows.length} tables.`);
});

const describeTable = (table) => withReadOnly(async (client) => {
  const { rows } = await client.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  );
  if (!rows.length) {
    console.log(`No such table: ${table}`);
    return;
  }
  printRows(rows.map((r) => ({
    column: r.column_name,
    type: r.data_type,
    nullable: r.is_nullable,
    default: r.column_default === null ? '' : String(r.column_default).slice(0, 40),
  })));
});

const showRows = (table, limit) => withReadOnly(async (client) => {
  const capped = Math.min(Math.max(Number(limit) || 5, 1), 50);
  const { rows } = await client.query(`SELECT * FROM ${identifier(table)} LIMIT ${capped}`);
  printRows(rows);
});

const runQuery = (sql) => withReadOnly(async (client) => {
  const head = String(sql || '').trim().split(/\s+/)[0].toUpperCase();
  if (!['SELECT', 'WITH', 'EXPLAIN', 'TABLE'].includes(head)) {
    throw new Error(`Only SELECT, WITH, EXPLAIN or TABLE are allowed, not ${head}.`);
  }
  const { rows } = await client.query(sql);
  printRows(rows);
});

(async () => {
  const [command, ...rest] = process.argv.slice(2);
  try {
    switch (command) {
      case 'tables':
        await listTables();
        break;
      case 'describe':
        if (!rest[0]) throw new Error('Which table? e.g. describe reports');
        await describeTable(rest[0]);
        break;
      case 'rows':
        if (!rest[0]) throw new Error('Which table? e.g. rows reports 5');
        await showRows(rest[0], rest[1]);
        break;
      case 'query':
        if (!rest.join(' ')) throw new Error('Pass a statement, e.g. query "SELECT 1"');
        await runQuery(rest.join(' '));
        break;
      default:
        usage();
    }
  } catch (error) {
    console.error(`\n  ${error.message}`);
    if (process.env.DEBUG) console.error(error.stack);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
// Restores the EcoWatch database into the local PostgreSQL server.
//
// The dump is a pg_dump custom-format archive taken with --no-owner --no-acl, so
// it restores cleanly into a database owned by a different local role.
//
// Usage, from the backend project root:
//
//   node scripts/restore-local-db.js <path-to-dump>
//
// The connection comes from .env, so DATABASE_URL is the only thing that has to
// be right. A dump already inside DATABASE_URL is the no-op case and is refused
// rather than run, because restoring a database onto itself destroys it.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('dotenv').config({ quiet: true });

const { resolveConnectionString, describeTarget, resolveSsl } = require('../src/config/database');

const PG_BIN_CANDIDATES = [
  process.env.PG_BIN,
  'C:\\Program Files\\PostgreSQL\\18\\bin',
  'C:\\Program Files\\PostgreSQL\\17\\bin',
  'C:\\Program Files\\PostgreSQL\\16\\bin',
  '/usr/lib/postgresql/17/bin',
  '/usr/local/pgsql/bin',
  '/opt/homebrew/opt/postgresql@17/bin',
  '/usr/bin'
].filter(Boolean);

const findPgTool = (name) => {
  const suffixes = process.platform === 'win32' ? ['.exe', '.bat', ''] : [''];
  const pathEnv = process.env.PATH || '';
  const dirs = [...PG_BIN_CANDIDATES, ...pathEnv.split(path.delimiter)];

  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${name}${suffix}`);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch (error) {
        // Unreadable candidate, keep looking.
      }
    }
  }
  return null;
};

const parseConnectionString = (connectionString) => {
  const url = new URL(connectionString);
  return {
    host: decodeURIComponent(url.hostname),
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres'
  };
};

const run = (tool, args, env) => {
  process.stdout.write(`  $ ${path.basename(tool)} ${args.join(' ')}\n`);
  return execFileSync(tool, args, {
    stdio: ['ignore', 'inherit', 'pipe'],
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
};

/**
 * A dump taken from a hosted PostgreSQL provider carries that provider's own
 * scaffolding alongside the application tables: the `auth`, `storage`, `realtime`
 * and `vault` schemas, their foreign keys into each other, a `supabase_vault`
 * extension, and a `pg_graphql` event trigger. None of that exists on a stock
 * local PostgreSQL server, so restoring it verbatim fails on the first
 * `CREATE EXTENSION`.
 *
 * The application only ever touches `public`, and `public` is self-contained:
 * it has no foreign key or default that reaches into any of those schemas. So
 * the default is to restore `public` alone, which is both the correct scope and
 * the one that succeeds locally.
 *
 * `--all` restores everything instead, which only works against a server that
 * actually has the hosted provider's extensions installed.
 */
const resolveSchemas = () => {
  if (process.argv.includes('--all')) return [];

  const custom = process.argv.find((arg) => arg.startsWith('--schema='));
  const schemas = custom
    ? custom.slice('--schema='.length).split(',').map((s) => s.trim()).filter(Boolean)
    : ['public'];

  return schemas.flatMap((schema) => ['--schema', schema]);
};

const main = () => {
  const dumpArg = process.argv[2];

  if (!dumpArg) {
    console.error('Usage: node scripts/restore-local-db.js <path-to-dump>');
    process.exit(1);
  }

  const dumpPath = path.resolve(dumpArg);
  if (!fs.existsSync(dumpPath)) {
    console.error(`[RESTORE] Dump not found: ${dumpPath}`);
    process.exit(1);
  }

  const connectionString = resolveConnectionString();
  if (!connectionString) {
    console.error('[RESTORE] DATABASE_URL (local) or SUPABASE_DATABASE_URL (hosted) is required.');
    process.exit(1);
  }

  const target = describeTarget(connectionString);
  if (!target.isLocal) {
    console.error(
      '[RESTORE] Refusing to restore into a remote host.\n' +
      `          DATABASE_URL currently points at ${target.host}.\n` +
      '          This script is for the local server only. Set DATABASE_URL to a\n' +
      '          localhost connection first.'
    );
    process.exit(1);
  }

  const config = parseConnectionString(connectionString);

  // Refuse a dump of the very database being restored into.
  if (dumpPath.toLowerCase() === config.database.toLowerCase()) {
    console.error('[RESTORE] The dump path matches the target database name.');
    process.exit(1);
  }

  const createdb = findPgTool('createdb');
  const dropdb = findPgTool('dropdb');
  const pgRestore = findPgTool('pg_restore');

  if (!createdb || !dropdb || !pgRestore) {
    console.error(
      '[RESTORE] Could not find createdb/dropdb/pg_restore.\n' +
      '          Add the PostgreSQL bin directory to PATH, or set PG_BIN to it.'
    );
    process.exit(1);
  }

  const ssl = resolveSsl(connectionString);
  const authEnv = { PGPASSWORD: config.password };

  console.log(`[RESTORE] Target : ${target.label} ${config.host}:${config.port}/${config.database}`);
  console.log(`[RESTORE] Source : ${dumpPath}`);
  console.log(`[RESTORE] TLS    : ${ssl ? 'yes' : 'no (local socket)'}`);

  // DROP rather than CREATE so the script can be re-run after a schema change on
  // the source. The target is always the local development database, which is
  // the one thing this script is allowed to replace.
  if (process.argv.includes('--keep')) {
    console.log('[RESTORE] Existing database kept (--keep).');
  } else {
    console.log('[RESTORE] Dropping any existing database of that name...');
    try {
      run(dropdb, ['--if-exists', '--force', '-h', config.host, '-p', config.port, '-U', config.user, config.database], authEnv);
    } catch (error) {
      console.error(`[RESTORE] dropdb failed: ${error.stderr || error.message}`);
      process.exit(1);
    }
  }

  try {
    run(createdb, ['-h', config.host, '-p', config.port, '-U', config.user, config.database], authEnv);
  } catch (error) {
    console.error(`[RESTORE] createdb failed: ${error.stderr || error.message}`);
    process.exit(1);
  }

  const restoreArgs = [
    '-h', config.host,
    '-p', config.port,
    '-U', config.user,
    '-d', config.database,
    '--no-owner',
    '--no-acl',
    '--exit-on-error',
    // Appended rather than inserted, because pg_restore parses flags and
    // operands positionally: `-U` has to be followed by the role name.
    ...(ssl ? [] : ['--no-password']),
    // See resolveSchemas(): a dump taken from a hosted PostgreSQL provider also
    // carries that provider's own schemas and extensions, which do not exist on
    // a stock local server.
    ...resolveSchemas(),
    dumpPath
  ];

  try {
    run(pgRestore, restoreArgs, authEnv);
  } catch (error) {
    console.error(`[RESTORE] pg_restore failed: ${error.stderr || error.message}`);
    process.exit(1);
  }

  console.log(`\n[RESTORE] Done. ${config.database} is ready on ${config.host}:${config.port}.`);
  console.log('[RESTORE] Start the server with: npm run dev');
};

main();

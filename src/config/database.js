const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

/**
 * Single source of truth for "which PostgreSQL server are we talking to".
 *
 * Two targets are supported and they are chosen purely by .env:
 *
 *   DATABASE_URL          the local PostgreSQL server (the academic setup)
 *   SUPABASE_DATABASE_URL the hosted PostgreSQL fallback that was in use before
 *
 * DATABASE_URL wins when both are present, so pointing the project at a local
 * server is a single line in .env and never a code change. The identical schema
 * runs on both, so either can be used at any time.
 *
 * Every script, migration and verifier builds its pool through this module
 * rather than reading the environment itself, which is what keeps a local run
 * from quietly pointing one tool at a different database than the server.
 */

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];

const resolveConnectionString = () =>
  process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL || null;

/**
 * A local PostgreSQL server has no TLS certificate and refuses the handshake,
 * so SSL is negotiated for remote hosts only. DATABASE_SSL forces the decision
 * either way for the rare hosted server that does not want TLS.
 */
const resolveSsl = (connectionString) => {
  const override = process.env.DATABASE_SSL;

  if (override) {
    return !['false', '0', 'no'].includes(String(override).toLowerCase());
  }

  let host = '';
  try {
    host = new URL(connectionString).hostname;
  } catch (error) {
    // Not a URL, so a libpq key=value string. Treated as remote, which is the
    // stricter of the two options.
    return true;
  }

  return !LOCAL_HOSTS.includes(host);
};

const describeTarget = (connectionString) => {
  let host;
  try {
    host = new URL(connectionString).hostname;
  } catch (error) {
    host = 'configured host';
  }

  return {
    host,
    isLocal: LOCAL_HOSTS.includes(host),
    label: LOCAL_HOSTS.includes(host) ? 'Local PostgreSQL' : 'Remote PostgreSQL'
  };
};

/**
 * Pool options for a target, ready to spread into `new Pool(...)`.
 * `ssl: false` is set explicitly rather than omitted so node-postgres never
 * attempts TLS on a loopback connection.
 */
const poolOptions = (overrides = {}) => {
  const connectionString = resolveConnectionString();

  if (!connectionString) {
    throw new Error(
      '[DATABASE] Neither DATABASE_URL (local) nor SUPABASE_DATABASE_URL (hosted) is set in the environment variables!'
    );
  }

  return {
    connectionString,
    ...(resolveSsl(connectionString)
      ? { ssl: { rejectUnauthorized: false } }
      : { ssl: false }),
    ...overrides
  };
};

const createPool = (overrides = {}) => new Pool(poolOptions(overrides));

/**
 * Throws a named error when no target is configured, so a script fails with a
 * useful message instead of a confusing authentication error.
 */
const requireConnectionString = (label = 'this script') => {
  const connectionString = resolveConnectionString();

  if (!connectionString) {
    throw new Error(
      `[DATABASE] DATABASE_URL (local) or SUPABASE_DATABASE_URL (hosted) is required to run ${label}.`
    );
  }

  return connectionString;
};

module.exports = {
  resolveConnectionString,
  resolveSsl,
  describeTarget,
  poolOptions,
  createPool,
  requireConnectionString
};

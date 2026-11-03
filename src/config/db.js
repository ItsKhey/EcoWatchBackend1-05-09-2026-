const { createPool, requireConnectionString, describeTarget } = require('./database');

const pool = createPool();
const { isLocal: isLocalHost, label, host } = describeTarget(
  requireConnectionString('the server')
);

pool.on('connect', () => {
  console.log(`[DATABASE] ${label} connected (${host})`);
});

pool.on('error', (err) => {
  console.error('[DATABASE] PostgreSQL pool error:', err);
});

async function withTransaction(work) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[DATABASE] Transaction rollback failed:', rollbackError);
    }

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  withTransaction,
  isLocalHost
};

const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

if (!process.env.SUPABASE_DATABASE_URL) {
  throw new Error(
    '[DATABASE] SUPABASE_DATABASE_URL is missing from environment variables!'
  );
}

const pool = new Pool({
  connectionString: process.env.SUPABASE_DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on('connect', () => {
  console.log('[DATABASE] Supabase PostgreSQL connected');
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
  withTransaction
};

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

module.exports = {
  pool
};

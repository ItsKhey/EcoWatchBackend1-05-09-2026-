const { pool } = require('./config/db');

async function verify() {
  try {
    const result = await pool.query(`
      SELECT
        table_name,
        column_name,
        data_type,
        is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'residents',
          'pending_registrations',
          'password_reset_otps'
        )
      ORDER BY table_name, ordinal_position;
    `);

    console.table(result.rows);

    const indexResult = await pool.query(`
      SELECT
        indexname,
        indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'pending_registrations';
    `);

    console.log('\n=== PENDING REGISTRATION INDEXES ===');
    console.table(indexResult.rows);

  } catch (error) {
    console.error('❌ Verification failed:', error.message);
  } finally {
    await pool.end();
  }
}

verify();

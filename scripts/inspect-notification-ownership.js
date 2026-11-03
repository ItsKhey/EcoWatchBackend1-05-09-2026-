require('dotenv').config();

const { pool } = require('../src/config/db');

/** Read-only inspection of the notifications ownership constraints. */
async function main() {
  try {
    const fks = await pool.query(`
      SELECT con.conname,
             pg_get_constraintdef(con.oid) AS definition,
             con.confdeltype
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'notifications'
        AND con.contype = 'f'
    `);
    console.log('\nnotifications FOREIGN KEYS:');
    fks.rows.forEach((row) => {
      console.log(`  ${row.conname} (on delete: ${row.confdeltype})`);
      console.log(`    ${row.definition}`);
    });

    const cols = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'notifications'
      ORDER BY ordinal_position
    `);
    console.log('\nnotifications columns:');
    cols.rows.forEach((row) => {
      console.log(`  ${row.column_name} ${row.data_type} nullable=${row.is_nullable} default=${row.column_default || 'none'}`);
    });
  } catch (error) {
    console.error('Inspection failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();

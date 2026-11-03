require('dotenv').config();

const { pool } = require('../src/config/db');

/**
 * Read-only guard for the Phase 3A migration: confirms the notifications table
 * will accept the NEW_REPORT type and that administrators carry the role the
 * token-claim query expects.
 */
async function main() {
  try {
    const constraints = await pool.query(`
      SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'notifications'
        AND con.contype = 'c'
    `);
    console.log('\nnotifications CHECK constraints:',
      constraints.rows.length ? '' : 'none');
    constraints.rows.forEach((row) => console.log(`  ${row.conname}: ${row.definition}`));

    const distinct = await pool.query(
      `SELECT DISTINCT role FROM notifications`
    ).catch(() => null);
    if (distinct && !distinct.error) {
      console.log('distinct notifications.type values:',
        distinct.rows.map((r) => r.role));
    }

    const roles = await pool.query(
      `SELECT admin_id, role FROM admins ORDER BY admin_id`
    );
    console.log('\nadmin roles (token claim requires lower(trim(role)) = \'admin\'):');
    roles.rows.forEach((row) => {
      const ok = String(row.role || 'ADMIN').trim().toLowerCase() === 'admin';
      console.log(`  ${row.admin_id} role=${row.role} -> ${ok ? 'ELIGIBLE' : 'INELIGIBLE'}`);
    });
  } catch (error) {
    console.error('Guard failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();

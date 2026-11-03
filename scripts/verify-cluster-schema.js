const { pool } = require('../src/config/db');

async function verify() {
  const clusterResult = await pool.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'report_clusters' ORDER BY ordinal_position"
  );
  console.log('report_clusters columns:');
  clusterResult.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

  const photoResult = await pool.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'report_photos' ORDER BY ordinal_position"
  );
  console.log('\nreport_photos columns:');
  photoResult.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

  const reportsResult = await pool.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'reports' AND column_name = 'cluster_id'"
  );
  console.log('\nreports.cluster_id:');
  reportsResult.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

  const indexResult = await pool.query(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'report_clusters' OR tablename = 'report_photos' ORDER BY indexname"
  );
  console.log('\nIndexes:');
  indexResult.rows.forEach(r => console.log(`  ${r.indexname}`));

  await pool.end();
}

verify().catch(e => { console.error(e); process.exit(1); });

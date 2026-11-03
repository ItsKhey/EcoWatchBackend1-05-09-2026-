// Discovers every character column that still holds a hosted CDN URL, so the
// image migration cannot miss a table nobody remembered.
const { Client } = require('pg');
require('dotenv').config({ quiet: true });
const { poolOptions } = require('../src/config/database');

const PATTERN = '%res.cloudinary.com%';

(async () => {
  const client = new Client(poolOptions());
  await client.connect();

  const { rows: columns } = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('text', 'character varying', 'character')
    ORDER BY table_name, column_name
  `);

  const hits = [];
  for (const { table_name, column_name } of columns) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n, array_agg(DISTINCT v) AS urls
         FROM (
           SELECT DISTINCT "${column_name}" AS v
             FROM "${table_name}"
            WHERE "${column_name}" LIKE $1
         ) s`,
      [PATTERN]
    );
    if (rows[0] && rows[0].n > 0) {
      hits.push({
        table: table_name,
        column: column_name,
        distinctUrls: rows[0].n,
        sample: (rows[0].urls || []).slice(0, 2),
      });
    }
  }

  console.log(JSON.stringify(hits, null, 2));
  await client.end();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

#!/usr/bin/env node
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// deterministic perturbations
function variants(raw) {
  const s = new Set([raw]);
  s.add(raw.toLowerCase());
  s.add(raw.toUpperCase());
  s.add(raw.replace(/-/g, ' '));
  s.add(raw.replace(/ /g, '-'));
  if (/^[A-Za-z]{3}$/.test(raw)) { // e.g., FOH
    s.add(raw.split('').join('.'));
    s.add(raw.split('').join('.') + '.');
  }
  s.add(raw + '!');
  s.add(raw + '.');
  s.add(raw.replace(/ /g, '  '));
  return [...s];
}

(async () => {
  const { rows } = await pool.query(`
    SELECT term_id, alias_raw
    FROM tm_term_aliases
    ORDER BY term_id, is_canonical DESC, alias_raw
  `);
  for (const r of rows) {
    for (const v of variants(r.alias_raw)) {
      process.stdout.write(JSON.stringify({ input: v, expect_term_id: r.term_id }) + '\n');
    }
  }
  const negatives = ['random','guestlisting','soundchecks','fohx','front-of-housekeeping','loadins','onstagetimez','setlistsz'];
  for (const n of negatives) process.stdout.write(JSON.stringify({ input: n, expect_term_id: null }) + '\n');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });

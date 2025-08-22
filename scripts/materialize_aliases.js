#!/usr/bin/env node
// scripts/materialize_aliases.js
const { Pool } = require('pg');
const { normalize, tokenLen } = require('../backend/services/normalizer');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // or your local PG env vars
  ssl: { rejectUnauthorized: false }
  // ssl: { rejectUnauthorized: false } // enable if needed for Render/Cloud
});

async function main() {
  const client = await pool.connect();
  try {
    // 1) pull all terms + aliases from industry_terms
    const { rows } = await client.query(`
      SELECT term_id, term, COALESCE(aliases, '{}') AS aliases
      FROM industry_terms
      ORDER BY term_id
    `);

    // 2) insert canonical + each alias, normalized + token_len
    const upsert = `
      INSERT INTO tm_term_aliases (term_id, alias_raw, alias_normalized, token_len, is_canonical)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (alias_normalized) DO NOTHING
    `;

    let inserted = 0, skipped = 0;

    for (const r of rows) {
      const { term_id } = r;

      // canonical
      {
        const raw = r.term;
        const norm = normalize(raw);
        const tl = tokenLen(norm);
        if (!norm) continue;
        try {
          await client.query(upsert, [term_id, raw, norm, tl, true]);
          inserted++;
        } catch { skipped++; }
      }

      // aliases[]
      for (const raw of r.aliases) {
        const norm = normalize(raw);
        const tl = tokenLen(norm);
        if (!norm) continue;
        try {
          await client.query(upsert, [term_id, raw, norm, tl, false]);
          inserted++;
        } catch { skipped++; }
      }
    }

    console.log(`Alias materialization complete. Inserted: ${inserted}, Skipped: ${skipped}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });


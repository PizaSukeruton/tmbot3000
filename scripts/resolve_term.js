#!/usr/bin/env node
// scripts/resolve_term.js
const { Pool } = require('pg');
const { loadAliasIndex, lookupExact, lookupInSentence } = require('../backend/services/termIndex');
const { normalize } = require('../backend/services/normalizer');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render PG
});

async function resolveAnswer(term_id, locale = 'en-AU') {
  const sql = `
    SELECT answer_template
    FROM tm_answers
    WHERE term_id = $1 AND locale = $2 AND is_current = true
    ORDER BY version DESC
    LIMIT 1
  `;
  const { rows } = await pool.query(sql, [term_id, locale]);
  return rows[0]?.answer_template || null;
}

(async () => {
  const input = process.argv.slice(2).join(' ');
  if (!input) {
    console.error('Usage: node scripts/resolve_term.js "<your text or term>"');
    process.exit(1);
  }

  await loadAliasIndex();

  const norm = normalize(input);
  const exact = lookupExact(norm);
  const phrase = exact || lookupInSentence(norm);

  if (!phrase) {
    console.log(JSON.stringify({ input, normalized: norm, match: null, answer: null }, null, 2));
    process.exit(0);
  }

  const answer = await resolveAnswer(phrase.term_id, process.env.LOCALE || 'en-AU');
  console.log(JSON.stringify({
    input,
    normalized: norm,
    match: { term_id: phrase.term_id, alias: phrase.alias ?? norm },
    answer
  }, null, 2));

  await pool.end();
})().catch(err => { console.error(err); process.exit(1); });

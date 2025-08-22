// backend/services/termIndex.js
// Deterministic alias index for term lookups

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // needed for Render
});

let aliasMap = new Map();  // key: alias_normalized, val: { term_id, token_len }
let maxTokenLen = 1;

/**
 * Load alias index from tm_term_aliases into memory.
 * Call on boot or on demand after seeding.
 */
async function loadAliasIndex() {
  const sql = `
    SELECT term_id, alias_normalized, token_len
    FROM tm_term_aliases
  `;
  const { rows } = await pool.query(sql);

  const m = new Map();
  let maxLen = 1;
  for (const r of rows) {
    m.set(r.alias_normalized, { term_id: r.term_id, token_len: r.token_len });
    if (r.token_len > maxLen) maxLen = r.token_len;
  }
  aliasMap = m;
  maxTokenLen = maxLen;

  return { count: rows.length, maxTokenLen };
}

/**
 * Exact term-only lookup: userText must already be normalized externally
 * (or you can pass a normalized alias_normalized directly).
 */
function lookupExact(normalizedText) {
  const hit = aliasMap.get(normalizedText);
  return hit ? { term_id: hit.term_id, token_len: hit.token_len } : null;
}

/**
 * Free-text phrase scan (tokens already normalized by your normalizer).
 * Longest-match wins; on tie, earliest start wins.
 */
function lookupInSentence(normalizedSentence) {
  const tokens = normalizedSentence.split(' ').filter(Boolean);
  let best = null;

  for (let i = 0; i < tokens.length; i++) {
    for (let k = Math.min(maxTokenLen, tokens.length - i); k >= 1; k--) {
      const ngram = tokens.slice(i, i + k).join(' ');
      const hit = aliasMap.get(ngram);
      if (hit) {
        if (!best || hit.token_len > best.token_len) {
          best = { term_id: hit.term_id, token_len: hit.token_len, alias: ngram, start: i };
        }
        break; // shorter window can't beat this n-gram at this start
      }
    }
  }
  return best;
}

module.exports = {
  loadAliasIndex,
  lookupExact,
  lookupInSentence,
  // exposed for diagnostics
  _debug: () => ({ size: aliasMap.size, maxTokenLen })
};


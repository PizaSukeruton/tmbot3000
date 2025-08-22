#!/usr/bin/env node
// scripts/test_terms.js — deterministic closed-set evaluator (exact alias match)
const fs = require('fs');
const readline = require('readline');
const { loadAliasIndex, lookupExact } = require('../backend/services/termIndex');
const { normalize } = require('../backend/services/normalizer');

(async () => {
  await loadAliasIndex();

  const file = process.argv[2] || 'gold.jsonl';
  if (!fs.existsSync(file)) {
    console.error(`Gold file not found: ${file}`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  let total = 0, pos = 0, posPass = 0, neg = 0, negPass = 0;
  const rows = [], failures = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    const { input, expect_term_id } = JSON.parse(line);
    total++;
    const n = normalize(input);
    const hit = lookupExact(n);
    const got = hit ? hit.term_id : null;
    const ok = (got === expect_term_id);

    rows.push([input, n, expect_term_id || '', got || '', ok ? 'PASS' : 'FAIL']);

    if (expect_term_id) { pos++; if (ok) posPass++; }
    else { neg++; if (!got) negPass++; }

    if (!ok) failures.push({ input, normalized: n, expect_term_id, got });
  }

  const precision = pos ? posPass / pos : 1;
  const recall = pos ? posPass / pos : 1;
  const negAcc = neg ? negPass / neg : 1;

  fs.writeFileSync('coverage_matrix.csv', ['input,normalized,expected,got,status', ...rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(','))].join('\n'), 'utf8');
  fs.writeFileSync('mismatch_report.json', JSON.stringify(failures, null, 2), 'utf8');

  console.log(`Total: ${total}`);
  console.log(`Positives: ${pos}  Passed: ${posPass}`);
  console.log(`Negatives: ${neg}  Correctly Rejected: ${negPass}`);
  console.log(`Precision: ${precision.toFixed(4)}  Recall: ${recall.toFixed(4)}  NegAcc: ${negAcc.toFixed(4)}`);
  console.log(failures.length === 0 ? '✅ 100% on closed set' : `❌ Mismatches: ${failures.length} (see mismatch_report.json)`);
})();

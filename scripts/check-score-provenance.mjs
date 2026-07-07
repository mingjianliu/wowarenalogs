#!/usr/bin/env node
// Score provenance validator (verifiability C4).
//
// Every healer-eval score file written after the provenance format was adopted
// (2026-07-07) must carry a `provenance` block binding it to the exact prompt
// and response artifacts that were judged:
//   { judgeModel, judgedAt, promptSha256, responseSha256 }
// This makes fabricated or stale scores machine-detectable (see CLAUDE.md
// Eval Integrity / TRACKER F141). Legacy score files without provenance only
// warn — backfilling provenance onto old scores is itself fabrication.
//
// Usage: node scripts/check-score-provenance.mjs [evalDir]
//   evalDir defaults to packages/tools/local-batch/healer-eval

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const evalDir = process.argv[2] ?? join(root, 'packages', 'tools', 'local-batch', 'healer-eval');
const scoresDir = join(evalDir, 'scores');

if (!existsSync(scoresDir)) {
  console.log(`[check-score-provenance] no scores dir at ${scoresDir} — nothing to check`);
  process.exit(0);
}

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const promptsDir = join(evalDir, 'prompts');
const promptFiles = existsSync(promptsDir) ? readdirSync(promptsDir) : [];
const promptFor = (ordinal) => {
  const prefix = String(ordinal).padStart(3, '0') + '-';
  const hit = promptFiles.find((f) => f.startsWith(prefix));
  return hit ? join(promptsDir, hit) : join(promptsDir, `${String(ordinal).padStart(3, '0')}.txt`);
};

let fail = 0;
let legacy = 0;
let ok = 0;

for (const f of readdirSync(scoresDir)
  .filter((f) => f.endsWith('.json'))
  .sort()) {
  const scorePath = join(scoresDir, f);
  const score = JSON.parse(readFileSync(scorePath, 'utf8'));
  const p = score.provenance;

  if (!p) {
    legacy += 1;
    continue;
  }

  const problems = [];
  for (const field of ['judgeModel', 'judgedAt', 'promptSha256', 'responseSha256']) {
    if (typeof p[field] !== 'string' || !p[field]) problems.push(`missing ${field}`);
  }
  if (p.judgedAt && Number.isNaN(Date.parse(p.judgedAt))) problems.push('judgedAt is not a parseable timestamp');

  if (p.promptSha256) {
    const promptPath = promptFor(score.ordinal);
    if (!existsSync(promptPath)) problems.push(`prompt artifact not found for ordinal ${score.ordinal}`);
    else if (sha256(promptPath) !== p.promptSha256)
      problems.push('promptSha256 does not match current prompt artifact');
  }
  if (p.responseSha256) {
    const responsePath = join(evalDir, 'responses', `${String(score.ordinal).padStart(3, '0')}.txt`);
    if (!existsSync(responsePath)) problems.push(`response artifact not found for ordinal ${score.ordinal}`);
    else if (sha256(responsePath) !== p.responseSha256)
      problems.push('responseSha256 does not match current response artifact');
  }

  if (problems.length) {
    fail += 1;
    console.error(`[check-score-provenance] ${f}: ${problems.join('; ')}`);
  } else {
    ok += 1;
  }
}

console.log(
  `[check-score-provenance] ${ok} verified, ${legacy} legacy (no provenance — pre-2026-07-07), ${fail} FAILED`,
);
if (legacy) console.log('[check-score-provenance] legacy files warn only; do NOT backfill provenance onto them.');
process.exit(fail ? 1 : 0);

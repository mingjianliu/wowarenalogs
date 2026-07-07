#!/usr/bin/env node
// Cross-family auditor calibration (meta-eval for judge-spot-audit's auditor).
//
// The spot-audit trust chain has a gap: Gemini audits the Claude judge, but
// nothing calibrates Gemini-as-auditor. This tool plants synthetic defects
// into REAL fact-audit claims (deterministic text mutations that make the
// claim false against the prompt) and measures whether the auditor, given the
// exact same contract and model as scripts/judge-spot-audit.mjs, flags them
// (DISAGREE) while still confirming the untouched claims (AGREE).
//
// This is defect-detection calibration à la /calibrate-judge — it reports
// measured detection counts, never rubric scores (see CLAUDE.md Eval Integrity).
//
// Usage: node scripts/calibrate-auditor.mjs [--model flash-high] [archiveDir]
//   archiveDir defaults to packages/tools/local-batch/healer-eval/archive-run-2026-07-07-preB124

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGY_RUN = join(homedir(), '.claude', 'skills', 'agy', 'scripts', 'agy-run.mjs');

let model = 'flash-high';
let archiveDir = join(root, 'packages', 'tools', 'local-batch', 'healer-eval', 'archive-run-2026-07-07-preB124');
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--model') model = argv[++i];
  else archiveDir = argv[i];
}

const ORDINALS = ['001', '003', '005', '007'];
// Which claim index gets corrupted per ordinal, and how (rotates through types).
const PLANTS = {
  '001': { idx: 1, type: 'timeShift' },
  '003': { idx: 0, type: 'numberDistort' },
  '005': { idx: 2, type: 'timeShift' },
  '007': { idx: 1, type: 'numberDistort' },
};

function corrupt(claim, type) {
  if (type === 'timeShift') {
    // shift the first printed timestamp by +1 minute — a time that may not exist in the prompt
    const m = claim.match(/(\d+):(\d\d)/);
    if (m)
      return {
        text: claim.replace(m[0], `${Number(m[1]) + 1}:${m[2]}`),
        note: `timestamp ${m[0]} -> ${Number(m[1]) + 1}:${m[2]}`,
      };
  }
  // distort the first magnitude figure (e.g. 109k -> 909k, 79% -> 9%)
  let m = claim.match(/(\d+)(k\b)/);
  if (m) return { text: claim.replace(m[0], `9${m[1]}${m[2]}`), note: `${m[0]} -> 9${m[1]}${m[2]}` };
  m = claim.match(/(\d+)(%)/);
  if (m) return { text: claim.replace(m[0], `9${m[1]}${m[2]}`), note: `${m[0]} -> 9${m[1]}${m[2]}` };
  // fallback: timestamp shift attempt again, else fail loudly
  const t = claim.match(/(\d+):(\d\d)/);
  if (t) return { text: claim.replace(t[0], `${Number(t[1]) + 1}:${t[2]}`), note: `timestamp ${t[0]} shifted` };
  throw new Error('no mutable token found in claim');
}

const promptFiles = readdirSync(join(archiveDir, 'prompts'));
const results = [];

for (const ord of ORDINALS) {
  const score = JSON.parse(readFileSync(join(archiveDir, 'scores', `${ord}.json`), 'utf8'));
  const promptFile = promptFiles.find((p) => p.includes(score.matchId));
  const responsePath = join(archiveDir, 'responses', `${ord}.txt`);
  if (!promptFile || !existsSync(responsePath)) {
    console.error(`[calibrate-auditor] ${ord}: missing artifacts, skipping`);
    continue;
  }

  const plant = PLANTS[ord];
  const claims = score.factAudit.map((c, i) => {
    if (i === plant.idx) {
      const mutated = corrupt(c.claim, plant.type);
      return { text: mutated.text, evidence: c.evidence, planted: true, note: mutated.note };
    }
    return { text: c.claim, evidence: c.evidence, planted: false };
  });

  const claimBlock = claims
    .map((c, i) => `CLAIM ${i + 1} (judge says verified=true): "${c.text}" — judge's cited evidence: "${c.evidence}"`)
    .join('\n\n');

  const task = `An LLM judge audited an AI coaching response against a match-data prompt. Independently re-check the judge's fact audit.

Read BOTH files in this workspace IN FULL before answering:
- prompt: ${join('packages/tools/local-batch/healer-eval/archive-run-2026-07-07-preB124/prompts', promptFile)}
- response: ${join('packages/tools/local-batch/healer-eval/archive-run-2026-07-07-preB124/responses', `${ord}.txt`)}

The judge's fact audit:
${claimBlock}

For each claim, output one line: CLAIM <n>: AGREE or DISAGREE — <one-sentence reason grounded in the actual files>. AGREE means the judge's verified=true/false call is correct. Then a final line: AGREEMENT: <agreed>/<total>.`;

  process.stderr.write(
    `[calibrate-auditor] ordinal ${ord}: planted ${plant.type} on claim ${plant.idx + 1} (${claims[plant.idx].note})\n`,
  );
  let output;
  try {
    output = execFileSync('node', [AGY_RUN, 'ask', '--model', model, '--timeout', '280', task], {
      encoding: 'utf8',
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error(`[calibrate-auditor] ${ord}: agy run failed (${err.status})`);
    results.push({ ord, error: true });
    continue;
  }

  const verdicts = {};
  for (const m of output.matchAll(/CLAIM\s*(\d)\s*:\s*(AGREE|DISAGREE)/g)) verdicts[Number(m[1]) - 1] = m[2];
  const cases = claims.map((c, i) => ({
    ord,
    claim: i + 1,
    planted: c.planted,
    note: c.note ?? null,
    expected: c.planted ? 'DISAGREE' : 'AGREE',
    got: verdicts[i] ?? 'NO-PARSE',
    correct: (verdicts[i] ?? '') === (c.planted ? 'DISAGREE' : 'AGREE'),
  }));
  results.push({ ord, cases, raw: output.trim() });
}

const all = results.flatMap((r) => r.cases ?? []);
const planted = all.filter((c) => c.planted);
const clean = all.filter((c) => !c.planted);
const detected = planted.filter((c) => c.correct).length;
const cleanOk = clean.filter((c) => c.correct).length;

const lines = [
  `# Cross-Family Auditor Calibration Report`,
  ``,
  `- Date: ${new Date().toISOString()}`,
  `- Auditor under test: ${model} via agy (same contract as judge-spot-audit.mjs)`,
  `- Corpus: real scores/prompts/responses from archive-run-2026-07-07-preB124, ordinals ${ORDINALS.join('/')}`,
  ``,
  `## Measured results`,
  ``,
  `- **Planted-defect detection: ${detected}/${planted.length}** (corrupted claims correctly flagged DISAGREE)`,
  `- **Clean-claim agreement: ${cleanOk}/${clean.length}** (untouched verified claims correctly AGREEd)`,
  ``,
  `| ordinal | claim | planted | mutation | expected | got | correct |`,
  `| --- | --- | --- | --- | --- | --- | --- |`,
  ...all.map(
    (c) =>
      `| ${c.ord} | ${c.claim} | ${c.planted ? 'YES' : '—'} | ${c.note ?? '—'} | ${c.expected} | ${c.got} | ${c.correct ? '✅' : '❌'} |`,
  ),
  ``,
  `## Raw auditor outputs`,
  ``,
  ...results.filter((r) => r.raw).map((r) => `### Ordinal ${r.ord}\n\n\`\`\`\n${r.raw}\n\`\`\`\n`),
];

const reportPath = join(root, 'docs', 'analysis', `${new Date().toISOString().slice(0, 10)}-auditor-calibration.md`);
writeFileSync(reportPath, lines.join('\n'));
console.log(
  `[calibrate-auditor] detection ${detected}/${planted.length}, clean-agreement ${cleanOk}/${clean.length}; report: ${reportPath}`,
);

#!/usr/bin/env node
// Judge cross-model spot-audit (verifiability C7).
//
// Samples score files from a real healer-eval run and asks an independent
// cross-family model (via agy-run) to re-check each factAudit claim against
// the full prompt + response artifacts. Reports an agreement rate.
//
// This audits the judge's *fact claims* (objective, evidence-backed), not the
// 1-5 rubric scores — deterministic-adjacent territory where disagreement is
// meaningful. A sudden drop in agreement means the judge or the pipeline needs
// /calibrate-judge, not that the auditor is right.
//
// Usage: node scripts/judge-spot-audit.mjs [--count 5] [--model flash-high] [evalDir]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGY_RUN = join(homedir(), '.claude', 'skills', 'agy', 'scripts', 'agy-run.mjs');

let count = 5;
let model = 'flash-high';
let evalDir = join(root, 'packages', 'tools', 'local-batch', 'healer-eval');
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--count') count = Number(argv[++i]);
  else if (argv[i] === '--model') model = argv[++i];
  else evalDir = argv[i];
}

const scoresDir = join(evalDir, 'scores');
if (!existsSync(scoresDir)) {
  console.error(`[judge-spot-audit] no scores at ${scoresDir}`);
  process.exit(1);
}

const scoreFiles = readdirSync(scoresDir)
  .filter((f) => f.endsWith('.json'))
  .sort();
// Deterministic, auditable sample: evenly spaced across the run.
const step = Math.max(1, Math.floor(scoreFiles.length / count));
const sample = scoreFiles.filter((_, i) => i % step === 0).slice(0, count);

const promptFiles = readdirSync(join(evalDir, 'prompts'));
const results = [];

for (const f of sample) {
  const score = JSON.parse(readFileSync(join(scoresDir, f), 'utf8'));
  const ord = String(score.ordinal).padStart(3, '0');
  const promptFile = promptFiles.find((p) => p.startsWith(`${ord}-`));
  const responseFile = `${ord}.txt`;
  if (!promptFile || !existsSync(join(evalDir, 'responses', responseFile))) {
    console.error(`[judge-spot-audit] ordinal ${ord}: missing prompt/response artifact, skipping`);
    continue;
  }
  const claims = (score.factAudit ?? [])
    .map(
      (c, i) =>
        `CLAIM ${i + 1} (judge says verified=${c.verified}): "${c.claim}" — judge's cited evidence: "${c.evidence}"`,
    )
    .join('\n\n');
  const task = `An LLM judge audited an AI coaching response against a match-data prompt. Independently re-check the judge's fact audit.

Read BOTH files in this workspace IN FULL before answering:
- prompt: ${join('packages/tools/local-batch/healer-eval/prompts', promptFile)}
- response: ${join('packages/tools/local-batch/healer-eval/responses', responseFile)}

The judge's fact audit:
${claims}

For each claim, output one line: CLAIM <n>: AGREE or DISAGREE — <one-sentence reason grounded in the actual files>. AGREE means the judge's verified=true/false call is correct. Then a final line: AGREEMENT: <agreed>/<total>.`;

  process.stderr.write(`[judge-spot-audit] auditing ordinal ${ord} with ${model}…\n`);
  let output;
  try {
    output = execFileSync('node', [AGY_RUN, 'ask', '--model', model, '--timeout', '280', task], {
      encoding: 'utf8',
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error(`[judge-spot-audit] ordinal ${ord}: agy run failed (${err.status}) — recorded as UNAVAILABLE`);
    results.push({ ordinal: ord, agreed: null, total: null, detail: 'agy transport failure' });
    continue;
  }
  const m = output.match(/AGREEMENT:\s*(\d+)\s*\/\s*(\d+)/);
  results.push({
    ordinal: ord,
    agreed: m ? Number(m[1]) : null,
    total: m ? Number(m[2]) : null,
    detail: output.trim(),
  });
}

const scored = results.filter((r) => r.agreed !== null);
const agreed = scored.reduce((s, r) => s + r.agreed, 0);
const total = scored.reduce((s, r) => s + r.total, 0);

const report = [
  `# Judge Spot-Audit Report`,
  ``,
  `- Date: ${new Date().toISOString()}`,
  `- Auditor model (via agy): ${model}`,
  `- Sampled: ${sample.join(', ')}`,
  `- **Agreement: ${agreed}/${total} fact-audit claims${total ? ` (${Math.round((100 * agreed) / total)}%)` : ''}**`,
  ``,
  ...results.map(
    (r) =>
      `## Ordinal ${r.ordinal} — ${r.agreed === null ? 'UNAVAILABLE' : `${r.agreed}/${r.total}`}\n\n\`\`\`\n${r.detail}\n\`\`\`\n`,
  ),
].join('\n');

const reportPath = join(evalDir, 'spot-audit-report.md');
writeFileSync(reportPath, report);
console.log(`[judge-spot-audit] agreement ${agreed}/${total}; full report: ${reportPath}`);
if (total === 0) process.exit(1);

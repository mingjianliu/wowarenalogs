#!/usr/bin/env node
// Test-suite health guard: asserts each package still collects at least its
// baseline number of jest test suites (via --listTests, no tests executed).
// Catches suites silently falling out of the match set — config drift,
// renamed dirs, accidental ignore patterns — which `npm run test` cannot
// detect because it only reports on the suites it *did* collect.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(readFileSync(join(root, 'scripts', 'test-suite-baseline.json'), 'utf8'));

let failed = false;
for (const [pkg, { runner, minSuites }] of Object.entries(baseline.packages)) {
  const cwd = join(root, 'packages', pkg);
  const cmd = runner === 'tsdx' ? 'npx tsdx test --listTests' : 'npx jest --listTests';
  let count = 0;
  try {
    const out = execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    count = out.split('\n').filter((l) => /\.(test|spec)\.[jt]sx?$/.test(l.trim())).length;
  } catch (err) {
    console.error(`[check-test-suites] ${pkg}: listTests failed — ${err.message.split('\n')[0]}`);
    failed = true;
    continue;
  }
  const ok = count >= minSuites;
  console.log(`[check-test-suites] ${pkg}: ${count} suites (floor ${minSuites}) ${ok ? 'OK' : 'BELOW FLOOR'}`);
  if (!ok) failed = true;
}

if (failed) {
  console.error(
    '\n[check-test-suites] FAIL — suites dropped below baseline. If intentional, update scripts/test-suite-baseline.json in the same commit.',
  );
  process.exit(1);
}
console.log('[check-test-suites] PASS');

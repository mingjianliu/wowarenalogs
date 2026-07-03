/* eslint-disable no-console */
/**
 * Annotation regression gate for the PRODUCTION (critical-moments) analysis context.
 *
 * Asserts a set of curated "golden game" invariants that encode the accuracy fixes + feature ports
 * made to buildMatchContext / criticalMoments / deathOutcomeAnalysis. Run this after any change to the
 * prompt or the context builders to catch silent regressions:
 *
 *   npx ts-node --files packages/tools/src/annotationRegressionCheck.ts
 *
 * Exit code is non-zero if any assertion fails.
 */
import { CombatUnitReaction, CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';
import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';

import { buildMatchContext } from '../../shared/src/components/CombatReport/CombatAIAnalysis/buildMatchContext';
import { isHealerSpec } from '../../shared/src/utils/cooldowns';
import { parseLogText } from './printMatchPrompts';

const LOGS = '/Users/mingjianliu/code/wowarenalogs/scratch/user-logs/wow';

interface Assertion {
  desc: string;
  present: RegExp[]; // must appear
  absent: RegExp[]; // must NOT appear
}
interface GoldenCase {
  log: string;
  combat: number; // 1-based
  label: string;
  asserts: Assertion[];
}

// Curated golden games — each pins an invariant established by a specific fix/feature this session.
const CASES: GoldenCase[] = [
  {
    log: 'WoWCombatLog-061426_015229',
    combat: 8,
    label: 'HPal 007 — Forbearance castability (4c2bbefd)',
    asserts: [
      {
        desc: 'Spellwarding/BoP/LoH marked Forbearance-locked (Divine Shield @3:17), not "available"',
        present: [/Blessing of Spellwarding \[Defensive\]: unavailable at death — Forbearance-locked/],
        absent: [/Blessing of Spellwarding \[Defensive\]: (NEVER USED|available|not yet used)/],
      },
      {
        desc: 'Divine Protection (not Forbearance-gated) still correctly available',
        present: [/Divine Protection \[Defensive\]: available at death time/],
        absent: [],
      },
    ],
  },
  {
    log: 'WoWCombatLog-061426_214211',
    combat: 19,
    label: 'Druid 052 — self-only dropped from teammate-death trace (ab4a56e4)',
    asserts: [
      {
        desc: 'self-only Barkskin/Frenzied Regen/Stampeding Roar not offered for a teammate death; Ironbark (external) kept',
        present: [/Ironbark \[Defensive\]:/],
        absent: [/Barkskin \[Defensive\]:/, /Frenzied Regeneration \[Defensive\]:/, /Stampeding Roar \[Defensive\]:/],
      },
    ],
  },
  {
    log: 'WoWCombatLog-062526_225714',
    combat: 27,
    label: 'HPal 735 — dead-owner note on a later teammate death (e9bcb486)',
    asserts: [
      {
        desc: 'owner-dead note present for the Warlock death after the paladin died',
        present: [/log owner \(healer\) was already dead at this time/],
        absent: [],
      },
    ],
  },
  {
    log: 'WoWCombatLog-061426_015229',
    combat: 13,
    label: 'Disc 011 — Atonement count ported (e4188bba)',
    asserts: [
      { desc: 'Active Atonements surfaced at the death', present: [/Active Atonements at death: \d+/], absent: [] },
    ],
  },
  {
    log: 'WoWCombatLog-061426_161452',
    combat: 3,
    label: 'Evoker 018 — channel-interrupt flag + PvP toolkit (e4188bba / db40da76)',
    asserts: [
      {
        desc: 'interrupted Emerald Communion flagged + toolkit present',
        present: [/Channels interrupted .*Emerald Communion/, /Your PvP toolkit:/],
        absent: [],
      },
    ],
  },
];

async function buildCtx(log: string, combat1: number): Promise<string | null> {
  const lp = path.join(LOGS, `${log}.txt`);
  if (!(await fs.pathExists(lp))) return null;
  const combats = await parseLogText(await fs.readFile(lp, 'utf8'));
  const combat = combats[combat1 - 1];
  if (!combat) return null;
  const units = Object.values(combat.units) as ICombatUnit[];
  const friends = units.filter((u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly);
  const enemies = units.filter((u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Hostile);
  const owner = friends.find((u) => isHealerSpec(u.spec)) ?? friends[0];
  return buildMatchContext(combat, friends, enemies, { owner });
}

// Run one case (build context + assert). The parser caches WoW-build state module-level across
// parses, so each case MUST run in its own process — otherwise a game parsed after a different-build
// log gets silently degraded. The orchestrator below spawns one child per case.
async function runOneCase(idx: number): Promise<number> {
  const c = CASES[idx];
  const ctx = await buildCtx(c.log, c.combat);
  if (!ctx) {
    console.log(`SKIP  ${c.label} (game not found)`);
    return 0;
  }
  let failures = 0;
  for (const a of c.asserts) {
    const missing = a.present.filter((r) => !r.test(ctx));
    const leaked = a.absent.filter((r) => r.test(ctx));
    if (missing.length === 0 && leaked.length === 0) {
      console.log(`PASS  ${c.label} :: ${a.desc}`);
    } else {
      failures++;
      console.log(`FAIL  ${c.label} :: ${a.desc}`);
      missing.forEach((r) => console.log(`        missing: ${r}`));
      leaked.forEach((r) => console.log(`        leaked:  ${r}`));
    }
  }
  return failures;
}

async function main() {
  const caseArg = process.argv.find((a) => a.startsWith('--case='));
  if (caseArg) {
    const failures = await runOneCase(Number(caseArg.split('=')[1]));
    process.exit(failures === 0 ? 0 : 1);
  }
  // Orchestrator: one isolated child process per case (avoids cross-parse build-state contamination).
  let failures = 0;
  for (let i = 0; i < CASES.length; i++) {
    try {
      const out = execFileSync('npx', ['ts-node', '--files', __filename, `--case=${i}`], { encoding: 'utf8' });
      process.stdout.write(out);
    } catch (err: unknown) {
      const e = err as { stdout?: string };
      if (e.stdout) process.stdout.write(e.stdout);
      failures++;
    }
  }
  console.log(`\n${failures === 0 ? '✓ ALL GREEN' : `✗ ${failures} CASE(S) WITH FAILURES`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

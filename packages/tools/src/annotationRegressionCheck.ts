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

const LOGS = path.resolve(__dirname, '../../../scratch/user-logs/wow');

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
  // Some invariants only hold in the timeline-prompt context (used by the eval corpus), not the
  // production critical-moments context built by default. Set true to build with useTimelinePrompt.
  timeline?: boolean;
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
  {
    // Pins spellEffects.json 204336 (Grounding Totem). de7f5765's spellEffects.json regen silently
    // dropped this hand-added F143 entry (21ee6dcd), killing all `[CD] … Grounding Totem` lines and
    // `[ABSORBED: …]` annotations (268 games → 0 in the 2026-07-09 week-eval corpus). The production
    // critical-moments context does not surface this game's Grounding Totem moment, but the
    // timeline-prompt context (used by the eval corpus that caught the regression) does — hence
    // `timeline: true` here.
    log: 'WoWCombatLog-061626_002047',
    combat: 17,
    label: 'RSham 159 — Grounding Totem CD + absorb annotation pinned (spellEffects.json 204336)',
    timeline: true,
    asserts: [
      {
        desc: 'Grounding Totem cooldown use and its absorb are both annotated',
        present: [/\[CD\][^\n]*Grounding Totem/, /ABSORBED/],
        absent: [],
      },
    ],
  },
];

async function buildCtx(log: string, combat1: number, useTimelinePrompt = false): Promise<string | null> {
  const lp = path.join(LOGS, `${log}.txt`);
  if (!(await fs.pathExists(lp))) return null;
  const combats = await parseLogText(await fs.readFile(lp, 'utf8'));
  const combat = combats[combat1 - 1];
  if (!combat) return null;
  const units = Object.values(combat.units) as ICombatUnit[];
  const friends = units.filter((u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly);
  const enemies = units.filter((u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Hostile);
  const owner = friends.find((u) => isHealerSpec(u.spec)) ?? friends[0];
  return buildMatchContext(combat, friends, enemies, { owner, useTimelinePrompt });
}

// Run one case (build context + assert). The parser caches WoW-build state module-level across
// parses, so each case MUST run in its own process — otherwise a game parsed after a different-build
// log gets silently degraded. The orchestrator below spawns one child per case.
async function runOneCase(idx: number): Promise<number> {
  const c = CASES[idx];
  const ctx = await buildCtx(c.log, c.combat, c.timeline ?? false);
  if (!ctx) {
    if (process.env.CI === 'true' || process.env.STRICT === 'true') {
      console.error(`FAIL  ${c.label} (Required golden log missing in strict/CI environment)`);
      return 1;
    }
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
  let skipped = 0;
  for (let i = 0; i < CASES.length; i++) {
    let out = '';
    try {
      out = execFileSync('npx', ['ts-node', '--files', __filename, `--case=${i}`], { encoding: 'utf8' });
      process.stdout.write(out);
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string };
      if (e.stdout) {
        out = e.stdout;
        process.stdout.write(e.stdout);
      }
      if (e.stderr) process.stderr.write(e.stderr);
      failures++;
    }
    if (out.split('\n').some((line) => line.startsWith('SKIP'))) {
      skipped++;
    }
  }

  // A run where every case was skipped (golden logs missing) exits 0 above and looks identical to a
  // real pass — this happened once in a worktree during the 2026-07-09 week-eval and was
  // indistinguishable from a genuine green run. Fail loudly instead of silently vacuous-passing.
  if (skipped === CASES.length) {
    console.log(`\n✗ VACUOUS PASS — 0 of ${CASES.length} cases ran (golden logs missing)`);
    process.exit(1);
  }

  const ran = CASES.length - skipped;
  console.log(
    `\n${
      failures === 0
        ? `✓ ALL GREEN (${ran} ran, ${skipped} skipped)`
        : `✗ ${failures} CASE(S) WITH FAILURES (${ran} ran, ${skipped} skipped)`
    }`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

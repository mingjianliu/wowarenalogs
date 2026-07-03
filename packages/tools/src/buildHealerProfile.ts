/* eslint-disable no-console */
import { CombatUnitReaction, CombatUnitType, IArenaMatch, ICombatUnit, IShuffleRound } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import path from 'path';

import { METRIC_REGISTRY, MetricKey } from '../../shared/src/components/CombatReport/CombatAIAnalysis/metricRegistry';
import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { computeHealerMetrics, IHealerMetrics } from '../../shared/src/utils/healerMetrics';
import { parseLogText } from './printMatchPrompts';

const LOGS_DIR = '/Users/mingjianliu/code/wowarenalogs/scratch/user-logs/wow';
const WORK_DIR = '/Users/mingjianliu/.gemini/tmp/wowarenalogs/healer-eval-user';
const INDEX_FILE = path.join(WORK_DIR, 'index.json');
const REF_VECTORS = path.join(__dirname, 'data/reference_vectors.json');
// Corpus of generated prompts (post-fix) whose deterministic annotations we mine for failure modes.
const CORPUS_DIR = '/Users/mingjianliu/code/wowarenalogs/scratch/healer-profile/f134b-after';
const OUT_DIR = '/Users/mingjianliu/code/wowarenalogs/scratch/healer-profile/profiles';

function toMetricRecord(m: IHealerMetrics): Record<MetricKey, number | null> {
  return {
    offensiveIndex: m.offensiveIndex,
    ccDensity: m.ccDensity,
    responseLatencySec: m.reactionLatency,
    defensiveOverlapRatio: m.defensiveOverlapRatio,
    effectiveCastRatio: m.effectiveCastRatio,
    ccAvoidanceRate: m.ccAvoidanceRate,
  };
}

const METRIC_KEYS = Object.keys(METRIC_REGISTRY) as MetricKey[];

/** Deterministic failure signals mined from a game's generated prompt. */
interface Failures {
  ownerDied: boolean;
  diedHoldingTool: boolean; // owner death line carries (Unused: <defensive>) or (PvP Trinket available)
  overCommit: number; // count of "cheaper available:" (a bigger CD used with a cheaper one up)
  idle: boolean; // an [INACTIVITY] gap on the owner
  missedPurge: boolean; // [MISSED PURGE OPPORTUNITY] present (purge-capable owners)
  // Specifics (for concrete, named suggestions):
  unusedAtDeath: string[]; // defensives listed unused on the owner's death line
  unpurgedBuffs: string[]; // enemy buffs left unpurged (one per [MISSED PURGE OPPORTUNITY])
  overCommitBig: string[]; // the big CD spent when a cheaper one was available
  trinketShortCC: boolean; // trinket cut a short/DR'd CC (wasted trinket)
}

function mineFailures(prompt: string): Failures {
  let ownerDied = false;
  let diedHoldingTool = false;
  let idle = false;
  const unusedAtDeath: string[] = [];
  const unpurgedBuffs: string[] = [];
  const overCommitBig: string[] = [];
  for (const line of prompt.split('\n')) {
    if (/\[DEATH\]\s+1\s+\(/.test(line)) {
      ownerDied = true;
      const um = line.match(/\(Unused:\s*([^)]+)\)/);
      if (um || line.includes('PvP Trinket available')) diedHoldingTool = true;
      if (um) unusedAtDeath.push(...um[1].split(',').map((s) => s.trim()));
    }
    if (line.includes('[INACTIVITY]') && /\s1 inactive/.test(line)) idle = true;
    const pm = line.match(/\[MISSED PURGE OPPORTUNITY\]\s+([A-Za-z][A-Za-z: ]+?)\s+active/);
    if (pm) unpurgedBuffs.push(pm[1].trim());
    if (line.includes('[YOU] [CD]') && line.includes('cheaper available:')) {
      const bm = line.match(/\[YOU\] \[CD\]\s+([A-Za-z][A-Za-z: ]+?)\s*\(/);
      if (bm) overCommitBig.push(bm[1].trim());
    }
  }
  return {
    ownerDied,
    diedHoldingTool,
    overCommit: (prompt.match(/cheaper available:/g) ?? []).length,
    idle,
    missedPurge: prompt.includes('[MISSED PURGE OPPORTUNITY]'),
    unusedAtDeath,
    unpurgedBuffs,
    overCommitBig,
    trinketShortCC: /trinket broke this CC after \ds \(cut short/.test(prompt),
  };
}

/** Top-N most frequent strings with their counts. */
function topN(items: string[], n: number): Array<{ name: string; count: number }> {
  const freq = new Map<string, number>();
  for (const it of items) freq.set(it, (freq.get(it) ?? 0) + 1);
  return [...freq.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

interface GameData {
  metrics: Record<MetricKey, number | null>;
  ccAvoided: number;
  ccLanded: number;
  failures: Failures | null;
}

interface Agg {
  median: number;
  p25: number;
  p75: number;
  n: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function aggregate(values: (number | null)[]): Agg {
  const v = values.filter((x): x is number => x !== null && !Number.isNaN(x)).sort((a, b) => a - b);
  if (v.length === 0) return { median: NaN, p25: NaN, p75: NaN, n: 0 };
  return { median: quantile(v, 0.5), p25: quantile(v, 0.25), p75: quantile(v, 0.75), n: v.length };
}

/** Percentile of the user's median within the cohort distribution, valence-adjusted (0 = worst, 100 = best). */
function percentileOf(cohortVals: (number | null)[], userMedian: number, valence: string): number {
  const v = cohortVals.filter((x): x is number => x !== null && !Number.isNaN(x));
  if (v.length === 0 || Number.isNaN(userMedian)) return NaN;
  const worse = v.filter((x) => (valence === 'lower' ? x > userMedian : x < userMedian)).length;
  return Math.round((worse / v.length) * 100);
}

async function main() {
  await fs.ensureDir(OUT_DIR);
  const index = await fs.readJson(INDEX_FILE);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refVectors: any[] = await fs.readJson(REF_VECTORS);

  const userBySpec = new Map<string, GameData[]>();
  let lastLogPath = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cachedCombats: any[] = [];

  for (const entry of index) {
    const m = entry.matchId.match(/^(.+)-c(\d+)$/);
    if (!m) continue;
    let logPath = path.join(LOGS_DIR, `${m[1]}.txt`);
    if (!(await fs.pathExists(logPath))) logPath = path.join(LOGS_DIR, `${m[1]}.log`);
    if (!(await fs.pathExists(logPath))) continue;
    if (logPath !== lastLogPath) {
      try {
        cachedCombats = await parseLogText(await fs.readFile(logPath, 'utf8'));
        lastLogPath = logPath;
      } catch {
        continue;
      }
    }
    const combat = cachedCombats[parseInt(m[2], 10) - 1] as IArenaMatch | IShuffleRound | undefined;
    if (!combat) continue;
    const friends = (Object.values(combat.units) as ICombatUnit[]).filter(
      (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
    );
    const healer = friends.find((p) => isHealerSpec(p.spec));
    if (!healer) continue;
    const spec = specToString(healer.spec);
    try {
      const metrics = computeHealerMetrics(combat, healer.name);
      // Mine failure signals from the matching generated prompt, if present.
      let failures: Failures | null = null;
      const promptPath = path.join(CORPUS_DIR, entry.file);
      if (await fs.pathExists(promptPath)) failures = mineFailures(await fs.readFile(promptPath, 'utf8'));
      const arr = userBySpec.get(spec) ?? [];
      arr.push({
        metrics: toMetricRecord(metrics),
        ccAvoided: metrics.ccAvoidedCount,
        ccLanded: metrics.ccLandedCount,
        failures,
      });
      userBySpec.set(spec, arr);
    } catch {
      /* skip games that fail metric computation */
    }
  }

  // Cohort per-spec pooled CC-avoidance + medians (from reference_vectors — ratios only, no counts).
  const cohortBySpec = new Map<string, Record<MetricKey, number | null>[]>();
  for (const r of refVectors) {
    if (!r.metrics) continue;
    const arr = cohortBySpec.get(r.spec) ?? [];
    arr.push({
      offensiveIndex: r.metrics.offensiveIndex,
      ccDensity: r.metrics.ccDensity,
      responseLatencySec: r.metrics.reactionLatency,
      defensiveOverlapRatio: r.metrics.defensiveOverlapRatio,
      effectiveCastRatio: r.metrics.effectiveCastRatio,
      ccAvoidanceRate: r.metrics.ccAvoidanceRate,
    });
    cohortBySpec.set(r.spec, arr);
  }

  const specs = [...userBySpec.keys()].sort(
    (a, b) => (userBySpec.get(b)?.length ?? 0) - (userBySpec.get(a)?.length ?? 0),
  );
  const out: string[] = [`# Healer Playing Profiles — ${index.length} games\n`];
  out.push(
    `Per-spec tendencies + recurring failure modes from all your games. **Prescriptive** metrics`,
    `(crisisActionable) are what to coach on; **descriptive** metrics are context only. CC Avoidance is`,
    `POOLED (total avoided / total incoming) — per-game rates are a sparse ~0 that hides the signal.`,
    `Cohort = 2300+ pros.\n`,
  );

  for (const spec of specs) {
    const games = userBySpec.get(spec) ?? [];
    const cohort = cohortBySpec.get(spec) ?? [];
    const fmt = (x: number, unit: string) => (Number.isNaN(x) ? 'n/a' : `${x.toFixed(2)}${unit}`);
    const pct = (x: number) => `${Math.round(x * 100)}%`;

    // Pooled CC avoidance (user) — total avoided / total incoming.
    const totAvoid = games.reduce((s, g) => s + g.ccAvoided, 0);
    const totIncoming = games.reduce((s, g) => s + g.ccAvoided + g.ccLanded, 0);
    const pooledUserAvoid = totIncoming > 0 ? totAvoid / totIncoming : 0;

    const presc: string[] = [];
    const desc: string[] = [];
    const jsonMetrics: Record<string, unknown> = {};
    for (const key of METRIC_KEYS) {
      // defensiveOverlapRatio measures same-target defensive panic-overlap — a genuinely rare event
      // (~1/150 games) that is ~0 for the user AND the cohort, so it can't discriminate. Drop it from
      // the profile rather than show a dead 0-for-everyone row.
      if (key === 'defensiveOverlapRatio') continue;
      const def = METRIC_REGISTRY[key];
      const you = aggregate(games.map((g) => g.metrics[key]));
      const coh = aggregate(cohort.map((g) => g[key]));
      const valence = def.valence === 'context' ? 'context' : `${def.valence} is better`;
      let line: string;
      const pctile = percentileOf(
        cohort.map((g) => g[key]),
        key === 'ccAvoidanceRate' ? pooledUserAvoid : you.median,
        def.valence,
      );
      if (key === 'ccAvoidanceRate') {
        jsonMetrics[key] = {
          pooled: pooledUserAvoid,
          totAvoid,
          totIncoming,
          cohort: { median: coh.median, p25: coh.p25, p75: coh.p75 },
          percentile: pctile,
          label: def.label,
          unit: def.unit,
          valence: def.valence,
          crisisActionable: def.crisisActionable,
          driver: def.driver,
        };
        line = `  - **${def.label}** (pooled): ${pct(pooledUserAvoid)} of incoming CC avoided (${totAvoid}/${totIncoming}) — _${def.driver}_`;
      } else {
        jsonMetrics[key] = {
          you,
          cohort: { median: coh.median, p25: coh.p25, p75: coh.p75 },
          percentile: pctile,
          label: def.label,
          unit: def.unit,
          valence: def.valence,
          crisisActionable: def.crisisActionable,
          driver: def.driver,
        };
        const cohStr = Number.isNaN(coh.median) ? '' : ` | cohort ${fmt(coh.median, def.unit)}`;
        const pStr = Number.isNaN(pctile) ? '' : ` [${pctile}th pctile]`;
        line = `  - **${def.label}**: ${fmt(you.median, def.unit)} [${fmt(you.p25, def.unit)}–${fmt(you.p75, def.unit)}] (${valence})${cohStr}${pStr} — _${def.driver}_`;
      }
      if (def.crisisActionable) presc.push(line);
      else desc.push(line);
    }

    // Prescriptive coaching hook: biggest deficit vs cohort on OI / CC Density.
    let headline = 'you match or beat the cohort on the prescriptive metrics';
    let worstGap = 0.05;
    for (const key of ['offensiveIndex', 'ccDensity'] as MetricKey[]) {
      const def = METRIC_REGISTRY[key];
      const you = aggregate(games.map((g) => g.metrics[key])).median;
      const coh = aggregate(cohort.map((g) => g[key])).median;
      if (Number.isNaN(you) || Number.isNaN(coh) || coh === 0) continue;
      const deficit = (coh - you) / coh;
      if (deficit > worstGap) {
        worstGap = deficit;
        headline = `**${def.label}** is your biggest gap — ${fmt(you, def.unit)} vs cohort ${fmt(coh, def.unit)} (${def.driver})`;
      }
    }

    // Failure modes (deterministic, from prompts).
    const withF = games.filter((g) => g.failures !== null);
    const deaths = withF.filter((g) => g.failures?.ownerDied);
    const diedHolding = deaths.filter((g) => g.failures?.diedHoldingTool).length;
    const idleGames = withF.filter((g) => g.failures?.idle).length;
    const missedPurgeGames = withF.filter((g) => g.failures?.missedPurge).length;
    const overCommitTotal = withF.reduce((s, g) => s + (g.failures?.overCommit ?? 0), 0);
    const fails: string[] = [];
    if (deaths.length > 0)
      fails.push(
        `  - **Died holding a defensive/trinket**: ${diedHolding}/${deaths.length} of your deaths (${pct(diedHolding / deaths.length)}) — a survival tool was still available`,
      );
    if (withF.length > 0) {
      fails.push(
        `  - **Over-commit (cheaper tool was up)**: ${(overCommitTotal / withF.length).toFixed(2)} flags/game — a shorter-CD survival tool was available when you spent a bigger one`,
      );
      fails.push(
        `  - **Idle gaps under pressure**: ${idleGames}/${withF.length} games (${pct(idleGames / withF.length)})`,
      );
      if (missedPurgeGames > 0)
        fails.push(
          `  - **Missed offensive purge**: ${missedPurgeGames}/${withF.length} games (${pct(missedPurgeGames / withF.length)})`,
        );
    }

    // ── Concrete, named suggestions from the cooldown-analysis specifics ──
    const nF = Math.max(1, withF.length);
    const allUnused = withF.flatMap((g) => g.failures?.unusedAtDeath ?? []);
    const allUnpurged = withF.flatMap((g) => g.failures?.unpurgedBuffs ?? []);
    const allOverBig = withF.flatMap((g) => g.failures?.overCommitBig ?? []);
    const trinketShortGames = withF.filter((g) => g.failures?.trinketShortCC).length;
    const oiPct = (jsonMetrics.offensiveIndex as { percentile?: number } | undefined)?.percentile;
    const suggestions: string[] = [];

    if (deaths.length >= 4 && diedHolding / deaths.length > 0.4 && allUnused.length > 0) {
      const t = topN(allUnused, 3);
      suggestions.push(
        `Use your kit before you die — in ${pct(diedHolding / deaths.length)} of your deaths you still had major cooldowns up (e.g. ${t.map((x) => x.name).join(', ')}). Set an earlier trigger to spend them.`,
      );
    }
    if (missedPurgeGames / nF > 0.15 && allUnpurged.length > 0) {
      const t = topN(allUnpurged, 2);
      suggestions.push(
        `Purge priority: ${t.map((x) => x.name).join(' and ')} — you leave these up most often (missed a purge in ${pct(missedPurgeGames / nF)} of games). Strip ${t[0].name} on cooldown.`,
      );
    }
    if (overCommitTotal / nF > 0.3 && allOverBig.length > 0) {
      const t = topN(allOverBig, 2);
      suggestions.push(
        `Hold your big cooldowns — you spend ${t.map((x) => x.name).join(' / ')} with a cheaper tool up (${(overCommitTotal / nF).toFixed(1)} flags/game). Save ${t[0].name} for real enemy burst.`,
      );
    }
    if (idleGames / nF > 0.25) {
      suggestions.push(
        `Cut idle time — you have an inactive gap under pressure in ${pct(idleGames / nF)} of games. Fill it with a damage or CC cast.`,
      );
    }
    if (oiPct != null && oiPct < 40) {
      const OFFENSIVE_HINT: Record<string, string> = {
        'Restoration Shaman': 'keep Flame Shock up + Lava Burst on procs',
        'Discipline Priest': 'keep Shadow Word: Pain up + weave Smite/Penance',
        'Holy Priest': 'keep Shadow Word: Pain up + Holy Fire',
        'Restoration Druid': 'keep Moonfire/Sunfire up + Wrath fillers',
        'Holy Paladin': 'weave Holy Shock (dmg) + Judgment + Crusader Strike',
        'Mistweaver Monk': 'weave Rising Sun Kick + Tiger Palm (fistweave)',
        'Preservation Evoker': 'weave Living Flame + Fire Breath',
      };
      suggestions.push(
        `Weave more damage — Offensive Index at the ${oiPct}th percentile. In the calm windows (low healing demand), ${OFFENSIVE_HINT[spec] ?? 'press your damage casts'}.`,
      );
    }
    if (suggestions.length === 0)
      suggestions.push(`Clean profile — no dominant, deterministic mistake pattern on this spec.`);

    out.push(`\n## ${spec} — ${games.length} games`);
    out.push(`  _Coaching hook:_ ${headline}.`);
    out.push(`  **Do this to improve (ranked):**`, ...suggestions.map((s, i) => `  ${i + 1}. ${s}`));
    out.push(`  **Prescriptive metrics:**`, ...presc);
    out.push(`  **Descriptive (context only):**`, ...desc);
    out.push(`  **Failure-mode rates:**`, ...fails);

    await fs.writeJson(
      path.join(OUT_DIR, `${spec.replace(/\s+/g, '')}.json`),
      {
        spec,
        games: games.length,
        suggestions,
        metrics: jsonMetrics,
        failureModes: {
          deaths: deaths.length,
          diedHoldingTool: diedHolding,
          idleGames,
          missedPurgeGames,
          overCommitPerGame: withF.length > 0 ? overCommitTotal / withF.length : 0,
          topUnusedAtDeath: topN(allUnused, 4),
          topUnpurgedBuffs: topN(allUnpurged, 4),
          topOverCommitCDs: topN(allOverBig, 4),
          trinketShortGames,
        },
      },
      { spaces: 2 },
    );
  }

  const outMd = path.join(OUT_DIR, 'PROFILES.md');
  await fs.writeFile(outMd, out.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${specs.length} spec profiles + ${outMd}`);
  for (const spec of specs) console.log(`  ${spec}: ${userBySpec.get(spec)?.length ?? 0} games`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

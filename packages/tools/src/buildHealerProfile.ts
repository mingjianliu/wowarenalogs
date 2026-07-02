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
const OUT_DIR = '/Users/mingjianliu/code/wowarenalogs/scratch/healer-profile/profiles';

/** Map a healerMetrics result onto the registry's MetricKeys. */
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

function quantile(sortedVals: number[], q: number): number {
  if (sortedVals.length === 0) return NaN;
  const idx = (sortedVals.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedVals[lo];
  return sortedVals[lo] + (sortedVals[hi] - sortedVals[lo]) * (idx - lo);
}

interface Agg {
  median: number;
  p25: number;
  p75: number;
  mean: number;
  n: number;
}

function aggregate(values: (number | null)[]): Agg {
  const v = values.filter((x): x is number => x !== null && !Number.isNaN(x)).sort((a, b) => a - b);
  if (v.length === 0) return { median: NaN, p25: NaN, p75: NaN, mean: NaN, n: 0 };
  return {
    median: quantile(v, 0.5),
    p25: quantile(v, 0.25),
    p75: quantile(v, 0.75),
    mean: v.reduce((a, b) => a + b, 0) / v.length,
    n: v.length,
  };
}

async function main() {
  await fs.ensureDir(OUT_DIR);
  const index = await fs.readJson(INDEX_FILE);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refVectors: any[] = await fs.readJson(REF_VECTORS);

  // Collect user per-game metrics grouped by spec.
  const userBySpec = new Map<string, Record<MetricKey, number | null>[]>();
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
      const arr = userBySpec.get(spec) ?? [];
      arr.push(toMetricRecord(metrics));
      userBySpec.set(spec, arr);
    } catch {
      /* skip games that fail metric computation */
    }
  }

  // Cohort medians per spec (from reference_vectors).
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
  const summaryLines: string[] = [`# Healer Playing Profiles — ${index.length} games\n`];
  summaryLines.push(
    `Per-spec tendencies from all your games. **Prescriptive** metrics (crisisActionable) are the ones to`,
    `coach on; **descriptive** metrics are context only — don't over-read them. Cohort = 2300+ pros.\n`,
  );

  for (const spec of specs) {
    const games = userBySpec.get(spec) ?? [];
    const cohort = cohortBySpec.get(spec) ?? [];
    const fmt = (x: number, unit: string) => (Number.isNaN(x) ? 'n/a' : `${x.toFixed(2)}${unit}`);

    const perMetric: Record<string, unknown> = {};
    const presc: string[] = [];
    const desc: string[] = [];
    for (const key of METRIC_KEYS) {
      const def = METRIC_REGISTRY[key];
      const you = aggregate(games.map((g) => g[key]));
      const coh = aggregate(cohort.map((g) => g[key]));
      perMetric[key] = { you, cohortMedian: coh.median };
      const cohStr = Number.isNaN(coh.median) ? '' : ` | cohort ${fmt(coh.median, def.unit)}`;
      const valence = def.valence === 'context' ? 'context' : `${def.valence} is better`;
      const line = `  - **${def.label}**: ${fmt(you.median, def.unit)} [${fmt(you.p25, def.unit)}–${fmt(you.p75, def.unit)}] (${valence})${cohStr} — _${def.driver}_`;
      if (def.crisisActionable) presc.push(line);
      else desc.push(line);
    }

    // Headline: biggest gap on a prescriptive metric (worse side of cohort).
    let headline = 'no cohort data';
    let worstGap = -Infinity;
    for (const key of METRIC_KEYS) {
      const def = METRIC_REGISTRY[key];
      if (!def.crisisActionable) continue;
      const you = aggregate(games.map((g) => g[key])).median;
      const coh = aggregate(cohort.map((g) => g[key])).median;
      if (Number.isNaN(you) || Number.isNaN(coh) || coh === 0) continue;
      // gap on the worse side (higher-is-better ⇒ deficit; lower-is-better handled by valence)
      const deficit = def.valence === 'lower' ? (you - coh) / coh : (coh - you) / coh;
      if (deficit > worstGap) {
        worstGap = deficit;
        headline =
          deficit > 0.05
            ? `**${def.label}** is your biggest gap — ${fmt(you, def.unit)} vs cohort ${fmt(coh, def.unit)} (${def.driver}).`
            : `no material gap — you match or beat the cohort on all prescriptive metrics.`;
      }
    }

    summaryLines.push(`\n## ${spec} — ${games.length} games`);
    summaryLines.push(`  _Coaching hook:_ ${headline}`);
    summaryLines.push(`  **Prescriptive tendencies (coach on these):**`, ...presc);
    summaryLines.push(`  **Descriptive (context only — don't over-coach):**`, ...desc);

    await fs.writeJson(
      path.join(OUT_DIR, `${spec.replace(/\s+/g, '')}.json`),
      { spec, games: games.length, perMetric },
      {
        spaces: 2,
      },
    );
  }

  const outMd = path.join(OUT_DIR, 'PROFILES.md');
  await fs.writeFile(outMd, summaryLines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${specs.length} spec profiles + ${outMd}`);
  for (const spec of specs) console.log(`  ${spec}: ${userBySpec.get(spec)?.length ?? 0} games`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/* eslint-disable no-console */
/**
 * buildArchetypePrompts.ts — Match Archetype Clustering (Phase 2)
 *
 * Reads features.jsonl produced by extractArchetypeFeatures.ts, clusters ALL matches
 * across all healer specs into universal game-situation archetypes via k-means.
 *
 * Archetypes describe what the ENEMY team is doing, not the healer's spec.
 * A "cc_setup_nuke" game is that kind of game whether the healer is Disc Priest or Resto Druid.
 *
 * Outputs:
 *   archetypes/archetype_prompts_{bracket}_draft.json  (stats + empty promptText)
 *   archetypes/archetype_model_{bracket}.json          (global centroids for live lookup)
 *
 * Usage:
 *   npm run -w @wowarenalogs/tools start:buildArchetypePrompts
 *
 * Env vars:
 *   K=8             number of global clusters (default 8)
 *   MIN_MATCHES=20  minimum matches per cluster to include (default 20)
 *   BRACKET=3v3     bracket (default 3v3)
 */
import fs from 'fs-extra';
import { kmeans } from 'ml-kmeans';
import path from 'path';

import {
  IArchetypeFeatureRow,
  IFullBehavioralFeatures,
  IMatchDynamicFeatures,
  IPositioningStats,
  IResponseLatency,
  ITimingDistribution,
} from './extractArchetypeFeatures';

// ── Config ────────────────────────────────────────────────────────────────────

const K = parseInt(process.env.K ?? '8', 10);
const MIN_MATCHES = parseInt(process.env.MIN_MATCHES ?? '20', 10);
const BRACKET = process.env.BRACKET ?? '3v3';
const BRACKET_SLUG = BRACKET.toLowerCase().includes('solo') ? 'solo_shuffle' : '3v3';

const ARCHETYPES_DIR = path.join(__dirname, '../archetypes');
const FEATURES_FILE = path.join(ARCHETYPES_DIR, `features_${BRACKET_SLUG}.jsonl`);
const DRAFT_FILE = path.join(ARCHETYPES_DIR, `archetype_prompts_${BRACKET_SLUG}_draft.json`);
export const PROMPTS_FILE = path.join(ARCHETYPES_DIR, `archetype_prompts_${BRACKET_SLUG}.json`);
const MODEL_FILE = path.join(ARCHETYPES_DIR, `archetype_model_${BRACKET_SLUG}.json`);

// ── Feature vector for clustering ────────────────────────────────────────────

// 7 match-dynamic dimensions — all describe the game situation, not the healer's spec:
//   0: burstWindowCount        — how many coordinated enemy pushes per round
//   1: ccEventsPerMinute       — CC density landing on the friendly team
//   2: tunnelScore             — 1.0 = pure tunnel, 0.0 = constant target swaps
//   3: peakBurstScore (log)    — intensity of the most dangerous burst window
//   4: criticalOrExposedBurstWindows — healer danger exposure
//   5: durationSeconds (log)   — round length
//   6: ownTeamCCPerMin         — how aggressively friendly team CCs enemies;
//                                separates "healer under siege" from "healer coasting"
const FEATURE_NAMES = [
  'burstWindowCount',
  'ccEventsPerMinute',
  'tunnelScore',
  'peakBurstScore',
  'criticalOrExposedBurstWindows',
  'durationSeconds',
  'ownTeamCCPerMin',
] as const;

function toFeatureVector(d: IMatchDynamicFeatures): number[] {
  return [
    d.burstWindowCount,
    d.ccEventsPerMinute,
    d.tunnelScore,
    Math.log1p(d.peakBurstScore),
    d.criticalOrExposedBurstWindows ?? 0,
    Math.log1p(d.durationSeconds),
    d.ownTeamCCPerMin,
  ];
}

// ── Normalization ─────────────────────────────────────────────────────────────

interface INormParams {
  min: number[];
  max: number[];
}

function computeNormParams(vectors: number[][]): INormParams {
  const dim = vectors[0].length;
  const min = Array(dim).fill(Infinity) as number[];
  const max = Array(dim).fill(-Infinity) as number[];
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      if (v[i] < min[i]) min[i] = v[i];
      if (v[i] > max[i]) max[i] = v[i];
    }
  }
  return { min, max };
}

function normalize(v: number[], params: INormParams): number[] {
  return v.map((x, i) => {
    const range = params.max[i] - params.min[i];
    return range > 0 ? (x - params.min[i]) / range : 0;
  });
}

// ── Stat helpers ──────────────────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function p90Of(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(0.9 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function roundTo(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

// ── Output types ──────────────────────────────────────────────────────────────

interface IAggregatedBehaviors {
  cdTiming: ITimingDistribution;
  cdNeverUsedRate: number;
  cdResponseLatencyMs: IResponseLatency | null;
  ccOffensivePerMatch: { mean: number; p75: number };
  drChainsCausedPerMatch: number;
  purgeRatePerMin: number | null;
  missedCleanseRate: number | null;
  healingGapRate: number;
  offensiveParticipationRate: number;
  setupStyleBreakdown: { one_shot_burst: number; cc_then_burst: number; flat_dampening: number; unknown: number };
  positioningBreakdown: Record<string, number> | null;
}

interface IDynamicSummary {
  burstWindowCount: number;
  ccEventsPerMinute: number;
  tunnelScore: number;
  peakBurstScore: number;
  durationSeconds: number;
}

export interface IArchetypeCluster {
  label: string;
  /**
   * True for clusters that represent one-sided / fast-win rounds with no coaching
   * value (e.g., 3v3 cluster_2, SS cluster_7). Production skips injection for these.
   */
  isNoise?: boolean;
  matchCount: number;
  minRating: number;
  generatedAt: string;
  specDistribution: Record<string, number>;
  dynamics: IDynamicSummary;
  behaviors: IAggregatedBehaviors;
  enemyHealerPartial: {
    note: string;
    cdCastsObserved: Record<string, number>;
    ccOffensivePerMatch: number;
  } | null;
  promptText: string;
}

// Flat map: cluster_key → cluster data (no longer nested by healer spec)
export type IArchetypePrompts = Record<string, IArchetypeCluster>;

export interface IArchetypeModel {
  generatedAt: string;
  normParams: INormParams;
  featureNames: readonly string[];
  centroids: number[][];
}

// ── Load JSONL ────────────────────────────────────────────────────────────────

async function loadFeatures(): Promise<IArchetypeFeatureRow[]> {
  if (!(await fs.pathExists(FEATURES_FILE))) {
    throw new Error(`features.jsonl not found at ${FEATURES_FILE}. Run extractArchetypeFeatures first.`);
  }
  const content = await fs.readFile(FEATURES_FILE, 'utf-8');
  const rows: IArchetypeFeatureRow[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as IArchetypeFeatureRow);
    } catch {
      /* skip malformed lines */
    }
  }
  return rows;
}

// ── Aggregation ───────────────────────────────────────────────────────────────

function aggregateDynamics(rows: IArchetypeFeatureRow[]): IDynamicSummary {
  const own = rows.filter((r) => r.perspective === 'own');
  return {
    burstWindowCount: roundTo(mean(own.map((r) => r.matchDynamic.burstWindowCount)), 1),
    ccEventsPerMinute: roundTo(mean(own.map((r) => r.matchDynamic.ccEventsPerMinute)), 2),
    tunnelScore: roundTo(mean(own.map((r) => r.matchDynamic.tunnelScore)), 3),
    peakBurstScore: roundTo(mean(own.map((r) => r.matchDynamic.peakBurstScore)), 1),
    durationSeconds: roundTo(mean(own.map((r) => r.matchDynamic.durationSeconds)), 0),
  };
}

function aggregateSpecDistribution(rows: IArchetypeFeatureRow[]): Record<string, number> {
  const own = rows.filter((r) => r.perspective === 'own');
  const counts: Record<string, number> = {};
  for (const row of own) {
    counts[row.healerSpec] = (counts[row.healerSpec] ?? 0) + 1;
  }
  return counts;
}

function aggregateBehaviors(rows: IArchetypeFeatureRow[]): IAggregatedBehaviors {
  const own = rows.filter((r) => r.perspective === 'own');

  const timingKeys: (keyof ITimingDistribution)[] = ['Optimal', 'Early', 'Late', 'Reactive', 'Unknown'];
  const timingAccum: Record<string, number[]> = { Optimal: [], Early: [], Late: [], Reactive: [], Unknown: [] };
  const cdNeverUsedRates: number[] = [];
  const latencyMedians: number[] = [];
  const latencyP90s: number[] = [];
  const ccOffensiveCounts: number[] = [];
  const drChainsCounts: number[] = [];
  const purgeRates: number[] = [];
  const cleanseRates: number[] = [];
  const gapRates: number[] = [];
  const offParticipation: number[] = [];
  const setupStyles: IMatchDynamicFeatures['setupStyle'][] = [];
  const positionClusters: IPositioningStats['cluster'][] = [];

  for (const row of own) {
    const b = row.behavioral as IFullBehavioralFeatures;
    for (const k of timingKeys) {
      timingAccum[k].push(b.cdTimingDistribution[k]);
    }
    cdNeverUsedRates.push(b.cdNeverUsedRate);
    if (b.cdResponseLatencyMs) {
      latencyMedians.push(b.cdResponseLatencyMs.median);
      latencyP90s.push(b.cdResponseLatencyMs.p90);
    }
    ccOffensiveCounts.push(b.ccOffensiveSentPerMatch);
    drChainsCounts.push(b.drChainsCaused);
    if (b.purgeRate !== null) purgeRates.push(b.purgeRate);
    if (b.missedCleanseRate !== null) cleanseRates.push(b.missedCleanseRate);
    gapRates.push(b.healingGapRate);
    offParticipation.push(b.offensiveParticipationRate);
    setupStyles.push(row.matchDynamic.setupStyle);
    if (b.positioning) positionClusters.push(b.positioning.cluster);
  }

  const cdTiming = Object.fromEntries(
    timingKeys.map((k) => [k, roundTo(mean(timingAccum[k]), 3)]),
  ) as unknown as ITimingDistribution;

  const ccSorted = [...ccOffensiveCounts].sort((a, b) => a - b);
  const ccP75 = ccSorted.length > 0 ? ccSorted[Math.ceil(0.75 * ccSorted.length) - 1] : 0;

  const setupBreakdown = { one_shot_burst: 0, cc_then_burst: 0, flat_dampening: 0, unknown: 0 };
  for (const s of setupStyles) setupBreakdown[s]++;
  const styleTotal = setupStyles.length || 1;
  for (const k of Object.keys(setupBreakdown) as (keyof typeof setupBreakdown)[]) {
    setupBreakdown[k] = roundTo(setupBreakdown[k] / styleTotal, 3);
  }

  let positioningBreakdown: Record<string, number> | null = null;
  if (positionClusters.length > 0) {
    const counts: Record<string, number> = {};
    for (const c of positionClusters) counts[c] = (counts[c] ?? 0) + 1;
    const total = positionClusters.length;
    positioningBreakdown = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, roundTo(v / total, 3)]));
  }

  return {
    cdTiming,
    cdNeverUsedRate: roundTo(mean(cdNeverUsedRates), 3),
    cdResponseLatencyMs:
      latencyMedians.length > 0
        ? { median: Math.round(medianOf(latencyMedians)), p90: Math.round(p90Of(latencyP90s)) }
        : null,
    ccOffensivePerMatch: { mean: roundTo(mean(ccOffensiveCounts), 2), p75: ccP75 },
    drChainsCausedPerMatch: roundTo(mean(drChainsCounts), 2),
    purgeRatePerMin: purgeRates.length > 0 ? roundTo(mean(purgeRates), 3) : null,
    missedCleanseRate: cleanseRates.length > 0 ? roundTo(mean(cleanseRates), 3) : null,
    healingGapRate: roundTo(mean(gapRates), 3),
    offensiveParticipationRate: roundTo(mean(offParticipation), 3),
    setupStyleBreakdown: setupBreakdown,
    positioningBreakdown,
  };
}

function aggregateEnemyHealer(rows: IArchetypeFeatureRow[]): IArchetypeCluster['enemyHealerPartial'] {
  const enemy = rows.filter((r) => r.perspective === 'enemy');
  if (enemy.length === 0) return null;

  const cdCounts: Record<string, number[]> = {};
  const ccCounts: number[] = [];

  for (const row of enemy) {
    const b = row.behavioral as { cdCastsObserved: Record<string, number>; ccOffensiveSentPerMatch: number };
    ccCounts.push(b.ccOffensiveSentPerMatch);
    for (const [spellName, count] of Object.entries(b.cdCastsObserved)) {
      const bucket = cdCounts[spellName] ?? [];
      bucket.push(count);
      cdCounts[spellName] = bucket;
    }
  }

  return {
    note: 'lower fidelity — cast events only, no HP/resource context',
    cdCastsObserved: Object.fromEntries(
      Object.entries(cdCounts).map(([name, counts]) => [name, roundTo(mean(counts), 2)]),
    ),
    ccOffensivePerMatch: roundTo(mean(ccCounts), 2),
  };
}

// ── Narrative prompt builder ──────────────────────────────────────────────────

export function buildNarrativePrompt(clusterLabel: string, dynamics: IDynamicSummary): string {
  // Translate raw dimensions into natural language for the generation prompt.
  // The numbers stay in the generation prompt for Claude's reference but must not appear in the output.
  const durationDesc =
    dynamics.durationSeconds < 70
      ? `very short rounds averaging ${dynamics.durationSeconds}s`
      : dynamics.durationSeconds < 110
        ? `medium-short rounds averaging ${dynamics.durationSeconds}s`
        : dynamics.durationSeconds < 160
          ? `medium-long rounds averaging ${dynamics.durationSeconds}s`
          : `long rounds averaging ${dynamics.durationSeconds}s`;

  const ccDesc =
    dynamics.ccEventsPerMinute < 7
      ? 'low CC — enemies rarely chain crowd control'
      : dynamics.ccEventsPerMinute < 9.5
        ? 'moderate CC — enemies use crowd control but not as a primary setup tool'
        : 'high CC — enemies chain crowd control heavily as a core part of their strategy';

  const focusDesc =
    dynamics.tunnelScore > 0.7
      ? 'enemies lock onto one target and do not switch'
      : dynamics.tunnelScore > 0.58
        ? 'enemies mostly focus one target with occasional swaps'
        : 'enemies rotate targets frequently, switching pressure to find an opening';

  const burstDesc =
    dynamics.burstWindowCount < 0.5
      ? 'no real coordinated kill windows — damage is steady and uncoordinated throughout'
      : dynamics.burstWindowCount < 1.5
        ? `one coordinated kill push per round, with a meaningful danger spike when it arrives`
        : `${Math.round(dynamics.burstWindowCount)} coordinated kill pushes per round, each telegraphed by cooldown usage`;

  const lines: string[] = [
    `You are writing a game-situation description for an arena healer coaching tool.`,
    ``,
    `Write a description with exactly TWO short paragraphs, clearly labeled:`,
    ``,
    `**Opponents:** (1–2 sentences) Describe what the enemy team does in this type of game.`,
    `Use plain arena language: do they tunnel one target or swap? Do they CC first and then burst,`,
    `or just apply constant pressure? How dangerous are their kill windows and how predictable?`,
    ``,
    `**Your role:** (1–2 sentences) Describe the key decision the healer faces in this situation.`,
    `What is the most important thing to get right — cooldown timing, trinket usage, dispel priority,`,
    `staying alive through CC, etc.? What is the most common failure mode?`,
    ``,
    `STRICT RULES:`,
    `- No metric names: do not write "tunnelScore", "burstWindowCount", "peakBurstScore", "ccEventsPerMinute" or any number from the data.`,
    `- No prescriptive language like "you must", "always", "never". Describe the situation, not instructions.`,
    `- Generic enough to apply to any healer spec — do not mention specific spells or class names.`,
    `- The cluster label is "${clusterLabel}" — write based on the data description below, not the label name.`,
    ``,
    `Game situation (translate into natural language, do not quote these values directly):`,
    `- Round length: ${durationDesc}`,
    `- Enemy CC on your team: ${ccDesc}`,
    `- Enemy target focus: ${focusDesc}`,
    `- Enemy burst pattern: ${burstDesc}`,
  ];

  return lines.join('\n');
}

// ── Print cluster summary ─────────────────────────────────────────────────────

function printClusterSummary(
  clusterIdx: number,
  centroid: number[],
  normParams: INormParams,
  rows: IArchetypeFeatureRow[],
) {
  const denorm = centroid.map((x, i) => {
    const range = normParams.max[i] - normParams.min[i];
    return range > 0 ? x * range + normParams.min[i] : normParams.min[i];
  });

  const own = rows.filter((r) => r.perspective === 'own');
  const specCounts = aggregateSpecDistribution(rows);
  const specSummary = Object.entries(specCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s.replace(/[a-z]/g, '')}:${n}`)
    .join(' ');

  console.log(`\n  cluster_${clusterIdx} (N=${own.length})  specs: ${specSummary}`);
  FEATURE_NAMES.forEach((name, i) => {
    console.log(`    ${name.padEnd(32)}: ${roundTo(denorm[i], 2)}`);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Loading features from ${FEATURES_FILE}...`);
  const allRows = await loadFeatures();
  const ownRows = allRows.filter((r) => r.perspective === 'own');
  console.log(`Loaded ${allRows.length} rows total, ${ownRows.length} own-healer.`);

  const specCounts: Record<string, number> = {};
  for (const row of ownRows) specCounts[row.healerSpec] = (specCounts[row.healerSpec] ?? 0) + 1;
  console.log('\nSpec distribution in corpus:');
  for (const [spec, n] of Object.entries(specCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${spec}: ${n}`);
  }
  console.log(`\nClustering into K=${K} global clusters (MIN_MATCHES=${MIN_MATCHES})...`);

  if (ownRows.length < K * MIN_MATCHES) {
    throw new Error(
      `Not enough rows (${ownRows.length}) for K=${K} with MIN_MATCHES=${MIN_MATCHES}. Need at least ${K * MIN_MATCHES}.`,
    );
  }

  const vectors = ownRows.map((r) => toFeatureVector(r.matchDynamic));
  const normParams = computeNormParams(vectors);
  const normalized = vectors.map((v) => normalize(v, normParams));

  const result = kmeans(normalized, K, { initialization: 'kmeans++', maxIterations: 200 });

  const clusterRows = Array.from({ length: K }, () => [] as IArchetypeFeatureRow[]);
  result.clusters.forEach((clusterIdx: number, rowIdx: number) => {
    clusterRows[clusterIdx].push(ownRows[rowIdx]);
  });

  console.log('\nCluster centroids:');
  clusterRows.forEach((rows, idx) => printClusterSummary(idx, result.centroids[idx], normParams, rows));

  // Load existing draft to preserve labels across re-runs
  const existingDraft: IArchetypePrompts = (await fs.pathExists(DRAFT_FILE))
    ? ((await fs.readJson(DRAFT_FILE)) as IArchetypePrompts)
    : {};

  const prompts: IArchetypePrompts = {};

  for (let clusterIdx = 0; clusterIdx < K; clusterIdx++) {
    const rows = clusterRows[clusterIdx];
    if (rows.length < MIN_MATCHES) {
      console.log(`\n  cluster_${clusterIdx}: skipped (${rows.length} < ${MIN_MATCHES}).`);
      continue;
    }

    const clusterKey = `cluster_${clusterIdx}`;
    const existingLabel = existingDraft[clusterKey]?.label;
    const label = existingLabel && existingLabel !== 'pending_review' ? existingLabel : 'pending_review';

    const dynamics = aggregateDynamics(rows);
    const specDistribution = aggregateSpecDistribution(rows);
    const behaviors = aggregateBehaviors(rows);

    const matchIds = new Set(rows.map((r) => r.matchId));
    const enemyRows = allRows.filter((r) => r.perspective === 'enemy' && matchIds.has(r.matchId));
    const enemyHealerPartial = aggregateEnemyHealer(enemyRows);

    prompts[clusterKey] = {
      label,
      matchCount: rows.length,
      minRating: 2000,
      generatedAt: new Date().toISOString(),
      specDistribution,
      dynamics,
      behaviors,
      enemyHealerPartial,
      promptText: existingDraft[clusterKey]?.promptText ?? '',
    };
  }

  await fs.ensureDir(ARCHETYPES_DIR);
  await fs.writeJson(DRAFT_FILE, prompts, { spaces: 2 });
  console.log(`\nWrote draft: ${DRAFT_FILE}`);

  const model: IArchetypeModel = {
    generatedAt: new Date().toISOString(),
    normParams,
    featureNames: FEATURE_NAMES,
    centroids: result.centroids,
  };
  await fs.writeJson(MODEL_FILE, model, { spaces: 2 });
  console.log(`Wrote model: ${MODEL_FILE}`);

  console.log('\nCluster summary table:');
  console.log('  key        label                           N    dur   cc/min  tunnel  burst#  peak');
  for (const [key, c] of Object.entries(prompts).sort()) {
    const d = c.dynamics;
    console.log(
      `  ${key.padEnd(10)} ${c.label.padEnd(32)} ${String(c.matchCount).padStart(4)}  ${String(d.durationSeconds).padStart(4)}s  ${String(d.ccEventsPerMinute).padStart(5)}   ${d.tunnelScore.toFixed(2)}   ${d.burstWindowCount.toFixed(1)}    ${String(d.peakBurstScore).padStart(4)}`,
    );
  }

  console.log('\nNext steps:');
  console.log('  1. Inspect cluster centroids and spec distributions above.');
  console.log('  2. Rename "pending_review" labels in the draft JSON.');
  console.log('  3. Re-run /build-match-archetypes to generate narratives.');
  console.log('  4. Commit archetype_prompts.json + archetype_model.json.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

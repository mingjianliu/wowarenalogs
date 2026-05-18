/* eslint-disable no-console */
/**
 * buildArchetypePrompts.ts — Match Archetype Clustering (Phase 2)
 *
 * Reads features.jsonl produced by extractArchetypeFeatures.ts, clusters matches into
 * dynamic archetypes per healer spec via k-means, and aggregates behavioral stats per cluster.
 *
 * Outputs a DRAFT JSON (promptText: "") — narrative generation is handled separately by
 * a Claude Code subagent reading archetype_prompts_draft.json.
 *
 * Outputs:
 *   packages/tools/archetypes/archetype_prompts_draft.json  (stats + empty promptText)
 *   packages/tools/archetypes/archetype_model.json          (centroids for future live lookup)
 *
 * Usage:
 *   npm run -w @wowarenalogs/tools start:buildArchetypePrompts
 *
 * Env vars:
 *   K=4             number of clusters per spec (default 4)
 *   MIN_MATCHES=10  minimum matches per cluster to include (default 10)
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

const K = parseInt(process.env.K ?? '4', 10);
const MIN_MATCHES = parseInt(process.env.MIN_MATCHES ?? '10', 10);

const ARCHETYPES_DIR = path.join(__dirname, '../archetypes');
const FEATURES_FILE = path.join(ARCHETYPES_DIR, 'features.jsonl');
// Draft: stats only, promptText = "". Narratives are added by the Claude Code skill.
const DRAFT_FILE = path.join(ARCHETYPES_DIR, 'archetype_prompts_draft.json');
// Final path — written by the Claude Code skill after narrative generation.
export const PROMPTS_FILE = path.join(ARCHETYPES_DIR, 'archetype_prompts.json');
const MODEL_FILE = path.join(ARCHETYPES_DIR, 'archetype_model.json');

// ── Feature vector for clustering ────────────────────────────────────────────

// Only own-healer rows are used for clustering. The 6 match-dynamic dimensions:
//   0: burstWindowCount
//   1: ccEventsPerMinute
//   2: tunnelScore (friendlyDamageShare[0].share)
//   3: peakBurstScore
//   4: criticalOrExposedBurstWindows (0 when null)
//   5: durationSeconds
const FEATURE_NAMES = [
  'burstWindowCount',
  'ccEventsPerMinute',
  'tunnelScore',
  'peakBurstScore',
  'criticalOrExposedBurstWindows',
  'durationSeconds',
] as const;

function toFeatureVector(d: IMatchDynamicFeatures): number[] {
  return [
    d.burstWindowCount,
    d.ccEventsPerMinute,
    d.tunnelScore,
    d.peakBurstScore,
    d.criticalOrExposedBurstWindows ?? 0,
    d.durationSeconds,
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
  matchCount: number;
  minRating: number;
  generatedAt: string;
  dynamics: IDynamicSummary;
  behaviors: IAggregatedBehaviors;
  enemyHealerPartial: {
    note: string;
    cdCastsObserved: Record<string, number>;
    ccOffensivePerMatch: number;
  } | null;
  promptText: string;
}

export type IArchetypePrompts = Record<string, Record<string, IArchetypeCluster>>;

interface IArchetypeModel {
  generatedAt: string;
  normParams: INormParams;
  featureNames: readonly string[];
  specModels: Record<string, { centroids: number[][] }>;
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

// ── Aggregate behaviors for a cluster of own-healer rows ─────────────────────

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
  ) as ITimingDistribution;

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

// ── Narrative prompt builder (exported for Claude Code skill) ─────────────────

export function buildNarrativePrompt(
  spec: string,
  clusterLabel: string,
  dynamics: IDynamicSummary,
  behaviors: IAggregatedBehaviors,
): string {
  const lines: string[] = [
    `You are summarizing observed behavioral patterns from high-rated (2400+ MMR) 3v3 arena matches.`,
    `Write exactly 2-3 sentences describing how ${spec} healers actually play in this match dynamic.`,
    `Be specific and factual. Describe what they do, not what they should do.`,
    `Avoid "should", "must", "always", "never". Express only what the data shows.`,
    `The cluster label is "${clusterLabel}" (may be "pending_review" — describe based on data, not the label).`,
    ``,
    `Match dynamic (averages across ${spec} matches in this cluster):`,
    `- Duration: ${dynamics.durationSeconds}s`,
    `- Burst windows: ${dynamics.burstWindowCount} (peak danger score: ${dynamics.peakBurstScore})`,
    `- CC events/min: ${dynamics.ccEventsPerMinute}`,
    `- Tunnel score (damage concentration on one target): ${dynamics.tunnelScore} (1.0 = pure tunnel)`,
    ``,
    `Healer behavioral stats:`,
    `- CD timing: ${Math.round(behaviors.cdTiming.Optimal * 100)}% Optimal, ${Math.round(behaviors.cdTiming.Early * 100)}% Early, ${Math.round(behaviors.cdTiming.Late * 100)}% Late, ${Math.round(behaviors.cdTiming.Reactive * 100)}% Reactive`,
    `- CD never-used rate: ${Math.round(behaviors.cdNeverUsedRate * 100)}%`,
    behaviors.cdResponseLatencyMs
      ? `- CD response latency: ${behaviors.cdResponseLatencyMs.median}ms median, ${behaviors.cdResponseLatencyMs.p90}ms P90`
      : `- CD response latency: insufficient data`,
    `- Outgoing CC per match: ${behaviors.ccOffensivePerMatch.mean} mean, ${behaviors.ccOffensivePerMatch.p75} P75`,
    `- DR chains caused per match: ${behaviors.drChainsCausedPerMatch}`,
    behaviors.purgeRatePerMin !== null ? `- Purge rate: ${behaviors.purgeRatePerMin}/min` : '',
    behaviors.missedCleanseRate !== null
      ? `- Missed cleanse rate: ${Math.round(behaviors.missedCleanseRate * 100)}%`
      : '',
    `- Healing gap rate during burst windows: ${Math.round(behaviors.healingGapRate * 100)}%`,
    `- Offensive participation rate: ${Math.round(behaviors.offensiveParticipationRate * 100)}%`,
    `- Setup style breakdown: ${JSON.stringify(behaviors.setupStyleBreakdown)}`,
    behaviors.positioningBreakdown ? `- Positioning: ${JSON.stringify(behaviors.positioningBreakdown)}` : '',
  ].filter((l) => l !== '');

  return lines.join('\n');
}

// ── Print centroid summary ────────────────────────────────────────────────────

function printCentroidSummary(
  spec: string,
  clusterIdx: number,
  centroid: number[],
  normParams: INormParams,
  rows: IArchetypeFeatureRow[],
) {
  // Denormalize centroid for display
  const denorm = centroid.map((x, i) => {
    const range = normParams.max[i] - normParams.min[i];
    return range > 0 ? x * range + normParams.min[i] : normParams.min[i];
  });

  console.log(`\n  Cluster ${clusterIdx} (${rows.length} matches):`);
  FEATURE_NAMES.forEach((name, i) => {
    console.log(`    ${name}: ${roundTo(denorm[i], 2)}`);
  });

  // Sample compositions
  const comps = rows
    .filter((r) => r.perspective === 'own')
    .slice(0, 5)
    .map((r) => `${r.matchDynamic.ownTeamSpecs.join('+')} vs ${r.matchDynamic.enemyTeamSpecs.join('+')}`);
  console.log(`    Sample comps:`);
  comps.forEach((c) => console.log(`      ${c}`));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Loading features from ${FEATURES_FILE}...`);
  const allRows = await loadFeatures();
  console.log(`Loaded ${allRows.length} rows.`);

  // Group by spec, own perspective only for clustering
  const bySpec = new Map<string, IArchetypeFeatureRow[]>();
  for (const row of allRows) {
    if (row.perspective !== 'own') continue;
    const bucket = bySpec.get(row.healerSpec) ?? [];
    bucket.push(row);
    bySpec.set(row.healerSpec, bucket);
  }

  console.log('\nSpec counts (own-healer rows):');
  for (const [spec, rows] of [...bySpec.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const ready = rows.length >= MIN_MATCHES * K ? '✓' : `(need ${MIN_MATCHES * K - rows.length} more)`;
    console.log(`  ${spec}: ${rows.length} ${ready}`);
  }

  // Compute global norm params across all own-healer rows
  const allVectors = [...bySpec.values()].flat().map((r) => toFeatureVector(r.matchDynamic));
  const normParams = computeNormParams(allVectors);

  const prompts: IArchetypePrompts = {};
  const specModels: Record<string, { centroids: number[][] }> = {};

  // Load existing draft to preserve manually set labels across re-runs
  if (await fs.pathExists(DRAFT_FILE)) {
    const existing = (await fs.readJson(DRAFT_FILE)) as IArchetypePrompts;
    for (const [spec, clusters] of Object.entries(existing)) {
      prompts[spec] = clusters;
    }
  }

  for (const [spec, ownRows] of bySpec.entries()) {
    if (ownRows.length < MIN_MATCHES * K) {
      console.log(`\nSkipping ${spec}: not enough matches (${ownRows.length} < ${MIN_MATCHES * K}).`);
      continue;
    }

    console.log(`\n=== ${spec} (${ownRows.length} matches) ===`);

    const vectors = ownRows.map((r) => toFeatureVector(r.matchDynamic));
    const normalized = vectors.map((v) => normalize(v, normParams));

    const result = kmeans(normalized, K, { initialization: 'kmeans++', maxIterations: 100 });

    // Group rows by cluster assignment
    const clusterRows = Array.from({ length: K }, () => [] as IArchetypeFeatureRow[]);
    result.clusters.forEach((clusterIdx, rowIdx) => {
      clusterRows[clusterIdx].push(ownRows[rowIdx]);
    });

    // Also add enemy-healer rows for the same matches (for enemy partial section)
    const enemyRowsByMatchId = new Map<string, IArchetypeFeatureRow[]>();
    for (const row of allRows.filter((r) => r.perspective === 'enemy' && r.healerSpec === spec)) {
      const bucket = enemyRowsByMatchId.get(row.matchId) ?? [];
      bucket.push(row);
      enemyRowsByMatchId.set(row.matchId, bucket);
    }

    console.log('\n  Cluster centroids (inspect to assign labels):');
    clusterRows.forEach((rows, idx) => printCentroidSummary(spec, idx, result.centroids[idx], normParams, rows));

    // Store centroids for model file
    specModels[spec] = { centroids: result.centroids };

    if (!prompts[spec]) prompts[spec] = {};

    for (let clusterIdx = 0; clusterIdx < K; clusterIdx++) {
      const rows = clusterRows[clusterIdx];
      if (rows.length < MIN_MATCHES) {
        console.log(`\n  cluster_${clusterIdx}: skipped (${rows.length} < ${MIN_MATCHES} min).`);
        continue;
      }

      const clusterKey = `cluster_${clusterIdx}`;
      const existingLabel = prompts[spec]?.[clusterKey]?.label;
      const label = existingLabel && existingLabel !== 'pending_review' ? existingLabel : 'pending_review';

      const dynamics = aggregateDynamics(rows);
      const behaviors = aggregateBehaviors(rows);

      const matchIds = new Set(rows.map((r) => r.matchId));
      const enemyRows = [...enemyRowsByMatchId.values()].flat().filter((r) => matchIds.has(r.matchId));
      const enemyHealerPartial = aggregateEnemyHealer(enemyRows);

      prompts[spec][clusterKey] = {
        label,
        matchCount: rows.length,
        minRating: 2400,
        generatedAt: new Date().toISOString(),
        dynamics,
        behaviors,
        enemyHealerPartial,
        promptText: prompts[spec]?.[clusterKey]?.promptText ?? '',
      };
    }
  }

  await fs.ensureDir(ARCHETYPES_DIR);
  await fs.writeJson(DRAFT_FILE, prompts, { spaces: 2 });
  console.log(`\nWrote draft: ${DRAFT_FILE}`);

  const model: IArchetypeModel = {
    generatedAt: new Date().toISOString(),
    normParams,
    featureNames: FEATURE_NAMES,
    specModels,
  };
  await fs.writeJson(MODEL_FILE, model, { spaces: 2 });
  console.log(`Wrote model: ${MODEL_FILE}`);

  console.log('\nNext steps:');
  console.log('  1. Inspect cluster centroids and sample comps above.');
  console.log('  2. Edit archetype_prompts_draft.json: rename "pending_review" labels.');
  console.log('  3. Re-run /build-match-archetypes in Claude Code to generate narratives via subagent.');
  console.log('  4. Review archetype_prompts.json and commit.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

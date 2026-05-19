/* eslint-disable no-console */
/**
 * evalArchetypeInjection.ts — Archetype Prompt Injection Evaluation (Phase 1)
 *
 * Downloads fresh matches, classifies each into its archetype cluster, then generates
 * 4 prompt variants per match to evaluate different injection strategies:
 *
 *   baseline        — standard match prompt, no archetype context
 *   label_only      — cluster label prepended (minimal signal)
 *   narrative       — 2-3 sentence archetype narrative prepended
 *   narrative_stats — narrative + key behavioral stats prepended
 *
 * Outputs:
 *   archetypes/eval/prompts/{variant}/{NNN}-{spec}-{matchId}.txt
 *   archetypes/eval/index.json
 *
 * Usage:
 *   npm run -w @wowarenalogs/tools start:evalArchetypeInjection
 *
 * Env vars:
 *   EVAL_COUNT=30   matches to download (default 30)
 *   MIN_RATING=2000 rating floor (default 2000)
 *   BRACKET=3v3     bracket (default 3v3)
 */

import { CombatUnitReaction, CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import path from 'path';

import { analyzePlayerCCAndTrinket } from '../../shared/src/utils/ccTrinketAnalysis';
import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { reconstructEnemyCDTimeline } from '../../shared/src/utils/enemyCDs';
import { analyzeHealerExposureAtBurst } from '../../shared/src/utils/healerExposureAnalysis';
import { computeMatchArchetype } from '../../shared/src/utils/matchArchetype';
import { IArchetypeCluster, IArchetypePrompts } from './buildArchetypePrompts';
import { IMatchDynamicFeatures } from './extractArchetypeFeatures';
import { buildMatchPromptNew, fetchStubs, ParsedCombat, parseLogText } from './printMatchPrompts';

// ── Config ────────────────────────────────────────────────────────────────────

const EVAL_COUNT = parseInt(process.env.EVAL_COUNT ?? '30', 10);
const MIN_RATING = parseInt(process.env.MIN_RATING ?? '2000', 10);
const BRACKET = process.env.BRACKET ?? '3v3';

const ARCHETYPES_DIR = path.join(__dirname, '../archetypes');
const EVAL_DIR = path.join(ARCHETYPES_DIR, 'eval');
const PROMPTS_FILE = path.join(ARCHETYPES_DIR, 'archetype_prompts.json');
const MODEL_FILE = path.join(ARCHETYPES_DIR, 'archetype_model.json');

export const VARIANTS = ['baseline', 'label_only', 'narrative', 'narrative_stats'] as const;
export type Variant = (typeof VARIANTS)[number];

// ── Model types ───────────────────────────────────────────────────────────────

interface IArchetypeModel {
  normParams: { min: number[]; max: number[] };
  featureNames: string[];
  specModels: Record<string, { centroids: number[][] }>;
}

interface IEvalIndexEntry {
  ordinal: number;
  matchId: string;
  spec: string;
  bracket: string;
  result: 'Win' | 'Loss' | 'Unknown';
  durationSec: number;
  clusterKey: string;
  clusterLabel: string;
  files: Record<Variant, string>;
}

// ── Cluster classification ────────────────────────────────────────────────────

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

function normalize(v: number[], params: IArchetypeModel['normParams']): number[] {
  return v.map((x, i) => {
    const range = params.max[i] - params.min[i];
    return range > 0 ? (x - params.min[i]) / range : 0;
  });
}

function euclidean(a: number[], b: number[]): number {
  return Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0));
}

function classifyCluster(
  matchDynamic: IMatchDynamicFeatures,
  healerSpec: string,
  model: IArchetypeModel,
): { clusterKey: string; clusterIdx: number } | null {
  const specModel = model.specModels[healerSpec];
  if (!specModel) return null;

  const vec = normalize(toFeatureVector(matchDynamic), model.normParams);
  let bestIdx = 0;
  let bestDist = Infinity;
  specModel.centroids.forEach((centroid, idx) => {
    const dist = euclidean(vec, centroid);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = idx;
    }
  });
  return { clusterKey: `cluster_${bestIdx}`, clusterIdx: bestIdx };
}

// ── Match dynamic feature extraction ─────────────────────────────────────────

function extractMatchDynamics(
  combat: ParsedCombat,
  friends: ICombatUnit[],
  enemies: ICombatUnit[],
): IMatchDynamicFeatures | null {
  const durationSeconds = (combat.endTime - combat.startTime) / 1000;
  if (durationSeconds < 10) return null;

  const healerUnit = friends.find((u) => isHealerSpec(u.spec)) ?? null;
  const ccTrinketSummaries = friends.map((p) => analyzePlayerCCAndTrinket(p, enemies, combat));
  const enemyCDTimeline = reconstructEnemyCDTimeline(enemies, combat, healerUnit ?? undefined, friends);

  const healerCCSummary = healerUnit ? ccTrinketSummaries.find((s) => s.playerName === healerUnit.name) : undefined;
  const healerExposures =
    healerUnit && healerCCSummary
      ? analyzeHealerExposureAtBurst(
          enemyCDTimeline.alignedBurstWindows,
          enemies,
          healerUnit,
          healerCCSummary,
          ccTrinketSummaries,
          combat.startInfo.zoneId,
          combat.startTime,
        )
      : [];

  const archetype = computeMatchArchetype(
    friends,
    enemies,
    combat,
    ccTrinketSummaries,
    enemyCDTimeline.alignedBurstWindows,
    healerExposures,
  );

  return {
    durationSeconds: archetype.durationSeconds,
    burstWindowCount: archetype.burstWindowCount,
    peakBurstScore: archetype.peakBurstScore,
    burstWindowQuality: { low: 0, moderate: 0, high: 0, critical: 0 },
    ccEventsPerMinute: archetype.ccEventsPerMinute,
    tunnelScore: archetype.friendlyDamageShare[0]?.share ?? 0,
    criticalOrExposedBurstWindows: archetype.criticalOrExposedBurstWindows,
    enemyMeleeCount: archetype.enemyMeleeCount,
    enemyRangedCount: archetype.enemyRangedCount,
    setupStyle: 'unknown',
    ownTeamCCPerMin: 0,
    enemyTeamCCPerMin: 0,
    ownTeamSpecs: friends.map((p) => specToString(p.spec)),
    enemyTeamSpecs: enemies.map((p) => specToString(p.spec)),
  };
}

// ── Variant prompt builders ───────────────────────────────────────────────────

function formatStats(cluster: IArchetypeCluster): string {
  const b = cluster.behaviors;
  const lines: string[] = [
    `CD timing: ${Math.round(b.cdTiming.Optimal * 100)}% Optimal / ${Math.round(b.cdTiming.Early * 100)}% Early / ${Math.round(b.cdTiming.Late * 100)}% Late / ${Math.round(b.cdTiming.Reactive * 100)}% Reactive`,
    `CD never used: ${Math.round(b.cdNeverUsedRate * 100)}%`,
    b.cdResponseLatencyMs ? `CD response latency: ${b.cdResponseLatencyMs.median}ms median` : null,
    `Outgoing CC per match: ${b.ccOffensivePerMatch.mean.toFixed(1)} mean`,
    `Healing gap rate during burst: ${Math.round(b.healingGapRate * 100)}%`,
    `Offensive participation: ${Math.round(b.offensiveParticipationRate * 100)}%`,
    b.purgeRatePerMin !== null ? `Purge rate: ${b.purgeRatePerMin.toFixed(2)}/min` : null,
    b.missedCleanseRate !== null ? `Missed cleanse rate: ${Math.round(b.missedCleanseRate * 100)}%` : null,
  ].filter(Boolean) as string[];
  return lines.join('\n');
}

function buildVariantPrompt(
  baselinePrompt: string,
  variant: Variant,
  spec: string,
  cluster: IArchetypeCluster,
): string {
  if (variant === 'baseline') return baselinePrompt;

  const header = `[ARCHETYPE: ${spec} — ${cluster.label}]`;

  if (variant === 'label_only') {
    return `${header}\n\n${baselinePrompt}`;
  }

  if (variant === 'narrative') {
    return `${header}\n${cluster.promptText}\n\n${baselinePrompt}`;
  }

  // narrative_stats
  const stats = formatStats(cluster);
  return `${header}\n${cluster.promptText}\n\nKey behavioral patterns observed in this match type:\n${stats}\n\n${baselinePrompt}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load archetype data
  if (!(await fs.pathExists(PROMPTS_FILE)) || !(await fs.pathExists(MODEL_FILE))) {
    throw new Error('archetype_prompts.json or archetype_model.json not found. Run build-match-archetypes first.');
  }
  const archetypePrompts = (await fs.readJson(PROMPTS_FILE)) as IArchetypePrompts;
  const model = (await fs.readJson(MODEL_FILE)) as IArchetypeModel;

  // Create output dirs
  for (const variant of VARIANTS) {
    await fs.ensureDir(path.join(EVAL_DIR, 'prompts', variant));
  }

  console.log(`Downloading up to ${EVAL_COUNT} matches (${BRACKET}, ≥${MIN_RATING} MMR)...\n`);

  const entries: IEvalIndexEntry[] = [];
  let ordinal = 0;
  let fetched = 0;
  let offset = 0;
  const PAGE_SIZE = 50;

  while (fetched < EVAL_COUNT) {
    const stubs = await fetchStubs(BRACKET, Math.min(PAGE_SIZE, EVAL_COUNT - fetched), offset, MIN_RATING);
    if (stubs.length === 0) break;
    offset += stubs.length;

    for (const stub of stubs) {
      if (fetched >= EVAL_COUNT) break;

      let text: string;
      try {
        const res = await (await import('node-fetch')).default(stub.logObjectUrl);
        if (!res.ok) {
          console.error(`  [${stub.id}] Download failed`);
          continue;
        }
        text = await res.text();
      } catch {
        console.error(`  [${stub.id}] Network error`);
        continue;
      }

      let combats: ParsedCombat[];
      try {
        combats = await parseLogText(text);
      } catch {
        console.error(`  [${stub.id}] Parse error`);
        continue;
      }

      for (const combat of combats) {
        const allUnits = Object.values(combat.units);
        const friends = allUnits.filter(
          (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
        ) as ICombatUnit[];
        const enemies = allUnits.filter(
          (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Hostile,
        ) as ICombatUnit[];

        const healerUnit = friends.find((u) => isHealerSpec(u.spec));
        if (!healerUnit || friends.length === 0 || enemies.length === 0) continue;

        const spec = specToString(healerUnit.spec);
        const dynamics = extractMatchDynamics(combat, friends, enemies);
        if (!dynamics) continue;

        const classification = classifyCluster(dynamics, spec, model);
        if (!classification) {
          console.log(`  No cluster model for ${spec}, skipping`);
          continue;
        }

        const { clusterKey } = classification;
        const cluster = archetypePrompts[spec]?.[clusterKey];
        if (!cluster) {
          console.log(`  No archetype for ${spec}/${clusterKey}`);
          continue;
        }

        const baselinePrompt = buildMatchPromptNew(combat, true);
        if (!baselinePrompt) continue;

        const combatAny = combat as unknown as Record<string, unknown>;
        const playerWon =
          typeof combatAny['winningTeamId'] === 'string' ? combatAny['winningTeamId'] === combat.playerTeamId : null;
        const result = playerWon === true ? 'Win' : playerWon === false ? 'Loss' : 'Unknown';

        ordinal++;
        const ordinalStr = String(ordinal).padStart(3, '0');
        const safeSpec = spec.replace(/[^A-Za-z0-9]/g, '');
        const safeId = stub.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
        const files = {} as Record<Variant, string>;

        for (const variant of VARIANTS) {
          const content = buildVariantPrompt(baselinePrompt, variant, spec, cluster);
          const filename = `${ordinalStr}-${safeSpec}-${result[0]}-${safeId}.txt`;
          files[variant] = filename;
          await fs.writeFile(path.join(EVAL_DIR, 'prompts', variant, filename), content, 'utf-8');
        }

        entries.push({
          ordinal,
          matchId: stub.id,
          spec,
          bracket: BRACKET,
          result: result as 'Win' | 'Loss' | 'Unknown',
          durationSec: Math.round(dynamics.durationSeconds),
          clusterKey,
          clusterLabel: cluster.label,
          files,
        });

        fetched++;
        console.log(
          `  [${ordinalStr}] ${spec} — ${cluster.label} (${result}, ${Math.round(dynamics.durationSeconds)}s)`,
        );
        if (fetched >= EVAL_COUNT) break;
      }
    }

    if (stubs.length < PAGE_SIZE) break;
  }

  await fs.writeJson(path.join(EVAL_DIR, 'index.json'), entries, { spaces: 2 });

  console.log(`\nDone. ${entries.length} eval matches written to ${EVAL_DIR}`);
  console.log(`Cluster distribution:`);
  const clusterCounts: Record<string, number> = {};
  for (const e of entries) {
    const key = `${e.spec}/${e.clusterLabel}`;
    clusterCounts[key] = (clusterCounts[key] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(clusterCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${n}`);
  }
  console.log(`\nVariants written: ${VARIANTS.join(', ')}`);
  console.log(`Run /build-match-archetypes --eval to score all variants.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

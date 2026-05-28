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

import { classifyCluster, extractMatchDynamics, IArchetypeModel } from '../../shared/src/utils/archetypeInference';
import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { IArchetypeCluster, IArchetypePrompts } from './buildArchetypePrompts';
import { buildMatchPromptNew, fetchStubs, ParsedCombat, parseLogText } from './printMatchPrompts';

// ── Config ────────────────────────────────────────────────────────────────────

const EVAL_COUNT = parseInt(process.env.EVAL_COUNT ?? '30', 10);
const MIN_RATING = parseInt(process.env.MIN_RATING ?? '2000', 10);
const BRACKET = process.env.BRACKET ?? '3v3';
// Production injection skips short rounds — mirror that here so eval results
// reflect what users will actually see in CombatAIAnalysis.
const MIN_DURATION_SECONDS = 30;

const BRACKET_SLUG = BRACKET.toLowerCase().includes('solo') ? 'solo_shuffle' : '3v3';

const ARCHETYPES_DIR = path.join(__dirname, '../archetypes');
const EVAL_DIR = path.join(ARCHETYPES_DIR, `eval_${BRACKET_SLUG}`);
const PROMPTS_FILE = path.join(ARCHETYPES_DIR, `archetype_prompts_${BRACKET_SLUG}.json`);
const MODEL_FILE = path.join(ARCHETYPES_DIR, `archetype_model_${BRACKET_SLUG}.json`);

export const VARIANTS = ['baseline', 'label_only', 'narrative', 'narrative_stats'] as const;
export type Variant = (typeof VARIANTS)[number];

// ── Model types ───────────────────────────────────────────────────────────────

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

  const header = `[MATCH TYPE: ${cluster.label}]`;

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

      const IS_SOLO_SHUFFLE = BRACKET.toLowerCase().includes('solo');
      for (const combat of combats) {
        // Enforce bracket — never mix IArenaMatch and IShuffleRound
        if (IS_SOLO_SHUFFLE ? combat.dataType !== 'ShuffleRound' : combat.dataType !== 'ArenaMatch') continue;

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

        const classification = classifyCluster(dynamics, model);
        const { clusterKey } = classification;
        const cluster = archetypePrompts[clusterKey];
        if (!cluster) {
          console.log(`  No archetype for ${clusterKey}`);
          continue;
        }

        // Mirror production guards: skip noise clusters and short rounds so the
        // eval corpus only contains matches we'd actually inject for.
        if (cluster.isNoise) {
          console.log(`  [skip] ${clusterKey} (${cluster.label}) is a noise cluster`);
          continue;
        }
        if (dynamics.durationSeconds < MIN_DURATION_SECONDS) {
          console.log(
            `  [skip] duration ${Math.round(dynamics.durationSeconds)}s below ${MIN_DURATION_SECONDS}s floor`,
          );
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

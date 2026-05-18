/* eslint-disable no-console */
/**
 * extractArchetypeFeatures.ts — Match Archetype Feature Extraction (Phase 1)
 *
 * Downloads high-rated arena matches and extracts a behavioral fingerprint for each healer:
 *   - Own team healer: full fidelity (CD timing, CC, healing gaps, dispels, positioning)
 *   - Enemy healer: partial (CD casts + outgoing CC only)
 *
 * Output:
 *   packages/tools/archetypes/features.jsonl  (gitignored — grows across runs)
 *   packages/tools/archetypes/logs/{id}.log   (gitignored — raw log cache)
 *
 * Usage:
 *   npm run -w @wowarenalogs/tools start:extractArchetypeFeatures
 *
 * Env vars:
 *   MATCH_COUNT=200            new matches to download per run (default 200)
 *   BRACKET=3v3                bracket filter (default '3v3')
 *   MIN_RATING=2100            minimum rating (default 2100)
 *   CONCURRENCY=5              parallel downloads (default 5)
 *   REQUIRE_ADVANCED_LOGGING   filter to advanced logs only (default false)
 *   API_BASE                   (default https://wowarenalogs.com)
 */

import { CombatUnitReaction, CombatUnitType, IArenaMatch, IShuffleRound } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import fetch from 'node-fetch';
import path from 'path';

import spellIdListsData from '../../shared/src/data/spellIdLists.json';
import spellsData from '../../shared/src/data/spells.json';
import { analyzePlayerCCAndTrinket } from '../../shared/src/utils/ccTrinketAnalysis';
import {
  annotateDefensiveTimings,
  DefensiveTimingLabel,
  extractMajorCooldowns,
  isHealerSpec,
  specToString,
} from '../../shared/src/utils/cooldowns';
import { getDampeningPercentage } from '../../shared/src/utils/dampening';
import { reconstructDispelSummary } from '../../shared/src/utils/dispelAnalysis';
import { analyzeOutgoingCCChains } from '../../shared/src/utils/drAnalysis';
import { reconstructEnemyCDTimeline } from '../../shared/src/utils/enemyCDs';
import { analyzeHealerExposureAtBurst } from '../../shared/src/utils/healerExposureAnalysis';
import { detectHealingGaps } from '../../shared/src/utils/healingGaps';
import { computeMatchArchetype } from '../../shared/src/utils/matchArchetype';
import { computeOffensiveWindows } from '../../shared/src/utils/offensiveWindows';

// ── Config ────────────────────────────────────────────────────────────────────

const MATCH_COUNT = parseInt(process.env.MATCH_COUNT ?? '200', 10);
const BRACKET = process.env.BRACKET ?? '3v3';
const MIN_RATING = parseInt(process.env.MIN_RATING ?? '2100', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? '5', 10);
const REQUIRE_ADVANCED_LOGGING = process.env.REQUIRE_ADVANCED_LOGGING === 'true';
const API_BASE = process.env.API_BASE ?? 'https://wowarenalogs.com';
const PAGE_SIZE = 50;

const OUTPUT_DIR = path.join(__dirname, '../archetypes');
const FEATURES_FILE = path.join(OUTPUT_DIR, 'features.jsonl');
const LOGS_DIR = path.join(OUTPUT_DIR, 'logs');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IMatchDynamicFeatures {
  durationSeconds: number;
  burstWindowCount: number;
  peakBurstScore: number;
  burstWindowQuality: { low: number; moderate: number; high: number; critical: number };
  ccEventsPerMinute: number;
  tunnelScore: number; // friendlyDamageShare[0].share
  criticalOrExposedBurstWindows: number | null;
  enemyMeleeCount: number;
  enemyRangedCount: number;
  setupStyle: 'one_shot_burst' | 'cc_then_burst' | 'flat_dampening' | 'unknown';
  ownTeamCCPerMin: number;
  enemyTeamCCPerMin: number;
  ownTeamSpecs: string[];
  enemyTeamSpecs: string[];
}

export interface ITimingDistribution {
  Optimal: number;
  Early: number;
  Late: number;
  Reactive: number;
  Unknown: number;
}

export interface IResponseLatency {
  median: number;
  p90: number;
}

export interface IPositioningStats {
  cluster: 'clustered' | 'spread' | 'stationary' | 'mobile';
  movementRateUnitsPerSec: number;
  positionVariance: number;
}

export interface IFullBehavioralFeatures {
  cdTimingDistribution: ITimingDistribution;
  cdNeverUsedRate: number;
  cdResponseLatencyMs: IResponseLatency | null;
  ccOffensiveSentPerMatch: number;
  drChainsCaused: number;
  purgeRate: number | null;
  missedCleanseRate: number | null;
  healingGapRate: number;
  offensiveParticipationRate: number;
  positioning: IPositioningStats | null;
}

export interface IPartialBehavioralFeatures {
  cdCastsObserved: Record<string, number>;
  ccOffensiveSentPerMatch: number;
}

export interface IArchetypeFeatureRow {
  matchId: string;
  healerSpec: string;
  perspective: 'own' | 'enemy';
  matchDynamic: IMatchDynamicFeatures;
  behavioral: IFullBehavioralFeatures | IPartialBehavioralFeatures;
  hasAdvancedLogging: boolean;
}

// ── Positioning ───────────────────────────────────────────────────────────────

const STATIONARY_RATE_THRESHOLD = 2.0; // units/sec
const MOBILE_RATE_THRESHOLD = 8.0; // units/sec
const CLUSTERED_VARIANCE_THRESHOLD = 100; // squared units

function computePositioning(
  unit: {
    advancedActions: Array<{
      logLine: { timestamp: number };
      advancedActorPositionX: number;
      advancedActorPositionY: number;
      advanced: boolean;
    }>;
  },
  matchStartMs: number,
  matchEndMs: number,
): IPositioningStats | null {
  const positions = unit.advancedActions
    .filter((a) => a.advanced && (a.advancedActorPositionX !== 0 || a.advancedActorPositionY !== 0))
    .sort((a, b) => a.logLine.timestamp - b.logLine.timestamp)
    .map((a) => ({ t: a.logLine.timestamp, x: a.advancedActorPositionX, y: a.advancedActorPositionY }));

  if (positions.length < 3) return null;

  // Total distance travelled
  let totalDistance = 0;
  for (let i = 1; i < positions.length; i++) {
    const dx = positions[i].x - positions[i - 1].x;
    const dy = positions[i].y - positions[i - 1].y;
    totalDistance += Math.sqrt(dx * dx + dy * dy);
  }

  const durationSec = (matchEndMs - matchStartMs) / 1000;
  const movementRate = durationSec > 0 ? totalDistance / durationSec : 0;

  // Position variance (mean squared distance from centroid)
  const cx = positions.reduce((s, p) => s + p.x, 0) / positions.length;
  const cy = positions.reduce((s, p) => s + p.y, 0) / positions.length;
  const variance =
    positions.reduce((s, p) => {
      const dx = p.x - cx;
      const dy = p.y - cy;
      return s + dx * dx + dy * dy;
    }, 0) / positions.length;

  let cluster: IPositioningStats['cluster'];
  if (movementRate < STATIONARY_RATE_THRESHOLD) {
    cluster = 'stationary';
  } else if (movementRate > MOBILE_RATE_THRESHOLD) {
    cluster = 'mobile';
  } else if (variance < CLUSTERED_VARIANCE_THRESHOLD) {
    cluster = 'clustered';
  } else {
    cluster = 'spread';
  }

  return { cluster, movementRateUnitsPerSec: movementRate, positionVariance: variance };
}

// ── CD response latency ───────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeCDResponseLatency(
  annotatedCooldowns: ReturnType<typeof annotateDefensiveTimings>,
  burstWindows: Array<{ fromSeconds: number; toSeconds: number }>,
  matchStartMs: number,
): IResponseLatency | null {
  const latenciesMs: number[] = [];

  for (const cd of annotatedCooldowns) {
    for (const cast of cd.casts) {
      if (cast.timingLabel !== 'Optimal' && cast.timingLabel !== 'Reactive') continue;
      // Find the burst window this cast falls in
      const castMs = cast.timeSeconds * 1000 + matchStartMs;
      for (const w of burstWindows) {
        const windowStartMs = w.fromSeconds * 1000 + matchStartMs;
        const windowEndMs = w.toSeconds * 1000 + matchStartMs;
        if (castMs >= windowStartMs && castMs <= windowEndMs + 8000) {
          const latency = castMs - windowStartMs;
          if (latency >= 0) latenciesMs.push(latency);
          break;
        }
      }
    }
  }

  if (latenciesMs.length === 0) return null;
  return { median: Math.round(median(latenciesMs)), p90: Math.round(percentile(latenciesMs, 90)) };
}

// ── Setup style ───────────────────────────────────────────────────────────────

function classifySetupStyle(
  firstDeathAtSeconds: number | null,
  peakBurstScore: number,
  ccEventsBeforeFirstDeath: number,
  dampeningAtFirstDeathPct: number,
): IMatchDynamicFeatures['setupStyle'] {
  if (firstDeathAtSeconds !== null && firstDeathAtSeconds <= 45 && peakBurstScore >= 60) {
    return 'one_shot_burst';
  }
  if (ccEventsBeforeFirstDeath >= 2) {
    return 'cc_then_burst';
  }
  if (firstDeathAtSeconds !== null && firstDeathAtSeconds > 120 && dampeningAtFirstDeathPct > 0.2) {
    return 'flat_dampening';
  }
  return 'unknown';
}

// ── Offensive participation ───────────────────────────────────────────────────

function computeOffensiveParticipation(
  healer: { spellCastEvents: Array<{ logLine: { timestamp: number; event: string }; spellId: string }> },
  offensiveWindows: Array<{ fromSeconds: number; toSeconds: number }>,
  matchStartMs: number,
  ccSpellIds: Set<string>,
): number {
  if (offensiveWindows.length === 0) return 0;
  let participated = 0;
  for (const w of offensiveWindows) {
    const fromMs = w.fromSeconds * 1000 + matchStartMs;
    const toMs = w.toSeconds * 1000 + matchStartMs;
    const didCast = healer.spellCastEvents.some(
      (e) =>
        e.logLine.event === 'SPELL_CAST_SUCCESS' &&
        e.logLine.timestamp >= fromMs &&
        e.logLine.timestamp <= toMs &&
        ccSpellIds.has(e.spellId),
    );
    if (didCast) participated++;
  }
  return participated / offensiveWindows.length;
}

// ── CC spell ID detection ─────────────────────────────────────────────────────

type SpellEntry = { type: string };
const SPELLS = spellsData as Record<string, SpellEntry>;

function getCCSpellIds(): Set<string> {
  const ccTypes = new Set(['cc', 'stun', 'incapacitate', 'disorient', 'silence']);
  const ids = new Set<string>();
  for (const [id, entry] of Object.entries(SPELLS)) {
    if (ccTypes.has(entry.type)) ids.add(id);
  }
  // Also include any from the spell ID lists
  const lists = spellIdListsData as Record<string, string[]>;
  for (const [key, values] of Object.entries(lists)) {
    if (key.toLowerCase().includes('cc') || key.toLowerCase().includes('stun')) {
      values.forEach((id) => ids.add(id));
    }
  }
  return ids;
}

const CC_SPELL_IDS = getCCSpellIds();

// ── Advanced logging detection ────────────────────────────────────────────────

function hasAdvancedLoggingEnabled(units: Array<{ advancedActions: Array<{ advanced: boolean }> }>): boolean {
  for (const unit of units) {
    if (unit.advancedActions.some((a) => a.advanced)) return true;
  }
  return false;
}

// ── Per-match processing ──────────────────────────────────────────────────────

type ParsedCombat = IArenaMatch | IShuffleRound;

function processMatch(combat: ParsedCombat, matchId: string): IArchetypeFeatureRow[] {
  const allUnits = Object.values(combat.units);
  const friends = allUnits.filter(
    (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
  );
  const enemies = allUnits.filter((u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Hostile);

  if (friends.length === 0 || enemies.length === 0) return [];

  const durationSeconds = (combat.endTime - combat.startTime) / 1000;
  if (durationSeconds < 10) return [];

  const hasAdvLogging = hasAdvancedLoggingEnabled([...friends, ...enemies]);
  if (REQUIRE_ADVANCED_LOGGING && !hasAdvLogging) return [];

  const friendHealers = friends.filter((u) => isHealerSpec(u.spec));
  const enemyHealers = enemies.filter((u) => isHealerSpec(u.spec));
  if (friendHealers.length === 0 && enemyHealers.length === 0) return [];

  // ── Shared computations ──
  const enemyCDTimeline = reconstructEnemyCDTimeline(enemies, combat, friendHealers[0], friends);
  const ccTrinketSummaries = friends.map((p) => analyzePlayerCCAndTrinket(p, enemies, combat));
  const healerUnit = friendHealers[0] ?? null;
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

  // ── CC counts per team ──
  const ownTeamOutgoing = analyzeOutgoingCCChains(friends, enemies, combat);
  const enemyTeamOutgoing = analyzeOutgoingCCChains(enemies, friends, combat);
  const ownTeamCCEvents = ownTeamOutgoing.reduce((s, c) => s + c.applications.length, 0);
  const enemyTeamCCEvents = enemyTeamOutgoing.reduce((s, c) => s + c.applications.length, 0);

  // ── Setup style ──
  const firstDeathAtSeconds = archetype.firstDeathAtSeconds;
  const allPlayers = [...friends, ...enemies];
  const dampeningAtFirstDeath =
    firstDeathAtSeconds !== null
      ? getDampeningPercentage(combat.startInfo.bracket, allPlayers, combat.startTime + firstDeathAtSeconds * 1000)
      : 0;

  // Count CC events on any friendly in the 10s before first death
  const ccBeforeFirstDeath =
    firstDeathAtSeconds !== null
      ? ccTrinketSummaries.reduce((sum, s) => {
          const deathMs = combat.startTime + firstDeathAtSeconds * 1000;
          const window10s = deathMs - 10000;
          return (
            sum +
            s.ccInstances.filter((cc) => {
              const t = cc.atSeconds * 1000 + combat.startTime;
              return t >= window10s && t <= deathMs;
            }).length
          );
        }, 0)
      : 0;

  const burstWindowQuality = { low: 0, moderate: 0, high: 0, critical: 0 };
  for (const w of enemyCDTimeline.alignedBurstWindows) {
    burstWindowQuality[w.dangerLabel.toLowerCase() as keyof typeof burstWindowQuality]++;
  }

  const matchDynamic: IMatchDynamicFeatures = {
    durationSeconds: archetype.durationSeconds,
    burstWindowCount: archetype.burstWindowCount,
    peakBurstScore: archetype.peakBurstScore,
    burstWindowQuality,
    ccEventsPerMinute: archetype.ccEventsPerMinute,
    tunnelScore: archetype.friendlyDamageShare[0]?.share ?? 0,
    criticalOrExposedBurstWindows: archetype.criticalOrExposedBurstWindows,
    enemyMeleeCount: archetype.enemyMeleeCount,
    enemyRangedCount: archetype.enemyRangedCount,
    setupStyle: classifySetupStyle(
      firstDeathAtSeconds,
      archetype.peakBurstScore,
      ccBeforeFirstDeath,
      dampeningAtFirstDeath,
    ),
    ownTeamCCPerMin: durationSeconds > 0 ? (ownTeamCCEvents / durationSeconds) * 60 : 0,
    enemyTeamCCPerMin: durationSeconds > 0 ? (enemyTeamCCEvents / durationSeconds) * 60 : 0,
    ownTeamSpecs: friends.map((p) => specToString(p.spec)),
    enemyTeamSpecs: enemies.map((p) => specToString(p.spec)),
  };

  const rows: IArchetypeFeatureRow[] = [];

  // ── Own healer (full fidelity) ──
  if (healerUnit) {
    const cooldowns = extractMajorCooldowns(healerUnit, combat);
    const annotated = annotateDefensiveTimings(cooldowns, healerUnit, combat, enemyCDTimeline);

    // CD timing distribution
    const timingCounts: Record<DefensiveTimingLabel, number> = {
      Optimal: 0,
      Early: 0,
      Late: 0,
      Reactive: 0,
      Unknown: 0,
    };
    let totalDefensiveCasts = 0;
    for (const cd of annotated) {
      for (const cast of cd.casts) {
        if (cast.timingLabel) {
          timingCounts[cast.timingLabel]++;
          totalDefensiveCasts++;
        }
      }
    }
    const toRate = (n: number) => (totalDefensiveCasts > 0 ? n / totalDefensiveCasts : 0);
    const cdTimingDistribution: ITimingDistribution = {
      Optimal: toRate(timingCounts.Optimal),
      Early: toRate(timingCounts.Early),
      Late: toRate(timingCounts.Late),
      Reactive: toRate(timingCounts.Reactive),
      Unknown: toRate(timingCounts.Unknown),
    };

    // CD never-used rate
    const defensiveCDs = annotated.filter((cd) => cd.tag === 'Defensive');
    const neverUsedCount = defensiveCDs.filter((cd) => cd.neverUsed).length;
    const cdNeverUsedRate = defensiveCDs.length > 0 ? neverUsedCount / defensiveCDs.length : 0;

    // CD response latency
    const cdResponseLatencyMs = computeCDResponseLatency(
      annotated,
      enemyCDTimeline.alignedBurstWindows,
      combat.startTime,
    );

    // Outgoing CC from healer
    const healerOutgoingChains = ownTeamOutgoing
      .flatMap((c) => c.applications)
      .filter((a) => a.casterName === healerUnit.name);
    const ccOffensiveSentPerMatch = healerOutgoingChains.length;

    // DR chains caused (chains where healer caused ≥50% DR reduction)
    const drChainsCaused = ownTeamOutgoing.filter(
      (chain) => chain.hasWastedApplications && chain.applications.some((a) => a.casterName === healerUnit.name),
    ).length;

    // Dispel rates
    const dispelSummary = reconstructDispelSummary(friends, enemies, combat);
    const healerPurges = dispelSummary.ourPurges.filter((p) => p.sourceName === healerUnit.name);
    const purgeRate = healerPurges.length > 0 ? healerPurges.length / (durationSeconds / 60) : null;
    const healerCleanses = dispelSummary.allyCleanse.filter((c) => c.sourceName === healerUnit.name).length;
    const totalMissedCleanses = dispelSummary.missedCleanseWindows.length;
    const missedCleanseRate =
      healerCleanses + totalMissedCleanses > 0 ? totalMissedCleanses / (healerCleanses + totalMissedCleanses) : null;

    // Healing gaps
    const healingGaps = detectHealingGaps(healerUnit, friends, enemies, combat);
    const burstWindowCount = enemyCDTimeline.alignedBurstWindows.length;
    const healingGapRate =
      burstWindowCount > 0
        ? healingGaps.filter((g) =>
            enemyCDTimeline.alignedBurstWindows.some(
              (w) => g.fromSeconds <= w.toSeconds && g.toSeconds >= w.fromSeconds,
            ),
          ).length / burstWindowCount
        : 0;

    // Offensive participation
    const offensiveWindows = computeOffensiveWindows(enemies, friends, combat);
    const offensiveParticipationRate = computeOffensiveParticipation(
      healerUnit,
      offensiveWindows,
      combat.startTime,
      CC_SPELL_IDS,
    );

    // Positioning
    const positioning = hasAdvLogging ? computePositioning(healerUnit, combat.startTime, combat.endTime) : null;

    const behavioral: IFullBehavioralFeatures = {
      cdTimingDistribution,
      cdNeverUsedRate,
      cdResponseLatencyMs,
      ccOffensiveSentPerMatch,
      drChainsCaused,
      purgeRate,
      missedCleanseRate,
      healingGapRate,
      offensiveParticipationRate,
      positioning,
    };

    rows.push({
      matchId,
      healerSpec: specToString(healerUnit.spec),
      perspective: 'own',
      matchDynamic,
      behavioral,
      hasAdvancedLogging: hasAdvLogging,
    });
  }

  // ── Enemy healer (partial) ──
  for (const enemyHealer of enemyHealers) {
    const enemyCooldowns = extractMajorCooldowns(enemyHealer, combat);
    const cdCastsObserved: Record<string, number> = {};
    for (const cd of enemyCooldowns) {
      if (cd.casts.length > 0) {
        cdCastsObserved[cd.spellName] = cd.casts.length;
      }
    }

    // Outgoing CC from enemy healer
    const enemyHealerOutgoing = enemyTeamOutgoing
      .flatMap((c) => c.applications)
      .filter((a) => a.casterName === enemyHealer.name);

    // Reverse matchDynamic perspective for enemy healer (their "own" CC is our "enemy" CC)
    const enemyPerspectiveDynamic: IMatchDynamicFeatures = {
      ...matchDynamic,
      ownTeamSpecs: matchDynamic.enemyTeamSpecs,
      enemyTeamSpecs: matchDynamic.ownTeamSpecs,
      ownTeamCCPerMin: matchDynamic.enemyTeamCCPerMin,
      enemyTeamCCPerMin: matchDynamic.ownTeamCCPerMin,
    };

    const behavioral: IPartialBehavioralFeatures = {
      cdCastsObserved,
      ccOffensiveSentPerMatch: enemyHealerOutgoing.length,
    };

    rows.push({
      matchId,
      healerSpec: specToString(enemyHealer.spec),
      perspective: 'enemy',
      matchDynamic: enemyPerspectiveDynamic,
      behavioral,
      hasAdvancedLogging: hasAdvLogging,
    });
  }

  return rows;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

async function parseLogText(text: string): Promise<ParsedCombat[]> {
  const { WoWCombatLogParser } = await import('@wowarenalogs/parser');
  const lines = text.split('\n');
  const parser = new WoWCombatLogParser('retail');
  const combats: ParsedCombat[] = [];
  parser.on('arena_match_ended', (c: IArenaMatch) => combats.push(c));
  parser.on('solo_shuffle_ended', (m: { rounds: IShuffleRound[] }) => combats.push(...m.rounds));
  for (const line of lines) parser.parseLine(line);
  parser.flush();
  return combats;
}

// ── API ───────────────────────────────────────────────────────────────────────

const STUBS_QUERY = `
  query GetLatestMatches($wowVersion: String!, $bracket: String, $offset: Int!, $count: Int!) {
    latestMatches(wowVersion: $wowVersion, bracket: $bracket, offset: $offset, count: $count) {
      combats {
        ... on ArenaMatchDataStub  { id wowVersion logObjectUrl startTime endTime startInfo { bracket } }
        ... on ShuffleRoundStub    { id wowVersion logObjectUrl startTime endTime startInfo { bracket } }
      }
    }
  }
`;

interface MatchStub {
  id: string;
  logObjectUrl: string;
  startInfo?: { bracket: string };
}

async function fetchStubs(count: number, offset: number): Promise<MatchStub[]> {
  const res = await fetch(`${API_BASE}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: STUBS_QUERY, variables: { wowVersion: 'retail', bracket: BRACKET, offset, count } }),
  });
  if (!res.ok) throw new Error(`GraphQL ${res.status}: ${res.statusText}`);
  const json = (await res.json()) as { data?: { latestMatches?: { combats?: MatchStub[] } }; errors?: unknown[] };
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data?.latestMatches?.combats ?? [];
}

// ── Existing match ID tracking ────────────────────────────────────────────────

async function loadExistingMatchIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!(await fs.pathExists(FEATURES_FILE))) return ids;
  const content = await fs.readFile(FEATURES_FILE, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as IArchetypeFeatureRow;
      ids.add(row.matchId);
    } catch {
      // skip malformed lines
    }
  }
  return ids;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await fs.ensureDir(LOGS_DIR);

  const existingIds = await loadExistingMatchIds();
  console.log(`Existing matches in corpus: ${existingIds.size}`);

  // Fetch stubs
  console.log(`Fetching up to ${MATCH_COUNT} stubs (bracket: ${BRACKET}, min rating: ${MIN_RATING})...\n`);
  const allStubs: MatchStub[] = [];
  let offset = 0;
  while (allStubs.length < MATCH_COUNT) {
    const batch = await fetchStubs(Math.min(PAGE_SIZE, MATCH_COUNT - allStubs.length), offset);
    if (batch.length === 0) break;
    for (const s of batch) {
      if (!existingIds.has(s.id)) allStubs.push(s);
    }
    offset += batch.length;
    if (batch.length < PAGE_SIZE) break;
  }
  console.log(`New stubs to process: ${allStubs.length}\n`);

  // Process in parallel batches
  const writer = fs.createWriteStream(FEATURES_FILE, { flags: 'a' });
  let processed = 0;
  let advancedCount = 0;
  let totalRows = 0;

  const processStub = async (stub: MatchStub) => {
    const logPath = path.join(LOGS_DIR, `${stub.id}.log`);
    let text: string;

    if (await fs.pathExists(logPath)) {
      text = await fs.readFile(logPath, 'utf-8');
    } else {
      const res = await fetch(stub.logObjectUrl);
      if (!res.ok) {
        console.error(`  [${stub.id}] Download failed: ${res.status}`);
        return;
      }
      text = await res.text();
      await fs.writeFile(logPath, text, 'utf-8');
    }

    let combats: ParsedCombat[];
    try {
      combats = await parseLogText(text);
    } catch (e) {
      console.error(`  [${stub.id}] Parse failed: ${e}`);
      return;
    }

    for (const combat of combats) {
      const rows = processMatch(combat, stub.id);
      for (const row of rows) {
        writer.write(JSON.stringify(row) + '\n');
        if (row.hasAdvancedLogging) advancedCount++;
        totalRows++;
      }
    }
    processed++;
    if (processed % 10 === 0) console.log(`  Processed ${processed}/${allStubs.length} stubs...`);
  };

  // Concurrency pool
  const queue = [...allStubs];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const stub = queue.shift();
      if (stub) await processStub(stub);
    }
  });
  await Promise.all(workers);

  await new Promise<void>((resolve) => writer.end(resolve));

  // Summary
  const advRatio = totalRows > 0 ? Math.round((advancedCount / totalRows) * 100) : 0;
  console.log(`\nDone. Processed ${processed} stubs, wrote ${totalRows} feature rows.`);
  console.log(`Advanced logging: ${advancedCount}/${totalRows} rows (${advRatio}%).`);
  if (REQUIRE_ADVANCED_LOGGING) {
    console.log('REQUIRE_ADVANCED_LOGGING=true was set — only rows with advanced logging were written.');
  } else if (advRatio > 60) {
    console.log('Tip: advanced logging coverage >60%. Re-run with REQUIRE_ADVANCED_LOGGING=true for positioning data.');
  } else if (advRatio < 30) {
    console.log('Warning: advanced logging coverage <30%. Not enough for a positioning-only corpus.');
  }
  console.log(`\nTotal corpus size: ${existingIds.size + totalRows} rows (${FEATURES_FILE})`);

  // Per-spec counts
  const specCounts: Record<string, number> = {};
  if (await fs.pathExists(FEATURES_FILE)) {
    const content = await fs.readFile(FEATURES_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as IArchetypeFeatureRow;
        if (row.perspective === 'own') {
          specCounts[row.healerSpec] = (specCounts[row.healerSpec] ?? 0) + 1;
        }
      } catch {
        /* skip */
      }
    }
  }
  console.log('\nOwn-healer rows per spec:');
  for (const [spec, count] of Object.entries(specCounts).sort((a, b) => b[1] - a[1])) {
    const ready = count >= 100 ? '✓' : `(need ${100 - count} more)`;
    console.log(`  ${spec}: ${count} ${ready}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

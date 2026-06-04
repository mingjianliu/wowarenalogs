import { CombatUnitType, IArenaMatch, IShuffleRound } from '@wowarenalogs/parser';

import { ccSpellIds } from '../data/spellTags';
import { analyzePlayerCCAndTrinket } from './ccTrinketAnalysis';
import {
  annotateDefensiveTimings,
  detectOverlappedDefensives,
  extractMajorCooldowns,
  IMajorCooldownInfo,
  MAJOR_DEFENSIVE_IDS,
} from './cooldowns';
import { reconstructEnemyCDTimeline } from './enemyCDs';

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[half];
  }
  return (sorted[half - 1] + sorted[half]) / 2.0;
}

function computeCDResponseLatency(
  annotatedCooldowns: IMajorCooldownInfo[],
  burstWindows: Array<{ fromSeconds: number; toSeconds: number }>,
  matchStartMs: number,
): number | null {
  const latenciesMs: number[] = [];

  for (const cd of annotatedCooldowns) {
    for (const cast of cd.casts) {
      if (cast.timingLabel !== 'Optimal' && cast.timingLabel !== 'Reactive') continue;
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
  return median(latenciesMs);
}

export interface IHealerMetrics {
  offensiveIndex: number;
  ccDensity: number;
  reactionLatency: number;
  defensiveOverlapRatio: number;
  effectiveCastRatio: number;
  ccAvoidanceRate: number;
}

export function computeHealerMetrics(combat: IArenaMatch | IShuffleRound, playerName: string): IHealerMetrics {
  const allUnits = Object.values(combat.units);
  const healerUnit = allUnits.find((u) => u.name === playerName && u.type === CombatUnitType.Player);

  if (!healerUnit) {
    throw new Error(`Healer unit ${playerName} not found in combat.`);
  }

  // 1. offensiveIndex (Damage:Heal ratio)
  const totalDamageOut = healerUnit.damageOut.reduce((sum, a) => sum + Math.abs(a.effectiveAmount), 0);
  const totalHealOut =
    healerUnit.healOut.reduce((sum, a) => {
      if (
        (a.logLine.event === 'SPELL_PERIODIC_HEAL' || a.logLine.event === 'SPELL_HEAL') &&
        typeof a.logLine.parameters[30] === 'number' &&
        typeof a.logLine.parameters[32] === 'number' &&
        !isNaN(a.logLine.parameters[30]) &&
        !isNaN(a.logLine.parameters[32])
      ) {
        return sum + (a.logLine.parameters[30] - a.logLine.parameters[32]);
      }
      return sum + Math.abs(a.effectiveAmount);
    }, 0) + healerUnit.absorbsOut.reduce((sum, a) => sum + Math.abs(a.effectiveAmount), 0);

  const offensiveIndex = totalHealOut > 0 ? totalDamageOut / totalHealOut : 0;

  // 2. ccDensity (CC count per minute)
  const ccCasts = healerUnit.spellCastEvents.filter(
    (e) => e.logLine.event === 'SPELL_CAST_SUCCESS' && ccSpellIds.has(String(e.spellId)),
  );
  const durationSeconds = (combat.endTime - combat.startTime) / 1000;
  const ccDensity = durationSeconds > 0 ? (ccCasts.length / durationSeconds) * 60 : 0;

  // 3. reactionLatency
  const friends = allUnits.filter((u) => u.type === CombatUnitType.Player && u.reaction === healerUnit.reaction);
  const enemies = allUnits.filter((u) => u.type === CombatUnitType.Player && u.reaction !== healerUnit.reaction);

  const enemyCDTimeline = reconstructEnemyCDTimeline(enemies, combat, healerUnit, friends);
  const cooldowns = extractMajorCooldowns(healerUnit, combat);
  const annotated = annotateDefensiveTimings(cooldowns, healerUnit, combat, enemyCDTimeline);

  const latencyMs = computeCDResponseLatency(annotated, enemyCDTimeline.alignedBurstWindows, combat.startTime);
  const reactionLatency = latencyMs !== null ? latencyMs / 1000 : 1.5;

  // 4. defensiveOverlapRatio
  const overlaps = detectOverlappedDefensives(friends, combat);
  const myOverlapCount = overlaps.filter(
    (o) => o.firstCasterName === playerName || o.secondCasterName === playerName,
  ).length;
  const myTotalDefensives = healerUnit.spellCastEvents.filter((e) => MAJOR_DEFENSIVE_IDS.has(String(e.spellId))).length;
  const defensiveOverlapRatio = myOverlapCount / (myTotalDefensives + 1);

  // 5. effectiveCastRatio
  const ccTrinketSummary = analyzePlayerCCAndTrinket(healerUnit, enemies, combat);
  const successCasts = healerUnit.spellCastEvents.filter((e) => e.logLine.event === 'SPELL_CAST_SUCCESS').length;
  const interuptsOnMe = ccTrinketSummary.interruptInstances.length;
  const effectiveCastRatio = successCasts / (successCasts + interuptsOnMe + 1);

  // 6. ccAvoidanceRate
  const avoidedCount = ccTrinketSummary.ccAvoidedInstances.length;
  const successfulCCCount = ccTrinketSummary.ccInstances.length;
  const ccAvoidanceRate = avoidedCount / (avoidedCount + successfulCCCount + 1);

  return {
    offensiveIndex,
    ccDensity,
    reactionLatency,
    defensiveOverlapRatio,
    effectiveCastRatio,
    ccAvoidanceRate,
  };
}

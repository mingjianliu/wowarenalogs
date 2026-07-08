/**
 * positionAnalysis.ts — owner engagement-state analysis from real X/Y coordinates.
 *
 * Answers "when should I push in vs. stay back?" with positional evidence,
 * cross-referencing burst windows and cooldown availability already computed
 * elsewhere. All events are point-in-time distance facts — no free-form paths.
 *
 * Requires advanced combat logging (unit.advancedActions); silently returns no
 * events when positions are absent. Distances are in game yards (~1 unit).
 */

import { AtomicArenaCombat, ICombatUnit } from '@wowarenalogs/parser';

import { ICCInstance } from './ccTrinketAnalysis';
import { fmtTime, IMajorCooldownInfo } from './cooldowns';
import { IAlignedBurstWindow } from './enemyCDs';
import { distanceBetween, getUnitPositionAtTime } from './losAnalysis';

// Thresholds (yards / seconds) — starting values from the Feature 15 spec.
const CLOSE_RANGE_YARDS = 12; // "in range" of an enemy
const KITE_DELTA_YARDS = 10; // distance gained that counts as a successful kite
const STAY_DELTA_YARDS = 5; // distance gained below this = stayed in
const MISSED_PUSH_MELEE_YARDS = 20; // melee parked beyond this = disengaged
const MISSED_PUSH_RANGED_YARDS = 45; // ranged beyond this = disengaged (max cast range is 40yd — 35–40yd is normal max-range play)
const CD_RANGE_YARDS = 15; // offensive CD cast beyond this = out of position
const CD_RANGE_RECHECK_SECONDS = 5; // still out of range this long after the cast
const BURST_EVAL_SECONDS = 10; // evaluate kite/stay over at most this much of the window
const MISSED_PUSH_MIN_SECONDS = 10; // sustained disengagement required
const KILL_PROXIMITY_SECONDS = 15; // ignore disengagement right before an enemy death
const MAX_MISSED_PUSH_EVENTS = 3;
// Position snapshots are event-driven; when the query time is further than this
// from the nearest snapshot, the interpolated position is fabricated (unit was
// idle/stealthed/drinking) — treat as unknown.
const POSITION_MAX_GAP_MS = 8_000;

export type PositionEventType = 'STAYED_IN' | 'KITED' | 'MISSED_PUSH' | 'CD_OUT_OF_RANGE';

export interface IPositionEvent {
  type: PositionEventType;
  atSeconds: number;
  /** Window end for window-scoped events (STAYED_IN / KITED / MISSED_PUSH) */
  toSeconds?: number;
  startDistanceYards?: number;
  endDistanceYards?: number;
  nearestEnemyName?: string;
  /** Burst window threat label for STAYED_IN / KITED */
  dangerLabel?: string;
  /** Dampening during the window (0–1), for the "staying in may be correct" nuance */
  dampeningPct?: number;
  /** STAYED_IN only: whether a defensive CD was off cooldown at window start.
   *  undefined when no defensive CDs are tracked for this spec. */
  ownerDefensiveAvailable?: boolean;
  /** STAYED_IN only: whether the burst's most-pressured target was the owner.
   *  undefined when the window has no pressure-target attribution. */
  burstTargetsOwner?: boolean;
  /** STAYED_IN only: name of the burst's most-pressured target when it isn't the owner */
  burstTargetName?: string;
  /** CD_OUT_OF_RANGE only */
  spellName?: string;
}

interface INearestEnemy {
  distanceYards: number;
  enemyName: string;
}

/** True when the unit has died at or before the given timestamp. A corpse's
 *  last-known position is returned by getUnitPositionAtTime indefinitely, so
 *  dead enemies must be excluded from distance checks. */
function isDeadAt(unit: ICombatUnit, tMs: number): boolean {
  return (unit.deathRecords ?? []).some((d) => d.timestamp <= tMs);
}

function nearestEnemyAt(
  enemies: ICombatUnit[],
  ownerPos: { x: number; y: number } | null,
  tMs: number,
  ownerUnit: ICombatUnit,
): INearestEnemy | null {
  const pos = ownerPos ?? getUnitPositionAtTime(ownerUnit, tMs, POSITION_MAX_GAP_MS);
  if (!pos) return null;
  let best: INearestEnemy | null = null;
  for (const enemy of enemies) {
    if (isDeadAt(enemy, tMs)) continue;
    const enemyPos = getUnitPositionAtTime(enemy, tMs, POSITION_MAX_GAP_MS);
    if (!enemyPos) continue;
    const d = distanceBetween(pos, enemyPos);
    if (best === null || d < best.distanceYards) {
      best = { distanceYards: d, enemyName: enemy.name };
    }
  }
  return best;
}

/** Seconds of [fromSeconds, toSeconds] during which the owner was in hard CC.
 *  Overlapping CC instances (simultaneous stun + silence) are merged, not
 *  summed — otherwise stacked CCs could exceed the window length. */
function ccOverlapSeconds(
  ccInstances: Array<Pick<ICCInstance, 'atSeconds' | 'durationSeconds'>>,
  fromSeconds: number,
  toSeconds: number,
): number {
  const clipped = ccInstances
    .map((cc) => ({
      from: Math.max(fromSeconds, cc.atSeconds),
      to: Math.min(toSeconds, cc.atSeconds + cc.durationSeconds),
    }))
    .filter((iv) => iv.to > iv.from)
    .sort((a, b) => a.from - b.from);

  let total = 0;
  let curFrom = -Infinity;
  let curTo = -Infinity;
  for (const iv of clipped) {
    if (iv.from > curTo) {
      total += curTo - curFrom > 0 ? curTo - curFrom : 0;
      curFrom = iv.from;
      curTo = iv.to;
    } else {
      curTo = Math.max(curTo, iv.to);
    }
  }
  total += curTo - curFrom > 0 ? curTo - curFrom : 0;
  return total;
}

function isAvailableAt(cd: IMajorCooldownInfo, atSeconds: number): boolean {
  return cd.availableWindows.some((w) => atSeconds >= w.fromSeconds && atSeconds <= w.toSeconds);
}

export function computeOwnerPositionEvents(params: {
  owner: ICombatUnit;
  enemies: ICombatUnit[];
  combat: Pick<AtomicArenaCombat, 'startTime' | 'endTime'>;
  burstWindows: IAlignedBurstWindow[];
  ownerCooldowns: IMajorCooldownInfo[];
  ownerCCSummary?: { ccInstances: Array<Pick<ICCInstance, 'atSeconds' | 'durationSeconds'>> };
  isHealer: boolean;
  ownerIsMelee: boolean;
}): IPositionEvent[] {
  const { owner, enemies, combat, burstWindows, ownerCooldowns, ownerCCSummary, isHealer, ownerIsMelee } = params;
  const matchStartMs = combat.startTime;
  const durationSeconds = (combat.endTime - combat.startTime) / 1000;
  const events: IPositionEvent[] = [];

  if ((owner.advancedActions ?? []).length === 0) return [];

  const ccInstances = ownerCCSummary?.ccInstances ?? [];
  const defensiveCDs = ownerCooldowns.filter((cd) => cd.tag === 'Defensive');
  const offensiveCDs = ownerCooldowns.filter((cd) => cd.tag === 'Offensive');

  // ── 1. Burst-window engagement: STAYED_IN / KITED ─────────────────────────
  for (const w of burstWindows) {
    const evalEnd = Math.min(w.toSeconds, w.fromSeconds + BURST_EVAL_SECONDS);
    const evalSpan = evalEnd - w.fromSeconds;
    if (evalSpan <= 0) continue;

    // CC'd for most of the window → could not choose to kite; not a decision
    if (ccOverlapSeconds(ccInstances, w.fromSeconds, evalEnd) >= evalSpan / 2) continue;

    const start = nearestEnemyAt(enemies, null, matchStartMs + w.fromSeconds * 1000, owner);
    const end = nearestEnemyAt(enemies, null, matchStartMs + evalEnd * 1000, owner);
    if (!start || !end) continue;
    if (start.distanceYards > CLOSE_RANGE_YARDS) continue; // was not in range to begin with

    // Sample every second across the window: hit-and-run kiting (out and back)
    // shows up as a mid-window peak that endpoint-only checks would miss.
    let maxDistance = Math.max(start.distanceYards, end.distanceYards);
    for (let t = Math.ceil(w.fromSeconds) + 1; t < evalEnd; t += 1) {
      const sample = nearestEnemyAt(enemies, null, matchStartMs + t * 1000, owner);
      if (sample) maxDistance = Math.max(maxDistance, sample.distanceYards);
    }

    const delta = end.distanceYards - start.distanceYards;
    if (maxDistance - start.distanceYards >= KITE_DELTA_YARDS) {
      events.push({
        type: 'KITED',
        atSeconds: w.fromSeconds,
        toSeconds: evalEnd,
        startDistanceYards: Math.round(start.distanceYards * 10) / 10,
        // Peak distance, not endpoint — a hit-and-run kite re-engages before the window ends
        endDistanceYards: Math.round(maxDistance * 10) / 10,
        nearestEnemyName: start.enemyName,
        dangerLabel: w.dangerLabel,
        dampeningPct: w.dampeningPct,
      });
    } else if (delta < STAY_DELTA_YARDS) {
      // Who was the burst actually aimed at? A melee DPS staying on their target
      // while the burst hits a teammate is normal offense, not a mistake — suppress.
      // Healers/ranged near an enemy during any burst remain worth surfacing, annotated.
      const targetName = w.mostPressuredTarget?.unitName;
      const burstTargetsOwner = targetName !== undefined ? targetName === owner.name : undefined;
      if (ownerIsMelee && !isHealer && burstTargetsOwner === false) continue;

      events.push({
        type: 'STAYED_IN',
        atSeconds: w.fromSeconds,
        toSeconds: evalEnd,
        startDistanceYards: Math.round(start.distanceYards * 10) / 10,
        endDistanceYards: Math.round(end.distanceYards * 10) / 10,
        nearestEnemyName: start.enemyName,
        dangerLabel: w.dangerLabel,
        dampeningPct: w.dampeningPct,
        ownerDefensiveAvailable:
          defensiveCDs.length > 0 ? defensiveCDs.some((cd) => isAvailableAt(cd, w.fromSeconds)) : undefined,
        burstTargetsOwner,
        burstTargetName: burstTargetsOwner === false ? targetName : undefined,
      });
    }
    // deltas in [STAY_DELTA, KITE_DELTA) are ambiguous — no event
  }

  // ── 2. MISSED_PUSH: offensive CDs up, no enemy burst, parked far away ─────
  if (!isHealer && offensiveCDs.length > 0) {
    const threshold = ownerIsMelee ? MISSED_PUSH_MELEE_YARDS : MISSED_PUSH_RANGED_YARDS;
    const enemyDeathTimes = enemies.flatMap((e) =>
      (e.deathRecords ?? []).map((d) => (d.timestamp - matchStartMs) / 1000),
    );

    let runStart: number | null = null;
    let runMinDist = Infinity;
    let missedPushCount = 0;

    const closeRun = (endSeconds: number) => {
      if (
        runStart !== null &&
        endSeconds - runStart >= MISSED_PUSH_MIN_SECONDS &&
        missedPushCount < MAX_MISSED_PUSH_EVENTS
      ) {
        events.push({
          type: 'MISSED_PUSH',
          atSeconds: runStart,
          toSeconds: endSeconds,
          startDistanceYards: Math.round(runMinDist * 10) / 10,
        });
        missedPushCount++;
      }
      runStart = null;
      runMinDist = Infinity;
    };

    // MISSED_PUSH asserts ">threshold from ALL enemies" — that claim needs every
    // living enemy's position to be known. A stealthed/idle enemy (no recent
    // snapshots) could be anywhere, including on top of the owner.
    const allLivingEnemiesKnownAt = (tMs: number) =>
      enemies.every((e) => isDeadAt(e, tMs) || getUnitPositionAtTime(e, tMs, POSITION_MAX_GAP_MS) !== null);

    for (let t = 0; t <= durationSeconds; t += 1) {
      const tMs = matchStartMs + t * 1000;
      const allOffensivesReady = offensiveCDs.every((cd) => isAvailableAt(cd, t));
      const inBurst = burstWindows.some((w) => t >= w.fromSeconds && t <= w.toSeconds);
      const nearKill = enemyDeathTimes.some((d) => t >= d - KILL_PROXIMITY_SECONDS && t <= d);
      const nearest =
        allOffensivesReady && !inBurst && !nearKill && allLivingEnemiesKnownAt(tMs)
          ? nearestEnemyAt(enemies, null, tMs, owner)
          : null;

      if (nearest && nearest.distanceYards > threshold) {
        if (runStart === null) runStart = t;
        runMinDist = Math.min(runMinDist, nearest.distanceYards);
      } else {
        closeRun(t);
      }
    }
    closeRun(durationSeconds);
  }

  // ── 3. CD_OUT_OF_RANGE: offensive CD cast far from every enemy ────────────
  if (!isHealer) {
    for (const cd of offensiveCDs) {
      for (const cast of cd.casts) {
        const atCast = nearestEnemyAt(enemies, null, matchStartMs + cast.timeSeconds * 1000, owner);
        if (!atCast || atCast.distanceYards <= CD_RANGE_YARDS) continue;
        const later = nearestEnemyAt(
          enemies,
          null,
          matchStartMs + (cast.timeSeconds + CD_RANGE_RECHECK_SECONDS) * 1000,
          owner,
        );
        // Only flag when still out of range shortly after — a cast mid-approach that
        // connects within seconds is normal play, not wasted uptime.
        if (later && later.distanceYards > CD_RANGE_YARDS) {
          events.push({
            type: 'CD_OUT_OF_RANGE',
            atSeconds: cast.timeSeconds,
            startDistanceYards: Math.round(atCast.distanceYards * 10) / 10,
            nearestEnemyName: atCast.enemyName,
            spellName: cd.spellName,
          });
        }
      }
    }
  }

  return events.sort((a, b) => a.atSeconds - b.atSeconds);
}

// ─── Formatter ───────────────────────────────────────────────────────────────

export function formatPositionEventsForContext(events: IPositionEvent[]): string[] {
  if (events.length === 0) return [];

  const lines: string[] = [];
  lines.push('POSITIONING (log owner only; distances from advanced-logging coordinates):');

  const stayedIn = events.filter((e) => e.type === 'STAYED_IN');
  const kited = events.filter((e) => e.type === 'KITED');
  const missedPush = events.filter((e) => e.type === 'MISSED_PUSH');
  const outOfRange = events.filter((e) => e.type === 'CD_OUT_OF_RANGE');

  if (stayedIn.length > 0) {
    lines.push('  STAYED IN during enemy burst (close range, little distance gained):');
    for (const e of stayedIn) {
      const defStr =
        e.ownerDefensiveAvailable === undefined
          ? ''
          : e.ownerDefensiveAvailable
            ? ' — a defensive CD was available'
            : ' — no defensive CD available';
      const dampStr = (e.dampeningPct ?? 0) >= 0.2 ? ' (high dampening — staying in may be correct)' : '';
      const targetStr =
        e.burstTargetsOwner === true
          ? ' — you were the burst target'
          : e.burstTargetName
            ? ` — burst targeted ${e.burstTargetName}, staying in may be deliberate`
            : '';
      lines.push(
        `    ${fmtTime(e.atSeconds)} [${e.dangerLabel} burst] ${e.startDistanceYards}→${e.endDistanceYards}yd from ${e.nearestEnemyName}${targetStr}${defStr}${dampStr}`,
      );
    }
  }

  if (kited.length > 0) {
    lines.push('  KITED during enemy burst (opened distance):');
    for (const e of kited) {
      lines.push(
        `    ${fmtTime(e.atSeconds)} [${e.dangerLabel} burst] opened ${e.startDistanceYards}→${e.endDistanceYards}yd from ${e.nearestEnemyName}`,
      );
    }
  }

  if (missedPush.length > 0) {
    lines.push('  MISSED PUSH (your offensive CDs available, no enemy burst, but disengaged):');
    for (const e of missedPush) {
      lines.push(
        `    ${fmtTime(e.atSeconds)}–${fmtTime(e.toSeconds ?? e.atSeconds)} stayed >${e.startDistanceYards}yd from all enemies`,
      );
    }
  }

  if (outOfRange.length > 0) {
    lines.push('  OFFENSIVE CD OUT OF RANGE (cast while far from every enemy):');
    for (const e of outOfRange) {
      lines.push(
        `    ${fmtTime(e.atSeconds)} ${e.spellName} cast ${e.startDistanceYards}yd from nearest enemy (still >${CD_RANGE_YARDS}yd ${CD_RANGE_RECHECK_SECONDS}s later)`,
      );
    }
  }

  lines.push(
    '  Note: melee and ranged expected distances differ; treat these as engagement-state evidence, not verdicts.',
  );

  return lines;
}

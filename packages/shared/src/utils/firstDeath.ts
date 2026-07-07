import { AtomicArenaCombat, ICombatUnit, ILogLine, LogEvent } from '@wowarenalogs/parser';

import { ccSpellIds } from '../data/spellTags';
import { extractMajorCooldowns, getUnitHpAtTimestamp, getUnitManaAtTimestamp, specToString } from './cooldowns';
import { reconstructEnemyCDTimeline } from './enemyCDs';

// Audit constants (2026-07-07). Change ⇒ re-run the corpus audit; results are not comparable across values.
export const FIRST_DEATH_WINDOW_SECONDS = 15;
export const CC_LOCKED_MIN_SECONDS = 3;
export const FOCUS_SHARE_THRESHOLD = 0.6;
export const GCD_IDLE_GAP_SECONDS = 3;
export const IDLE_HP_THRESHOLD_PCT = 60;

const HOLD_TAGS = new Set<string>(['Defensive', 'External']);

export interface IFirstDeathFeatures {
  victimName: string;
  victimSpec: string;
  victimIsFriendly: boolean;
  victimIsOwner: boolean;
  atSeconds: number;
  healerCCLockedSeconds: number;
  healerCCLocked: boolean;
  enemyBurstActive: boolean;
  victimDefensivesUnused: string[];
  victimUsedDefensiveInWindow: boolean;
  healerMaxCastGapSeconds: number | null;
  healerGcdIdle: boolean;
  healerManaPct: number | null;
  victimFocusShare: number | null;
  victimFocused: boolean;
  victimSwappedTo: boolean;
}

export type FirstDeathBucket =
  | 'A_HEALER_CC_LOCKED'
  | 'B_DEFENSIVES_HELD'
  | 'C_COORDINATED_FOCUS'
  | 'D_HEALER_IDLE'
  | 'UNCLASSIFIED';

function firstDeathOf(units: ICombatUnit[]): { unit: ICombatUnit; line: ILogLine } | null {
  let best: { unit: ICombatUnit; line: ILogLine } | null = null;
  for (const u of units) {
    for (const line of u.deathRecords) {
      if (!best || line.timestamp < best.line.timestamp) best = { unit: u, line };
    }
  }
  return best;
}

/** Seconds of CC on `unit` clipped to [fromMs, toMs], using the aura stack walk from CombatReportContext. */
function ccSecondsInWindow(unit: ICombatUnit, fromMs: number, toMs: number): number {
  let total = 0;
  let ccStartTime = -1;
  let ccStack = 0;
  for (const event of unit.auraEvents) {
    const spellId = event.spellId || '';
    if (!ccSpellIds.has(spellId)) continue;
    if (event.logLine.event === LogEvent.SPELL_AURA_APPLIED) {
      if (ccStartTime < 0) ccStartTime = event.logLine.timestamp;
      ccStack++;
    } else if (event.logLine.event === LogEvent.SPELL_AURA_REMOVED) {
      ccStack--;
      if (ccStack === 0 && ccStartTime >= 0) {
        const s = Math.max(ccStartTime, fromMs);
        const e = Math.min(event.logLine.timestamp, toMs);
        if (e > s) total += e - s;
        ccStartTime = -1;
      }
    }
  }
  // CC still applied when the window (death) ends
  if (ccStack > 0 && ccStartTime >= 0) {
    const s = Math.max(ccStartTime, fromMs);
    if (toMs > s) total += toMs - s;
  }
  return total / 1000;
}

function damageIntoInWindow(unit: ICombatUnit, fromMs: number, toMs: number): number {
  return unit.damageIn
    .filter((e) => e.logLine.timestamp >= fromMs && e.logLine.timestamp <= toMs)
    .reduce((sum, e) => sum + Math.abs(e.effectiveAmount), 0);
}

export function extractFirstDeathFeatures(
  combat: AtomicArenaCombat,
  friends: ICombatUnit[],
  enemies: ICombatUnit[],
  owner: ICombatUnit,
): IFirstDeathFeatures | null {
  const death = firstDeathOf([...friends, ...enemies]);
  if (!death) return null;

  const deathMs = death.line.timestamp;
  const fromMs = deathMs - FIRST_DEATH_WINDOW_SECONDS * 1000;
  const atSeconds = (deathMs - combat.startTime) / 1000;
  const victim = death.unit;
  const victimIsFriendly = friends.some((f) => f.id === victim.id);

  // healer features (the corpus owner is the healer)
  const healerCCLockedSeconds = ccSecondsInWindow(owner, fromMs, deathMs);
  const manaAtStart = getUnitManaAtTimestamp(owner, fromMs);

  // enemy burst overlapping the window
  const timeline = reconstructEnemyCDTimeline(enemies, combat, owner, friends);
  const fromSec = (fromMs - combat.startTime) / 1000;
  const enemyBurstActive = timeline.alignedBurstWindows.some(
    (w) => w.fromSeconds <= atSeconds && w.toSeconds >= fromSec,
  );

  // victim defensives: majors not cast in the window but available at its start (availableWindows IS
  // earlier-cast CD math — no other availability guessing, per spec)
  const victimMajors = extractMajorCooldowns(victim, combat).filter((cd) => !cd.isThroughput && HOLD_TAGS.has(cd.tag));
  const unused = victimMajors.filter(
    (cd) =>
      !cd.casts.some((c) => c.timeSeconds >= fromSec && c.timeSeconds <= atSeconds) &&
      cd.availableWindows.some((aw) => aw.fromSeconds <= fromSec && fromSec < aw.toSeconds),
  );
  const victimUsedDefensiveInWindow = victimMajors.some((cd) =>
    cd.casts.some((c) => c.timeSeconds >= fromSec && c.timeSeconds <= atSeconds),
  );

  // healer largest cast gap inside the window
  const healerCastsMs = owner.spellCastEvents
    .filter((e) => e.logLine.event === LogEvent.SPELL_CAST_SUCCESS)
    .map((e) => e.logLine.timestamp)
    .filter((t) => t >= fromMs && t <= deathMs)
    .sort((a, b) => a - b);
  const gapPoints = [fromMs, ...healerCastsMs, deathMs];
  let maxGapMs = 0;
  let maxGapStartMs = fromMs;
  for (let i = 1; i < gapPoints.length; i++) {
    const gap = gapPoints[i] - gapPoints[i - 1];
    if (gap > maxGapMs) {
      maxGapMs = gap;
      maxGapStartMs = gapPoints[i - 1];
    }
  }
  const victimHpAtGapStart = getUnitHpAtTimestamp(victim, maxGapStartMs);
  const healerGcdIdle =
    maxGapMs / 1000 >= GCD_IDLE_GAP_SECONDS &&
    victimHpAtGapStart !== null &&
    victimHpAtGapStart < IDLE_HP_THRESHOLD_PCT;

  // focus + swap: damage into the victim vs into the victim's whole team, split-half for swap detection
  const victimTeam = victimIsFriendly ? friends : enemies;
  const teamDamage = victimTeam.map((u) => ({ id: u.id, dmg: damageIntoInWindow(u, fromMs, deathMs) }));
  const totalTeamDamage = teamDamage.reduce((s, x) => s + x.dmg, 0);
  const victimDamage = teamDamage.find((x) => x.id === victim.id)?.dmg ?? 0;
  const victimFocusShare = totalTeamDamage > 0 ? victimDamage / totalTeamDamage : null;

  const midMs = fromMs + (deathMs - fromMs) / 2;
  const firstHalfLeader = victimTeam
    .map((u) => ({ id: u.id, dmg: damageIntoInWindow(u, fromMs, midMs) }))
    .sort((a, b) => b.dmg - a.dmg)[0];
  const secondHalfLeader = victimTeam
    .map((u) => ({ id: u.id, dmg: damageIntoInWindow(u, midMs, deathMs) }))
    .sort((a, b) => b.dmg - a.dmg)[0];
  const victimSwappedTo =
    !!firstHalfLeader &&
    !!secondHalfLeader &&
    firstHalfLeader.dmg > 0 &&
    firstHalfLeader.id !== victim.id &&
    secondHalfLeader.id === victim.id;

  return {
    victimName: victim.name,
    victimSpec: specToString(victim.spec),
    victimIsFriendly,
    victimIsOwner: victim.id === owner.id,
    atSeconds,
    healerCCLockedSeconds,
    healerCCLocked: healerCCLockedSeconds >= CC_LOCKED_MIN_SECONDS,
    enemyBurstActive,
    victimDefensivesUnused: unused.map((cd) => cd.spellName),
    victimUsedDefensiveInWindow,
    healerMaxCastGapSeconds: maxGapMs / 1000,
    healerGcdIdle,
    healerManaPct: manaAtStart && manaAtStart.max > 0 ? (100 * manaAtStart.current) / manaAtStart.max : null,
    victimFocusShare,
    victimFocused: victimFocusShare !== null && victimFocusShare >= FOCUS_SHARE_THRESHOLD,
    victimSwappedTo,
  };
}

/** Deterministic decision list — first match wins. Order is the taxonomy; do not reorder casually. */
export function bucketFirstDeath(f: IFirstDeathFeatures): FirstDeathBucket {
  if (f.healerCCLocked) return 'A_HEALER_CC_LOCKED';
  if (f.enemyBurstActive && f.victimDefensivesUnused.length > 0 && !f.victimUsedDefensiveInWindow)
    return 'B_DEFENSIVES_HELD';
  if (f.enemyBurstActive && f.victimFocused) return 'C_COORDINATED_FOCUS';
  if (f.healerGcdIdle) return 'D_HEALER_IDLE';
  return 'UNCLASSIFIED';
}

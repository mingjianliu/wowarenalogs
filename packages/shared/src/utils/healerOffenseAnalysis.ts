import { ICombatUnit, LogEvent } from '@wowarenalogs/parser';

import spellsData from '../data/spells.json';
import { ccSpellIds } from '../data/spellTags';
import { IEnemyCDTimeline } from './enemyCDs';
import { getHpPercentAtTime } from './killWindowTargetSelection';

type SpellEntry = { type: string };
const SPELLS = spellsData as Record<string, SpellEntry>;

/** Local feature flags, mirroring DISPEL_FEATURE_FLAGS pattern. */
export const HEALER_OFFENSE_FLAGS = {
  V1_SLACK_GATED: true,
};

export const SLACK_TEAM_HP_THRESHOLD = 85;
export const MIN_SLACK_SECONDS = 4;
export const IDLE_PRIORITY_SECONDS = 6;
export const MOBILITY_EXCLUSION_SECONDS = 3;
export const MAX_WINDOW_CREATION_FACTS = 2;

export interface ISlackSegment {
  fromSeconds: number;
  toSeconds: number;
  durationSeconds: number;
  /** Effective damage the owner dealt to enemies inside the segment. */
  ownerDamage: number;
  ownerCCCasts: number;
  ownerPurgeCasts: number;
  ownerKickCasts: number;
  /** True when the owner produced zero offensive output of any kind. */
  idle: boolean;
}

type CCInterval = ReadonlyArray<{ atSeconds: number; durationSeconds: number }>;

function isEnemyCDActiveAt(timeline: IEnemyCDTimeline, t: number): boolean {
  return timeline.players.some((p) => p.offensiveCDs.some((cd) => cd.castTimeSeconds <= t && t < cd.buffEndSeconds));
}

function isOwnerCCdAt(ownerCC: CCInterval, t: number): boolean {
  return ownerCC.some((cc) => cc.atSeconds <= t && t < cc.atSeconds + cc.durationSeconds);
}

function ownerMobilityCastTimes(owner: ICombatUnit, matchStartMs: number): number[] {
  return owner.spellCastEvents
    .filter(
      (e) =>
        e.logLine.event === LogEvent.SPELL_CAST_SUCCESS && e.spellId && SPELLS[e.spellId]?.type === 'buffs_speed_boost',
    )
    .map((e) => (e.logLine.timestamp - matchStartMs) / 1000);
}

export function computeSlackSegments(
  combat: { startTime: number; endTime: number },
  owner: ICombatUnit,
  friends: ICombatUnit[],
  enemies: ICombatUnit[],
  enemyCDTimeline: IEnemyCDTimeline,
  ownerCCInstances: CCInterval,
  ownerPurgeTimesSeconds: ReadonlyArray<number>,
): { advancedLoggingAvailable: boolean; segments: ISlackSegment[] } {
  const matchStartMs = combat.startTime;
  const durationSeconds = Math.floor((combat.endTime - combat.startTime) / 1000);

  const advancedLoggingAvailable = friends.every((f) => f.advancedActions.length > 0);
  if (!advancedLoggingAvailable) return { advancedLoggingAvailable: false, segments: [] };

  const mobilityTimes = ownerMobilityCastTimes(owner, matchStartMs);

  const isSlackSecond = (t: number): boolean => {
    for (const f of friends) {
      const hp = getHpPercentAtTime(f, t, matchStartMs);
      if (hp === null || hp < SLACK_TEAM_HP_THRESHOLD) return false;
    }
    if (isEnemyCDActiveAt(enemyCDTimeline, t)) return false;
    if (isOwnerCCdAt(ownerCCInstances, t)) return false;
    if (mobilityTimes.some((m) => t >= m && t < m + MOBILITY_EXCLUSION_SECONDS)) return false;
    return true;
  };

  // 1s-resolution sweep, merge consecutive slack seconds into segments
  const raw: Array<{ fromSeconds: number; toSeconds: number }> = [];
  let segStart: number | null = null;
  for (let t = 0; t <= durationSeconds; t++) {
    if (isSlackSecond(t)) {
      if (segStart === null) segStart = t;
    } else if (segStart !== null) {
      raw.push({ fromSeconds: segStart, toSeconds: t });
      segStart = null;
    }
  }
  if (segStart !== null) raw.push({ fromSeconds: segStart, toSeconds: durationSeconds });

  const enemyIds = new Set(enemies.map((e) => e.id));

  const segments: ISlackSegment[] = raw
    .filter((s) => s.toSeconds - s.fromSeconds >= MIN_SLACK_SECONDS)
    .map((s) => {
      const inSeg = (ms: number) => {
        const t = (ms - matchStartMs) / 1000;
        return t >= s.fromSeconds && t < s.toSeconds;
      };
      const ownerDamage = owner.damageOut
        .filter((d) => inSeg(d.logLine.timestamp) && enemyIds.has(d.destUnitId))
        .reduce((sum, d) => sum + Math.max(0, d.effectiveAmount), 0);
      const casts = owner.spellCastEvents.filter(
        (e) => e.logLine.event === LogEvent.SPELL_CAST_SUCCESS && inSeg(e.logLine.timestamp) && e.spellId,
      );
      const ownerCCCasts = casts.filter((e) => ccSpellIds.has(e.spellId as string)).length;
      const ownerKickCasts = casts.filter((e) => SPELLS[e.spellId as string]?.type === 'interrupts').length;
      const ownerPurgeCasts = ownerPurgeTimesSeconds.filter((t) => t >= s.fromSeconds && t < s.toSeconds).length;

      const idle = ownerDamage === 0 && ownerCCCasts === 0 && ownerKickCasts === 0 && ownerPurgeCasts === 0;
      return {
        fromSeconds: s.fromSeconds,
        toSeconds: s.toSeconds,
        durationSeconds: s.toSeconds - s.fromSeconds,
        ownerDamage,
        ownerCCCasts,
        ownerPurgeCasts,
        ownerKickCasts,
        idle,
      };
    });

  return { advancedLoggingAvailable: true, segments };
}

import { AtomicArenaCombat, CombatResult, ICombatUnit, LogEvent } from '@wowarenalogs/parser';

import { spellEffectData } from '../data/spellEffectData';
import { ccSpellIds } from '../data/spellTags';
import { extractMajorCooldowns, isHealerSpec, specToString } from './cooldowns';
import { IAlignedBurstWindow, IEnemyPlayerTimeline, reconstructEnemyCDTimeline } from './enemyCDs';

// Matches DEFENSIVE_TAGS in cooldowns.ts — SpellTag.External was removed from the enum,
// so the external tag is compared as a string literal there too.
const HOLD_TAGS = new Set<string>(['Defensive', 'External']);

export interface IHoldStatus {
  spellId: string;
  spellName: string;
  availableAtWindowStart: boolean;
  castInWindow: boolean;
}

export interface IKillWindowIntel {
  fromSeconds: number;
  toSeconds: number;
  threatLabel: IAlignedBurstWindow['threatLabel'];
  activeCDs: IAlignedBurstWindow['activeCDs'];
  dampeningPct: number;
  healerCCed: boolean;
  holds: IHoldStatus[];
}

export interface ICCOnHealer {
  atSeconds: number;
  spellId: string;
  spellName: string;
  inKillWindow: boolean;
}

export interface IMatchupIntelCard {
  enemyComp: string[];
  /** null when the parser could not determine the result */
  isWin: boolean | null;
  killWindows: IKillWindowIntel[];
  enemyCDInventory: IEnemyPlayerTimeline[];
  ccOnHealer: ICCOnHealer[];
  hasBurstWindows: boolean;
}

/**
 * Everything on the card is derived from THIS match's log — actual casts, actual windows,
 * actual availability. No static comp rules (see feedback_comp_heuristics).
 */
export function buildMatchupIntel(
  combat: AtomicArenaCombat,
  friends: ICombatUnit[],
  enemies: ICombatUnit[],
): IMatchupIntelCard {
  const healer = friends.find((u) => isHealerSpec(u.spec));
  const viewer = friends.find((u) => u.id === combat.playerId) ?? friends[0];
  const timeline = reconstructEnemyCDTimeline(enemies, combat, healer, friends);

  const holdCandidates = viewer
    ? extractMajorCooldowns(viewer, combat).filter((cd) => !cd.isThroughput && HOLD_TAGS.has(cd.tag))
    : [];

  const killWindows: IKillWindowIntel[] = timeline.alignedBurstWindows.map((w) => ({
    fromSeconds: w.fromSeconds,
    toSeconds: w.toSeconds,
    threatLabel: w.threatLabel,
    activeCDs: w.activeCDs,
    dampeningPct: w.dampeningPct,
    healerCCed: w.healerCCed,
    holds: holdCandidates.map((cd) => ({
      spellId: cd.spellId,
      spellName: cd.spellName,
      availableAtWindowStart: cd.availableWindows.some(
        (aw) => aw.fromSeconds <= w.fromSeconds && w.fromSeconds < aw.toSeconds,
      ),
      castInWindow: cd.casts.some((c) => c.timeSeconds >= w.fromSeconds && c.timeSeconds <= w.toSeconds),
    })),
  }));

  const enemyIds = new Set(enemies.map((e) => e.id));
  const ccOnHealer: ICCOnHealer[] = healer
    ? healer.auraEvents
        .filter(
          (e) =>
            e.logLine.event === LogEvent.SPELL_AURA_APPLIED &&
            ccSpellIds.has(e.spellId ?? '') &&
            enemyIds.has(e.srcUnitId),
        )
        .map((e) => {
          const atSeconds = (e.logLine.timestamp - combat.startTime) / 1000;
          return {
            atSeconds,
            spellId: e.spellId ?? '',
            spellName: spellEffectData[e.spellId ?? '']?.name ?? e.spellId ?? 'Unknown',
            inKillWindow: killWindows.some((w) => atSeconds >= w.fromSeconds && atSeconds <= w.toSeconds),
          };
        })
    : [];

  return {
    enemyComp: enemies.map((e) => specToString(e.spec)),
    isWin: combat.result === CombatResult.Win ? true : combat.result === CombatResult.Lose ? false : null,
    killWindows,
    enemyCDInventory: timeline.players,
    ccOnHealer,
    hasBurstWindows: killWindows.length > 0,
  };
}

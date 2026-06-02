// Structured match-analysis data for the AI Analysis view chrome (hero, timeline,
// supporting rail) and for deterministic evidence derivation. This computes the
// same feature data buildMatchContext feeds the prompt, but returns it as typed
// objects the React components render directly — no AI involvement.

import { AtomicArenaCombat, CombatUnitClass, ICombatUnit } from '@wowarenalogs/parser';

import { zoneMetadata } from '../../../data/zoneMetadata';
import { analyzePlayerCCAndTrinket, IPlayerCCTrinketSummary } from '../../../utils/ccTrinketAnalysis';
import {
  annotateDefensiveTimings,
  extractMajorCooldowns,
  IEnemyCDTimelineForTiming,
  IMajorCooldownInfo,
  isHealerSpec,
  specToString,
} from '../../../utils/cooldowns';
import { canOffensivePurge, IMissedPurgeWindow, reconstructDispelSummary } from '../../../utils/dispelAnalysis';
import { IAlignedBurstWindow, IEnemyPlayerTimeline, reconstructEnemyCDTimeline } from '../../../utils/enemyCDs';
import { CriticalMoment, identifyCriticalMoments } from './criticalMoments';

export type ClassKey =
  | 'deathknight'
  | 'demonhunter'
  | 'druid'
  | 'evoker'
  | 'hunter'
  | 'mage'
  | 'monk'
  | 'paladin'
  | 'priest'
  | 'rogue'
  | 'shaman'
  | 'warlock'
  | 'warrior'
  | 'unknown';

const CLASS_ENUM_TO_KEY: Record<CombatUnitClass, ClassKey> = {
  [CombatUnitClass.None]: 'unknown',
  [CombatUnitClass.Warrior]: 'warrior',
  [CombatUnitClass.Hunter]: 'hunter',
  [CombatUnitClass.Shaman]: 'shaman',
  [CombatUnitClass.Paladin]: 'paladin',
  [CombatUnitClass.Warlock]: 'warlock',
  [CombatUnitClass.Priest]: 'priest',
  [CombatUnitClass.Rogue]: 'rogue',
  [CombatUnitClass.Mage]: 'mage',
  [CombatUnitClass.Druid]: 'druid',
  [CombatUnitClass.DeathKnight]: 'deathknight',
  [CombatUnitClass.DemonHunter]: 'demonhunter',
  [CombatUnitClass.Monk]: 'monk',
  [CombatUnitClass.Evoker]: 'evoker',
};

export function classKeyOf(unit: ICombatUnit): ClassKey {
  return CLASS_ENUM_TO_KEY[unit.class] ?? 'unknown';
}

export interface RosterEntry {
  name: string;
  spec: string;
  cls: ClassKey;
  isOwner: boolean;
  /** Effective output in thousands/sec — HPS for healers, DPS otherwise. */
  rate: number;
  rateType: 'HPS' | 'DPS';
  /** Best same-role output rate in this match — the bar fills relative to it. */
  baseline: number;
}

export interface DeathEntry {
  spec: string;
  name: string;
  cls: ClassKey;
  atSeconds: number;
  side: 'friendly' | 'enemy';
}

export type MatchResult = 'Win' | 'Loss' | 'Unknown';

export interface MatchAnalysisData {
  owner: ICombatUnit;
  ownerSpec: string;
  ownerName: string;
  ownerIsHealer: boolean;
  ownerCanPurge: boolean;
  bracket: string;
  zone: string;
  result: MatchResult;
  durationSeconds: number;
  friends: RosterEntry[];
  enemies: RosterEntry[];
  friendlyDeaths: DeathEntry[];
  enemyDeaths: DeathEntry[];
  burstWindows: IAlignedBurstWindow[];
  ownerCDs: IMajorCooldownInfo[];
  enemyCDs: IEnemyPlayerTimeline[];
  missedPurges: IMissedPurgeWindow[];
  ownerTrinket?: IPlayerCCTrinketSummary;
  ccTrinketSummaries: IPlayerCCTrinketSummary[];
  criticalMoments: CriticalMoment[];
}

type CombatContext = AtomicArenaCombat;

function buildRoster(units: ICombatUnit[], ownerId: string, durationSec: number): RosterEntry[] {
  return units.map((p) => {
    const healer = isHealerSpec(p.spec);
    // Mirror CombatReportContext's totals so the hero rate matches the summary tab.
    const totalDamageOut = p.damageOut.reduce((sum, a) => sum + Math.abs(a.effectiveAmount), 0);
    const totalHealOut =
      p.healOut.reduce((sum, a) => {
        if (a.logLine.event === 'SPELL_PERIODIC_HEAL' || a.logLine.event === 'SPELL_HEAL') {
          return sum + (a.logLine.parameters[30] - a.logLine.parameters[32]);
        }
        return sum + Math.abs(a.effectiveAmount);
      }, 0) + p.absorbsOut.reduce((sum, a) => sum + Math.abs(a.effectiveAmount), 0);
    const total = healer ? totalHealOut : totalDamageOut;
    return {
      name: p.name,
      spec: specToString(p.spec),
      cls: classKeyOf(p),
      isOwner: p.id === ownerId,
      rate: (durationSec > 0 ? total / durationSec : 0) / 1000,
      rateType: healer ? 'HPS' : 'DPS',
      baseline: 0,
    };
  });
}

// Scale every bar against the strongest same-role output in the match, so HPS bars
// compare to the best healer and DPS bars to the best damage dealer.
function applyOutputBaselines(roster: RosterEntry[]): void {
  const maxOf = (role: 'HPS' | 'DPS') =>
    Math.max(0.001, ...roster.filter((r) => r.rateType === role).map((r) => r.rate));
  const maxHps = maxOf('HPS');
  const maxDps = maxOf('DPS');
  roster.forEach((r) => {
    r.baseline = r.rateType === 'HPS' ? maxHps : maxDps;
  });
}

function collectDeaths(units: ICombatUnit[], startTime: number, side: 'friendly' | 'enemy'): DeathEntry[] {
  return units
    .filter((p) => p.deathRecords.length > 0)
    .flatMap((p) =>
      p.deathRecords.map((d) => ({
        spec: specToString(p.spec),
        name: p.name,
        cls: classKeyOf(p),
        atSeconds: (d.timestamp - startTime) / 1000,
        side,
      })),
    )
    .sort((a, b) => a.atSeconds - b.atSeconds);
}

export function computeMatchAnalysisData(
  combat: CombatContext,
  friends: ICombatUnit[],
  enemies: ICombatUnit[],
): MatchAnalysisData | null {
  const owner = friends.find((p) => p.id === combat.playerId) ?? friends[0];
  if (!owner) return null;

  const durationSeconds = (combat.endTime - combat.startTime) / 1000;
  const ownerSpec = specToString(owner.spec);
  const ownerIsHealer = isHealerSpec(owner.spec);

  const combatAny = combat as unknown as Record<string, unknown>;
  const playerWon =
    typeof combatAny['winningTeamId'] === 'string' ? combatAny['winningTeamId'] === combat.playerTeamId : null;
  const result: MatchResult = playerWon === true ? 'Win' : playerWon === false ? 'Loss' : 'Unknown';

  const friendlyDeaths = collectDeaths(friends, combat.startTime, 'friendly');
  const enemyDeaths = collectDeaths(enemies, combat.startTime, 'enemy');

  const cooldowns = extractMajorCooldowns(owner, combat);
  const enemyCDTimeline = reconstructEnemyCDTimeline(enemies, combat, owner, friends);
  annotateDefensiveTimings(cooldowns, owner, combat, enemyCDTimeline as IEnemyCDTimelineForTiming);

  const dispelSummary = reconstructDispelSummary(friends, enemies, combat);
  const ccTrinketSummaries = friends.map((p) => analyzePlayerCCAndTrinket(p, enemies, combat));
  const ownerTrinket = ccTrinketSummaries.find((s) => s.playerName === owner.name);

  const { moments: criticalMoments } = identifyCriticalMoments(
    ownerIsHealer,
    cooldowns,
    enemyCDTimeline,
    friendlyDeaths,
    [],
    [],
    [],
    ccTrinketSummaries,
    0,
    durationSeconds,
    friends,
    combat.startTime,
  );

  const zone = zoneMetadata[combat.startInfo.zoneId]?.name ?? combat.startInfo.zoneId;

  const friendsRoster = buildRoster(friends, owner.id, durationSeconds);
  const enemiesRoster = buildRoster(enemies, owner.id, durationSeconds);
  applyOutputBaselines([...friendsRoster, ...enemiesRoster]);

  return {
    owner,
    ownerSpec,
    ownerName: owner.name,
    ownerIsHealer,
    ownerCanPurge: canOffensivePurge(owner),
    bracket: combat.startInfo.bracket,
    zone,
    result,
    durationSeconds,
    friends: friendsRoster,
    enemies: enemiesRoster,
    friendlyDeaths,
    enemyDeaths,
    burstWindows: enemyCDTimeline.alignedBurstWindows,
    ownerCDs: cooldowns,
    enemyCDs: enemyCDTimeline.players,
    missedPurges: dispelSummary.missedPurgeWindows,
    ownerTrinket,
    ccTrinketSummaries,
    criticalMoments,
  };
}

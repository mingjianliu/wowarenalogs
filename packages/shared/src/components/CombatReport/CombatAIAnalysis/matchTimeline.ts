import {
  CombatAbsorbAction,
  CombatUnitReaction,
  CombatUnitType,
  getUnitType,
  ICombatUnit,
  LogEvent,
} from '@wowarenalogs/parser';

import { getEnglishSpellName, spellEffectData } from '../../../data/spellEffectData';
import { ccSpellIds } from '../../../data/spellTags';
import { IPlayerCCTrinketSummary } from '../../../utils/ccTrinketAnalysis';
import { IFormInterval, ISpiritOfRedemptionInterval, IStasisEvent } from '../../../utils/combatStates';
import {
  fmtTime,
  getUnitHpAtTimestamp,
  IDamageBucket,
  IMajorCooldownInfo,
  specToBenchmarkKey,
  specToString,
} from '../../../utils/cooldowns';
import { buildDampeningEvents, getDampeningPercentage } from '../../../utils/dampening';
import {
  canDefensiveCleanse,
  IDispelEvent,
  IDispelSummary,
  wasRemovedByAllyDispel,
} from '../../../utils/dispelAnalysis';
import { DISPEL_FEATURE_FLAGS } from '../../../utils/dispelFeatureFlags';
import { extractAoeCCEvents, IOutgoingCCChain } from '../../../utils/drAnalysis';
import { IEnemyCDTimeline } from '../../../utils/enemyCDs';
import { IHealingGap } from '../../../utils/healingGaps';
import { getHpPercentAtTime } from '../../../utils/killWindowTargetSelection';
import { benchmarks } from '../../../utils/specBaselines';
import {
  buildResourceSnapshot,
  computeOnCDDisplayNames,
  computeReadyNames,
  ResourceSnapshotParams,
} from './resourceSnapshot';
import {
  buildKillSequenceBlock,
  buildMatchEndBlock,
  computeHealingInWindow,
  DMG_SPIKE_THRESHOLD,
  extractEnemyMajorBuffIntervals,
  extractOwnerCDBuffExpiry,
  getNpcIdFromGuid,
  getTopDamageSourcesInWindow,
  GROUNDING_TOTEM_NPC_ID,
  HEALER_CAST_SPELL_ID_TO_NAME,
  HEALING_AMPLIFIER_SPELL_IDS,
  HEALING_WINDOW_EARLY_CD_SECONDS,
  HEALING_WINDOW_MIN_HPS,
  isCriticalNonPlayerUnit,
  PASSIVE_SPELL_BLOCKLIST,
} from './timelineHelpers';

// ── buildMatchTimeline ─────────────────────────────────────────────────────

export interface BuildMatchTimelineParams {
  owner: ICombatUnit;
  ownerSpec: string;
  ownerCDs: IMajorCooldownInfo[];
  teammateCDs: Array<{ player: ICombatUnit; spec: string; cds: IMajorCooldownInfo[] }>;
  enemyCDTimeline: IEnemyCDTimeline;
  ccTrinketSummaries: IPlayerCCTrinketSummary[];
  dispelSummary: IDispelSummary;
  friendlyDeaths: Array<{ spec: string; name: string; atSeconds: number; note?: string }>;
  enemyDeaths: Array<{ spec: string; name: string; atSeconds: number }>;
  pressureWindows: IDamageBucket[];
  healingGaps: IHealingGap[];
  friends: ICombatUnit[];
  /**
   * Enemy player units. When provided, their HP is included in [STATE] ticks
   * alongside friendly HP, referenced by enemyPid() numeric ID.
   */
  enemies?: ICombatUnit[];
  matchStartMs: number;
  matchEndMs: number;
  isHealer: boolean;
  /**
   * Arena bracket string (e.g. '3v3', '2v2'). When provided, final dampening %
   * is included in the [MATCH END] block.
   */
  bracket?: string;
  /**
   * Friendly player name → numeric ID mapping from buildPlayerLoadout.
   * When provided, friendly names are compressed to short IDs in the timeline.
   */
  playerIdMap?: Map<string, number>;
  /**
   * Enemy player name → numeric ID mapping from buildPlayerLoadout.
   * Required alongside playerIdMap to avoid collision when a friendly and enemy
   * share the same display name.
   */
  enemyIdMap?: Map<string, number>;
  /**
   * AoE CC chains cast by friendly players on enemies. When provided,
   * [CC CAST] events are emitted for AoE spells (non-single-target spells).
   */
  outgoingCCChains?: IOutgoingCCChain[];
  /**
   * Override the resource snapshot function injected after each [YOU] [CD] and [TEAM] [CD] event.
   * Defaults to buildResourceSnapshot (text format). Pass buildJsonSituationSnapshot for JSON format.
   */
  resourceSnapshotFn?: (params: ResourceSnapshotParams) => string;
  allUnits?: ICombatUnit[];
  gateCcAvoidanceToDanger?: boolean;
  stasisEvents?: IStasisEvent[];
  shapeshiftIntervals?: Array<{ player: ICombatUnit; intervals: IFormInterval[] }>;
  spiritOfRedemptionIntervals?: Array<{ player: ICombatUnit; intervals: ISpiritOfRedemptionInterval[] }>;
  stateFormat?: 'inline' | 'summary' | 'verbose';
}

const HIGH_VALUE_PURGEABLE_BUFFS = new Set<string>([
  '10060', // Power Infusion
  '113858', // Dark Soul: Instability
  '113861', // Dark Soul: Misery
  '190319', // Combustion
  '12472', // Icy Veins
  '1022', // Blessing of Protection
  '1044', // Blessing of Freedom
  '198111', // Temporal Shield
  '110909', // Alter Time
]);

const DOT_SPELL_IDS = new Set<string>([
  '980',
  '172',
  '30108',
  '461531',
  '63106',
  '205179',
  '361695', // Warlock
  '589',
  '34914',
  '2944',
  '390978', // Priest
  '164812',
  '8921',
  '164815',
  '93402',
  '202347',
  '1079',
  '155722',
  '1822',
  '192090',
  '106830', // Druid
  '1943',
  '703',
  '2818',
  '122233',
  '121411', // Rogue
  '191587',
  '55078',
  '55095', // DK
  '188389', // Shaman
  '269747',
  '271788',
  '118253',
  '217200', // Hunter
  '12654', // Mage
  '115767',
  '84617', // Warrior
  '357209', // Evoker
]);

const DOT_SPELL_NAMES = new Set<string>([
  'agony',
  'corruption',
  'unstable affliction',
  'wither',
  'shadow word: pain',
  'vampiric touch',
  'devouring plague',
  'sunfire',
  'moonfire',
  'stellar flare',
  'rip',
  'rake',
  'thrash',
  'rupture',
  'garrote',
  'deadly poison',
  'crimson tempest',
  'virulent plague',
  'blood plague',
  'frost fever',
  'flame shock',
  'serpent sting',
  'ignite',
  'deep wounds',
  'fire breath',
]);

interface IDotInterval {
  spellId: string;
  spellName: string;
  startMs: number;
  endMs: number;
}

function extractPlayerDotIntervals(player: ICombatUnit, matchStartMs: number, matchEndMs: number): IDotInterval[] {
  const intervals: IDotInterval[] = [];
  const openDots = new Map<string, number>();

  const sortedEvents = [...(player.auraEvents ?? [])].sort((a, b) => a.logLine.timestamp - b.logLine.timestamp);

  for (const event of sortedEvents) {
    const ts = event.logLine.timestamp;
    if (ts > matchEndMs) continue;

    const spellId = event.spellId ?? '';
    const spellName = getEnglishSpellName(spellId, event.spellName);
    const spellNameLower = spellName.toLowerCase();

    const isDot = DOT_SPELL_IDS.has(spellId) || [...DOT_SPELL_NAMES].some((name) => spellNameLower.includes(name));
    if (!isDot) continue;

    const auraType = event.logLine.parameters[11];
    if (auraType === 'BUFF') continue;

    const stateKey = `${spellId}:${event.srcUnitId}`;
    if (event.logLine.event === LogEvent.SPELL_AURA_APPLIED) {
      if (!openDots.has(stateKey)) {
        openDots.set(stateKey, ts);
      }
    } else if (event.logLine.event === LogEvent.SPELL_AURA_REMOVED) {
      const startMs = openDots.get(stateKey);
      if (startMs !== undefined) {
        intervals.push({
          spellId,
          spellName,
          startMs,
          endMs: ts,
        });
        openDots.delete(stateKey);
      }
    }
  }

  for (const [stateKey, startMs] of openDots) {
    const spellId = stateKey.split(':')[0];
    const spellName = getEnglishSpellName(spellId, '');
    intervals.push({
      spellId,
      spellName,
      startMs,
      endMs: matchEndMs,
    });
  }

  return intervals;
}

export function buildMatchTimeline(params: BuildMatchTimelineParams): string {
  const {
    owner,
    ownerSpec,
    ownerCDs,
    teammateCDs,
    enemyCDTimeline,
    ccTrinketSummaries,
    dispelSummary,
    friendlyDeaths,
    enemyDeaths,
    pressureWindows,
    healingGaps,
    friends,
    enemies,
    allUnits,
    matchStartMs,
    matchEndMs,
    isHealer,
    playerIdMap,
    enemyIdMap,
    outgoingCCChains,
    resourceSnapshotFn,
    bracket,
    gateCcAvoidanceToDanger,
    stasisEvents = [],
    shapeshiftIntervals = [],
    spiritOfRedemptionIntervals = [],
    stateFormat = 'summary',
  } = params;

  const matchDurationS = (matchEndMs - matchStartMs) / 1000;
  const enemyBuffIntervals = extractEnemyMajorBuffIntervals(enemies ?? [], matchStartMs, matchEndMs);

  const criticalWindowSet = new Set<number>(); // which tick-seconds are in a critical window
  for (const d of friendlyDeaths) {
    // [T-10, T] window before death
    for (let t = Math.max(0, Math.ceil(d.atSeconds - 10)); t <= Math.floor(d.atSeconds); t++) {
      criticalWindowSet.add(t);
    }
  }
  for (const d of enemyDeaths) {
    for (let t = Math.max(0, Math.ceil(d.atSeconds - 10)); t <= Math.floor(d.atSeconds); t++) {
      criticalWindowSet.add(t);
    }
  }
  for (const pw of pressureWindows) {
    if (pw.totalDamage >= DMG_SPIKE_THRESHOLD) {
      // ±5s centred on the spike start — clamp both edges
      const from = Math.max(0, Math.ceil(pw.fromSeconds - 5));
      const to = Math.min(Math.floor(matchDurationS), Math.floor(pw.fromSeconds + 5));
      for (let t = from; t <= to; t++) criticalWindowSet.add(t);
    }
  }
  for (const summary of ccTrinketSummaries) {
    for (const cc of summary.ccInstances) {
      // [cc.atSeconds, cc.atSeconds + 10] look-ahead — clamp right edge
      const from = Math.max(0, Math.ceil(cc.atSeconds));
      const to = Math.min(Math.floor(matchDurationS), Math.floor(cc.atSeconds + 10));
      for (let t = from; t <= to; t++) criticalWindowSet.add(t);
    }
  }

  // F143: Pre-calculate Grounding Totem absorbs
  const groundingAbsorbs: Array<{ timeSeconds: number; spellName: string; totemOwnerId: string }> = [];
  if (allUnits) {
    for (const unit of allUnits) {
      const npcId = getNpcIdFromGuid(unit.id);
      if ((npcId === GROUNDING_TOTEM_NPC_ID || unit.name.toLowerCase().includes('grounding totem')) && unit.ownerId) {
        for (const absorb of unit.absorbsIn) {
          groundingAbsorbs.push({
            timeSeconds: (absorb.timestamp - matchStartMs) / 1000,
            spellName: getEnglishSpellName(absorb.spellId ?? '', absorb.spellName ?? 'Unknown'),
            totemOwnerId: unit.ownerId,
          });
        }
      }
    }
  }

  // F143: returns " [ABSORBED: x, y]" for a Grounding Totem cast by `totemOwnerId` near
  // `castSeconds`, or '' when nothing was absorbed. Matching by spell ID (204336) keeps this
  // locale-independent; the name check is a fallback for logs without a resolved cd.spellId.
  // The 3.5s window covers the totem's short lifetime.
  const GROUNDING_TOTEM_SPELL_ID = '204336';
  const groundingAbsorbNote = (
    spellId: string,
    spellName: string,
    totemOwnerId: string,
    castSeconds: number,
  ): string => {
    if (spellId !== GROUNDING_TOTEM_SPELL_ID && spellName !== 'Grounding Totem') return '';
    const absorbs = groundingAbsorbs
      .filter(
        (a) => a.totemOwnerId === totemOwnerId && a.timeSeconds >= castSeconds && a.timeSeconds <= castSeconds + 3.5,
      )
      .map((a) => a.spellName);
    if (absorbs.length === 0) return '';
    return ` [ABSORBED: ${Array.from(new Set(absorbs)).join(', ')}]`;
  };

  /**
   * Returns the short numeric ID for a friendly player name, or the raw name
   * if no mapping exists.  Enemy names must be resolved via enemyPid() to avoid
   * ID collision when a friendly and enemy share a display name.
   */
  function pid(name: string): string {
    if (!playerIdMap) return name;
    const id = playerIdMap.get(name);
    return id !== undefined ? String(id) : name;
  }

  /** Returns the short numeric ID for an *enemy* player name, falling back to name. */
  function enemyPid(name: string): string {
    if (!enemyIdMap) return name;
    const id = enemyIdMap.get(name);
    return id !== undefined ? String(id) : name;
  }

  /**
   * Resolves a cast's destUnitName to a display label for [YOU] [CAST] entries.
   * Returns "self" for self-casts, a numeric ID for known players, or the raw name.
   * Returns "" when destUnitName is empty (AoE spells with no specific log target).
   */
  function resolveTarget(destUnitName: string | null | undefined): string {
    if (!destUnitName || destUnitName === 'nil') return '';
    if (destUnitName === owner.name) return 'self';
    if (playerIdMap) {
      const id = playerIdMap.get(destUnitName);
      if (id !== undefined) return String(id);
    }
    if (enemyIdMap) {
      const id = enemyIdMap.get(destUnitName);
      if (id !== undefined) return String(id);
    }
    return destUnitName;
  }

  const snapshotFn = resourceSnapshotFn ?? buildResourceSnapshot;

  const matchEndSeconds = (matchEndMs - matchStartMs) / 1000;

  let prevReadyNamesState: string[] | null = null;
  let prevOnCDNamesState: string[] | null = null;
  let lastSnapshotTime = -100;
  // F138: force a full (non-delta) [RES] at least every 60s so the model does not
  // lose track of available CDs across long, late-dampening matches.
  let lastFullSnapshotTime = -100;
  const FULL_SNAPSHOT_REFRESH_SECONDS = 60;

  function resourceSnapshot(timeSeconds: number): string {
    if (timeSeconds - lastSnapshotTime < 2.0) {
      return '';
    }
    lastSnapshotTime = timeSeconds;

    // B34: compute attributed names (pid:SpellName for teammates)
    const teammateCDsWithLabel = teammateCDs.map(({ player, cds, spec }) => ({
      cds,
      spec,
      player,
      playerLabel: playerIdMap ? String(playerIdMap.get(player.name) ?? player.name) : player.name,
    }));
    const currentReadyNames = computeReadyNames(timeSeconds, ownerCDs, teammateCDsWithLabel);
    const currentOnCDNames = computeOnCDDisplayNames(timeSeconds, ownerCDs, teammateCDsWithLabel);
    const forceFullRefresh = timeSeconds - lastFullSnapshotTime >= FULL_SNAPSHOT_REFRESH_SECONDS;
    const prevReadyNames = forceFullRefresh ? undefined : (prevReadyNamesState ?? undefined);
    const prevOnCDNames = forceFullRefresh ? undefined : (prevOnCDNamesState ?? undefined);
    if (forceFullRefresh) lastFullSnapshotTime = timeSeconds;
    prevReadyNamesState = currentReadyNames;
    prevOnCDNamesState = currentOnCDNames;
    return snapshotFn({
      timeSeconds,
      ownerCDs,
      ownerName: owner.name,
      ownerSpec,
      isOwnerHealer: isHealer,
      teammateCDs,
      ccTrinketSummaries,
      enemyCDTimeline,
      playerIdMap,
      prevReadyNames,
      prevOnCDNames,
    });
  }

  const entries: Array<{ timeSeconds: number; lines: string[] }> = [];

  function addEntry(timeSeconds: number, ...lines: string[]) {
    // B103: skip events that fall past match end — they're irrelevant post-game
    // and would appear with timestamps after [MATCH END] confusing the timeline.
    if (timeSeconds > matchEndSeconds) return;

    entries.push({ timeSeconds, lines: lines.filter(Boolean) });
  }

  // ── Dampening Milestone Alerts (F149) ──────────────────────────────────────
  const allPlayers = friends.concat(enemies ?? []);
  const initialDampening = getDampeningPercentage(bracket ?? '3v3', allPlayers, matchStartMs);
  const emittedMilestones = new Set<number>();
  const milestones = [30, 50, 70, 90];

  for (const milestone of milestones) {
    if (initialDampening >= milestone) {
      addEntry(0, `${fmtTime(0)}  [DAMPENING ALERT: ${milestone}%]`);
      emittedMilestones.add(milestone);
    }
  }

  const events = buildDampeningEvents(allPlayers);
  const dampeningEvents = events.map((e) => ({
    timeSeconds: (e.timestamp - matchStartMs) / 1000,
    stacks: e.stacks,
  }));

  for (const milestone of milestones) {
    if (emittedMilestones.has(milestone)) continue;
    const firstCrossing = dampeningEvents.find((e) => e.stacks >= milestone);
    if (firstCrossing) {
      addEntry(firstCrossing.timeSeconds, `${fmtTime(firstCrossing.timeSeconds)}  [DAMPENING ALERT: ${milestone}%]`);
      emittedMilestones.add(milestone);
    }
  }

  // ── Rot Pressure Detection (F147) ──────────────────────────────────────────
  for (const player of allPlayers) {
    const dotIntervals = extractPlayerDotIntervals(player, matchStartMs, matchEndMs);
    let consecutiveRotSeconds = 0;
    let emittedForThisBlock = false;

    for (let t = 0; t <= Math.floor(matchDurationS); t++) {
      const tsMs = matchStartMs + t * 1000;
      const activeDots = dotIntervals.filter((i) => tsMs >= i.startMs && tsMs <= i.endMs);
      const dotCount = activeDots.length;

      const hp = getUnitHpAtTimestamp(player, tsMs, 5000);

      if (hp !== null && hp < 40 && dotCount >= 3) {
        consecutiveRotSeconds++;
        if (consecutiveRotSeconds >= 4 && !emittedForThisBlock) {
          const windowStartMs = tsMs - 4000;
          const windowEndMs = tsMs;

          let periodicDmg = 0;
          let totalDmg = 0;

          for (const dmg of player.damageIn) {
            if (dmg.timestamp >= windowStartMs && dmg.timestamp <= windowEndMs) {
              const amount = Math.abs(dmg.effectiveAmount || dmg.amount);
              totalDmg += amount;
              if (
                dmg.logLine.event === 'SPELL_PERIODIC_DAMAGE' ||
                dmg.logLine.event === 'SPELL_PERIODIC_DAMAGE_SUPPORT'
              ) {
                periodicDmg += amount;
              }
            }
          }

          if (totalDmg === 0 || periodicDmg / totalDmg >= 0.5) {
            addEntry(
              t,
              `${fmtTime(t)}  [ROT PRESSURE]   ${pid(player.name)} (${specToString(player.spec)}) at ${Math.round(hp)}% HP with ${dotCount} active DoTs`,
            );
            emittedForThisBlock = true;
          }
        }
      } else {
        consecutiveRotSeconds = 0;
        emittedForThisBlock = false;
      }
    }
  }

  // ── [OFFENSIVE WINDOW] synthesized headers ─────────────────────────────────

  for (const burst of enemyCDTimeline.alignedBurstWindows) {
    const overlappingSpike = pressureWindows.find(
      (pw) =>
        pw.totalDamage >= DMG_SPIKE_THRESHOLD &&
        pw.fromSeconds >= burst.fromSeconds - 5 &&
        pw.fromSeconds <= burst.toSeconds + 5,
    );
    if (!overlappingSpike) continue;
    const dmgM = (overlappingSpike.totalDamage / 1_000_000).toFixed(2);
    const cdNames = burst.activeCDs.map((c) => c.spellName).join(' + ');
    addEntry(
      burst.fromSeconds,
      `${fmtTime(burst.fromSeconds)}  [OFFENSIVE WINDOW]   ${fmtTime(burst.fromSeconds)}–${fmtTime(burst.toSeconds)} | ${dmgM}M on ${pid(overlappingSpike.targetName)} (${overlappingSpike.targetSpec}) | CDs: ${cdNames}`,
    );
  }

  // ── [DEATH] events ────────────────────────────────────────────────────────

  const unitsByName = new Map(friends.map((u) => [u.name, u]));

  for (const death of friendlyDeaths) {
    const dyingUnit = unitsByName.get(death.name);
    let unusedDefensives = '';
    let trinketAvailable = false;
    if (dyingUnit) {
      const summary = ccTrinketSummaries.find((s) => s.playerName === death.name);
      if (summary && (summary.trinketType === 'Gladiator' || summary.trinketType === 'Adaptation')) {
        const cooldownSec = summary.trinketCooldownSeconds;
        const lastUse = summary.trinketUseTimes.filter((t) => t <= death.atSeconds).sort((a, b) => b - a)[0];
        trinketAvailable = lastUse === undefined || death.atSeconds - lastUse >= cooldownSec;
      }

      // F145: Teammate Defensive Persistence Check — find big buttons that were available at death
      const allPlayerCDs = [
        ...ownerCDs.filter(() => owner.name === death.name),
        ...teammateCDs.filter((tc) => tc.player.name === death.name).flatMap((tc) => tc.cds),
      ];
      const readyAtDeath = allPlayerCDs
        .filter((cd) => cd.tag === 'Defensive' || cd.tag === 'External')
        .filter((cd) =>
          cd.availableWindows.some((w) => death.atSeconds >= w.fromSeconds && death.atSeconds <= w.toSeconds),
        )
        .map((cd) => cd.spellName);

      if (readyAtDeath.length > 0) {
        unusedDefensives = ` (Unused: ${readyAtDeath.join(', ')})`;
      }
    }

    const trinketPart = trinketAvailable ? ' (PvP Trinket available)' : '';
    const notePart = death.note ? ` [${death.note}]` : '';
    const deathLines: string[] = [
      `${fmtTime(death.atSeconds)}  [DEATH]  ${pid(death.name)} (${death.spec} — friendly)${unusedDefensives}${trinketPart}${notePart}`,
    ];
    if (dyingUnit) {
      // HP trajectory
      const checkpoints = [15, 10, 5, 3];
      const trajectory: string[] = [];
      for (const secondsBefore of checkpoints) {
        const pct = getHpPercentAtTime(dyingUnit, death.atSeconds - secondsBefore, matchStartMs);
        if (pct !== null) trajectory.push(`${Math.round(pct)}% at T-${secondsBefore}s`);
      }
      if (trajectory.length > 0) {
        deathLines.push(`               HP: ${trajectory.join(' → ')} → dead`);
      }

      // Top damage sources in final 10s — uses shared helper to avoid duplication
      const deathMs = matchStartMs + death.atSeconds * 1000;
      const topSources = getTopDamageSourcesInWindow(dyingUnit, deathMs, 10_000);
      if (topSources.length > 0) {
        deathLines.push(`               Top damage in final 10s: ${topSources.join(', ')}`);
      }
    }

    addEntry(death.atSeconds, ...deathLines);
  }

  for (const death of enemyDeaths) {
    addEntry(
      death.atSeconds,
      `${fmtTime(death.atSeconds)}  [DEATH]  ${enemyPid(death.name)} (${death.spec} — enemy)`,
      `${fmtTime(death.atSeconds)}  [ROSTER]  enemy ${enemyPid(death.name)} removed (dead)`,
    );
  }

  // ── [UNIT DESTROYED] Non-Player Deaths ────────────────────────────────────

  if (allUnits) {
    for (const unit of allUnits) {
      if (unit.deathRecords && unit.deathRecords.length > 0 && isCriticalNonPlayerUnit(unit)) {
        const reactionStr =
          unit.reaction === CombatUnitReaction.Friendly
            ? 'Friendly'
            : unit.reaction === CombatUnitReaction.Hostile
              ? 'Enemy'
              : 'Unknown';
        for (const deathRecord of unit.deathRecords) {
          const atSeconds = (deathRecord.timestamp - matchStartMs) / 1000;
          const durationS = (matchEndMs - matchStartMs) / 1000;
          if (atSeconds > durationS) continue; // Match End cleanup suppression

          const deathLines: string[] = [`${fmtTime(atSeconds)}  [UNIT DESTROYED]   ${unit.name} (${reactionStr})`];

          const topSources = getTopDamageSourcesInWindow(unit, deathRecord.timestamp, 10_000, 2);
          if (topSources.length > 0) {
            deathLines[0] += ` killed by: ${topSources.join(', ')}`;
          }

          addEntry(atSeconds, ...deathLines);
        }
      }
    }
  }

  // ── [YOU] [CD] events ───────────────────────────────────────────────────────

  // F114 (Variant C): precompute which amplifier-spell casts get a [HEALING] block.
  // Per spell, emit only the first eligible cast and the worst subsequent eligible
  // cast (score = overhealPct * 1000 - maxBucketHps; higher = worse). Casts
  // suppressed by the early-low-activity gate are never eligible.
  const healingEmissionTimes = new Map<string, Set<number>>();
  for (const cd of ownerCDs) {
    if (!HEALING_AMPLIFIER_SPELL_IDS.has(cd.spellId)) continue;
    const duration = spellEffectData[cd.spellId]?.durationSeconds;
    if (!duration) continue;
    const eligible: { timeSeconds: number; score: number }[] = [];
    for (const cast of cd.casts) {
      const fromMs = matchStartMs + cast.timeSeconds * 1000;
      const toMs = fromMs + duration * 1000;
      const healStats = computeHealingInWindow(owner.healOut, fromMs, toMs);
      const maxBucketHps = healStats ? Math.max(...healStats.buckets.map((b) => b.hps)) : 0;
      const isEarlyLowActivity =
        cast.timeSeconds < HEALING_WINDOW_EARLY_CD_SECONDS && maxBucketHps < HEALING_WINDOW_MIN_HPS;
      if (isEarlyLowActivity) continue;
      const score = (healStats?.overhealPct ?? 0) * 1000 - maxBucketHps;
      eligible.push({ timeSeconds: cast.timeSeconds, score });
    }
    if (eligible.length === 0) continue;
    const emit = new Set<number>([eligible[0].timeSeconds]);
    if (eligible.length > 1) {
      let worstIdx = 1;
      for (let i = 2; i < eligible.length; i++) {
        if (eligible[i].score > eligible[worstIdx].score) worstIdx = i;
      }
      emit.add(eligible[worstIdx].timeSeconds);
    }
    healingEmissionTimes.set(cd.spellId, emit);
  }

  for (const cd of ownerCDs) {
    for (const cast of cd.casts) {
      const targetPart =
        cast.targetName !== undefined
          ? ` → ${pid(cast.targetName)}${cast.targetHpPct !== undefined ? ` (${cast.targetHpPct}% HP)` : ''}`
          : '';

      const extraLines: string[] = [resourceSnapshot(cast.timeSeconds)];

      if (HEALING_AMPLIFIER_SPELL_IDS.has(cd.spellId) && healingEmissionTimes.get(cd.spellId)?.has(cast.timeSeconds)) {
        const duration = spellEffectData[cd.spellId]?.durationSeconds;
        if (duration) {
          const fromMs = matchStartMs + cast.timeSeconds * 1000;
          const toMs = fromMs + duration * 1000;
          const healStats = computeHealingInWindow(owner.healOut, fromMs, toMs);
          if (healStats) {
            const bucketParts = healStats.buckets.map(
              (b) => `${b.fromSeconds}–${b.toSeconds}s: ${(b.hps / 1000).toFixed(1)}k HPS`,
            );
            extraLines.push(`      [HEALING]    ${bucketParts.join(' | ')} | Overheal: ${healStats.overhealPct}%`);
          } else {
            extraLines.push(`      [HEALING]    No healing logged during this window`);
          }
        }
      }

      const prefix = ccSpellIds.has(cd.spellId) ? '[YOU] [CC]' : '[YOU] [CD]';
      const groundingNote = groundingAbsorbNote(cd.spellId, cd.spellName, owner.id, cast.timeSeconds);

      addEntry(
        cast.timeSeconds,
        `${fmtTime(cast.timeSeconds)}  ${prefix}   ${cd.spellName}${targetPart}${groundingNote}`,
        ...extraLines,
      );
    }
  }

  // ── [BUFF FADED] events (F70, B31: renamed from [CD EXPIRED]) ──────────────

  const cdExpiryEvents = extractOwnerCDBuffExpiry(ownerCDs, owner.id, friends, matchStartMs);
  for (const expiry of cdExpiryEvents) {
    const estimatedNote = expiry.isEstimated ? ' (estimated)' : '';
    addEntry(
      expiry.expiresAtSeconds,
      `${fmtTime(expiry.expiresAtSeconds)}  [BUFF FADED]   ${expiry.spellName}${estimatedNote}`,
    );
  }

  // ── [YOU] [CAST] healer gap-filler (F61) ────────────────────────────────────

  if (isHealer) {
    const trackedCastsBySpellId = new Map<string, Set<number>>();
    for (const cd of ownerCDs) {
      trackedCastsBySpellId.set(
        cd.spellId,
        new Set(cd.casts.map((c) => matchStartMs + Math.round(c.timeSeconds * 1000))),
      );
    }
    const trinketUseTimesMs = new Set(
      ccTrinketSummaries.flatMap((s) => s.trinketUseTimes.map((t) => Math.round(matchStartMs + t * 1000))),
    );

    // F68/B32: flat list of CC events targeting the owner only (not teammates).
    // B32 fix: restrict disambiguation annotations to CCs that hit the caster,
    // not CCs that hit teammates at a similar timestamp.
    const ownerCCMsTimestamps: number[] = ccTrinketSummaries
      .filter((s) => s.playerName === owner.name)
      .flatMap((s) => s.ccInstances.map((cc) => Math.round(matchStartMs + cc.atSeconds * 1000)));

    const seenCasts = new Set<string>();

    let activeFold: {
      displayName: string;
      targetLabel: string;
      startTimeSeconds: number;
      count: number;
    } | null = null;

    const flushFold = () => {
      if (!activeFold) return;
      const { displayName, targetLabel, startTimeSeconds, count } = activeFold;
      const targetPart = targetLabel ? ` → ${targetLabel}` : '';
      const countPart = count > 1 ? ` (x${count})` : '';
      addEntry(
        startTimeSeconds,
        `${fmtTime(startTimeSeconds)}  [YOU] [CAST]   ${displayName}${countPart}${targetPart}`,
      );
      activeFold = null;
    };

    for (const e of owner.spellCastEvents ?? []) {
      if (e.logLine.event !== LogEvent.SPELL_CAST_SUCCESS) continue;
      if (!e.spellId) continue;
      const englishName = getEnglishSpellName(e.spellId, e.spellName);
      if (e.spellName && PASSIVE_SPELL_BLOCKLIST.has(e.spellName)) continue;

      const displayName = HEALER_CAST_SPELL_ID_TO_NAME[e.spellId] ?? englishName;
      if (!displayName) continue;
      const tsMs = e.logLine.timestamp;
      const trackedSet = trackedCastsBySpellId.get(e.spellId);
      if (trackedSet && (trackedSet.has(tsMs) || trackedSet.has(tsMs - 1000) || trackedSet.has(tsMs + 1000))) continue;
      if (trinketUseTimesMs.has(tsMs) || trinketUseTimesMs.has(tsMs - 1000) || trinketUseTimesMs.has(tsMs + 1000))
        continue;
      const timeSeconds = (tsMs - matchStartMs) / 1000;

      let stasisAnnotation = '';
      const activeStasis = stasisEvents.find((s) => timeSeconds >= s.startSeconds && timeSeconds < s.releaseSeconds);
      if (activeStasis && activeStasis.spells.includes(displayName)) {
        if (stateFormat === 'summary') {
          continue; // Suppress buffered heals in summary mode
        } else if (stateFormat === 'inline') {
          stasisAnnotation = ' [STASIS STORED]';
        }
      }

      // F68/F89/B32: find nearest CC *on the owner* within 1s — annotate ordering
      // so Claude knows the cast completed before or after incoming CC.
      // B32: only match CCs targeting the log owner, not teammates.
      const CC_PROXIMITY_MS = 1000;
      const nearestCC = ownerCCMsTimestamps
        .filter((ccMs) => Math.abs(ccMs - tsMs) <= CC_PROXIMITY_MS)
        .sort((a, b) => Math.abs(a - tsMs) - Math.abs(b - tsMs))[0];
      let orderNote = '';
      if (nearestCC !== undefined) {
        if (tsMs < nearestCC) {
          orderNote = ' [completed before CC landed]';
        } else if (tsMs > nearestCC) {
          orderNote = ' [succeeded after CC arrived — within 1s in log]';
        } else {
          orderNote = ' [same server tick as CC — cast succeeded per log]';
        }
      }

      const targetLabel = resolveTarget(e.destUnitName);

      // B15: Dedup same-second, same-target, same-name casts (duplicate spell IDs)
      const second = Math.floor(timeSeconds);
      const dedupKey = `${displayName}|${targetLabel}|${second}`;
      if (seenCasts.has(dedupKey)) continue;
      seenCasts.add(dedupKey);

      const targetPart = targetLabel ? ` → ${targetLabel}` : '';
      const destType = getUnitType(e.destUnitFlags ?? 0);
      let totemNote = '';
      if (destType === CombatUnitType.Guardian || destType === CombatUnitType.Pet) {
        // B44: distinguish Grounding Totem absorption (wasted cast) from other totem/pet targets
        totemNote =
          (e.destUnitName?.toLowerCase().includes('grounding totem') ?? false)
            ? ' [absorbed: Grounding Totem]'
            : ' [totem/pet]';
      }

      // F95: Offensive CC casts should carry a CC annotation or use an [YOU] [CC] prefix.
      if (ccSpellIds.has(e.spellId)) {
        flushFold();
        addEntry(
          timeSeconds,
          `${fmtTime(timeSeconds)}  [YOU] [CC]   ${displayName}${targetPart}${totemNote}${orderNote}`,
          resourceSnapshot(timeSeconds),
        );
        continue;
      }

      // B38: promote major-CD spells (CD ≥ 30s) to [YOU] [CD] format when extractMajorCooldowns
      // missed them (e.g. missing talent data). This keeps Avenging Crusader etc. from appearing
      // as filler casts when they are significant cooldown activations.
      const effectData = spellEffectData[e.spellId];
      const cdSeconds = effectData?.cooldownSeconds ?? effectData?.charges?.chargeCooldownSeconds ?? 0;
      if (cdSeconds >= 30) {
        flushFold();
        addEntry(
          timeSeconds,
          `${fmtTime(timeSeconds)}  [YOU] [CD]   ${displayName}${targetPart}${totemNote}${stasisAnnotation}`,
          resourceSnapshot(timeSeconds),
        );
        continue;
      }

      // F151 Repetitive Cast Folding:
      // Simple casts outside critical windows are foldable.
      const isFoldable =
        totemNote === '' &&
        orderNote === '' &&
        stasisAnnotation === '' &&
        !criticalWindowSet.has(Math.floor(timeSeconds));

      if (isFoldable) {
        if (activeFold && activeFold.displayName === displayName && activeFold.targetLabel === targetLabel) {
          activeFold.count++;
        } else {
          flushFold();
          activeFold = {
            displayName,
            targetLabel,
            startTimeSeconds: timeSeconds,
            count: 1,
          };
        }
      } else {
        flushFold();
        addEntry(
          timeSeconds,
          `${fmtTime(timeSeconds)}  [YOU] [CAST]   ${displayName}${targetPart}${totemNote}${orderNote}${stasisAnnotation}`,
        );
      }
    }

    // Flush any remaining active folds at loop end
    flushFold();
  }

  // ── [TEAM] [CD] events ────────────────────────────────────────────────────

  for (const { player, spec, cds } of teammateCDs) {
    for (const cd of cds) {
      for (const cast of cd.casts) {
        const prefix = ccSpellIds.has(cd.spellId) ? '[TEAM] [CC]' : '[TEAM] [CD]';
        const groundingNote = groundingAbsorbNote(cd.spellId, cd.spellName, player.id, cast.timeSeconds);

        addEntry(
          cast.timeSeconds,
          `${fmtTime(cast.timeSeconds)}  ${prefix}   ${pid(player.name)} (${spec}): ${cd.spellName}${groundingNote}`,
          resourceSnapshot(cast.timeSeconds),
        );
      }
    }
  }

  // ── [CC CAST] events — AoE CC cast by friendly players on enemies ──────────

  if (outgoingCCChains && outgoingCCChains.length > 0) {
    for (const event of extractAoeCCEvents(outgoingCCChains)) {
      const casterLabel = pid(event.casterName);
      const targetLabels = event.targets.map((t) => enemyPid(t.name)).join(', ');
      const countNote = event.targets.length > 1 ? ` [${event.targets.length} enemies]` : '';
      addEntry(
        event.atSeconds,
        `${fmtTime(event.atSeconds)}  [CC CAST]   ${event.spellName} (by ${casterLabel}) → ${targetLabels}${countNote}`,
      );
    }
  }

  // ── [ENEMY BUFF] / [ENEMY BUFF END] events (F67b) ─────────────────────────

  for (const [enemyName, intervals] of enemyBuffIntervals) {
    for (const interval of intervals) {
      const purgeNote = interval.purgeable ? ' (purgeable)' : '';
      addEntry(
        interval.startSeconds,
        `${fmtTime(interval.startSeconds)}  [ENEMY BUFF]   ${enemyPid(enemyName)}: ${interval.spellName}${purgeNote}`,
      );
      addEntry(
        interval.endSeconds,
        `${fmtTime(interval.endSeconds)}  [ENEMY BUFF END]   ${enemyPid(enemyName)}: ${interval.spellName}`,
      );
    }
  }

  // ── [ENEMY CD] events ──────────────────────────────────────────────────────
  // B107: annotate each cast with a per-spell sequence index (e.g. `Bestial Wrath [2/4]`)
  // so the model can't collapse short-interval repeats of the same CD into one window.

  for (const player of enemyCDTimeline.players) {
    const totalBySpell = new Map<string, number>();
    for (const cd of player.offensiveCDs) {
      totalBySpell.set(cd.spellName, (totalBySpell.get(cd.spellName) ?? 0) + 1);
    }
    const seqBySpell = new Map<string, number>();
    for (const cd of player.offensiveCDs) {
      const total = totalBySpell.get(cd.spellName) ?? 1;
      const seq = (seqBySpell.get(cd.spellName) ?? 0) + 1;
      seqBySpell.set(cd.spellName, seq);
      const seqAnnotation = total > 1 ? ` [${seq}/${total}]` : '';
      addEntry(
        cd.castTimeSeconds,
        `${fmtTime(cd.castTimeSeconds)}  [ENEMY CD]   ${enemyPid(player.playerName)} (${player.specName}): ${cd.spellName}${seqAnnotation}`,
      );
    }
  }

  // ── [TRINKET] and [CC ON TEAM] events ──────────────────────────────────────

  const isDangerousTime = (t: number) => {
    // 1. Teammate death within next 10s
    for (const d of friendlyDeaths) {
      if (t >= d.atSeconds - 10 && t <= d.atSeconds) return true;
    }
    // 2. High pressure window
    for (const pw of pressureWindows) {
      if (pw.totalDamage >= DMG_SPIKE_THRESHOLD && t >= pw.fromSeconds - 5 && t <= pw.toSeconds + 5) {
        return true;
      }
    }
    // 3. Enemy burst window
    for (const burst of enemyCDTimeline.alignedBurstWindows) {
      if (t >= burst.fromSeconds - 5 && t <= burst.toSeconds + 5) return true;
    }
    return false;
  };

  for (const summary of ccTrinketSummaries) {
    for (const t of summary.trinketUseTimes) {
      addEntry(t, `${fmtTime(t)}  [TRINKET]   ${pid(summary.playerName)} used PvP trinket`);
    }

    for (const cc of summary.ccInstances) {
      if (cc.durationSeconds === 0) continue;
      let trinketNote = '';
      if (cc.trinketState === 'used') {
        trinketNote = ' | trinket: used';
      } else if (cc.trinketState === 'on_cooldown') {
        const cdLeft = cc.trinketCDSecondsLeft !== undefined ? `${cc.trinketCDSecondsLeft}s left` : 'on CD';
        trinketNote = ` | trinket: ON CD (${cdLeft})`;
      } else if (cc.trinketState === 'available_unused') {
        trinketNote = ' | trinket: available';
      }

      // F148: Cleanse Success Verification — check if this CC was removed by a friendly dispel
      const isCleansed = wasRemovedByAllyDispel(
        dispelSummary.allyCleanse,
        cc.spellId,
        summary.playerName,
        cc.atSeconds + cc.durationSeconds,
      );
      const cleansedNote = isCleansed ? ' [CLEANSED]' : '';

      const baseDuration = spellEffectData[cc.spellId]?.durationSeconds;
      const baseDurationStr =
        DISPEL_FEATURE_FLAGS.F124_ENHANCED_CC_ANNOTATIONS && baseDuration !== undefined
          ? ` (base ${baseDuration}s)`
          : '';
      const drStr =
        DISPEL_FEATURE_FLAGS.F124_ENHANCED_CC_ANNOTATIONS && cc.drInfo
          ? ` [DR: ${cc.drInfo.category} ${cc.drInfo.level}]`
          : '';
      const isBacklash = cc.spellId === '34914' || cc.spellId === '196363';
      const backlashStr =
        DISPEL_FEATURE_FLAGS.F124_ENHANCED_CC_ANNOTATIONS && isBacklash ? ' [DISPEL BACKLASH CC]' : '';

      // passive_trinket → player has no active trinket, no annotation
      addEntry(
        cc.atSeconds,
        `${fmtTime(cc.atSeconds)}  [CC ON TEAM]   ${pid(summary.playerName)} ← ${cc.spellName} (${pid(cc.sourceName)}) | ${cc.durationSeconds.toFixed(0)}s${baseDurationStr}${drStr}${backlashStr}${trinketNote}${cleansedNote}`,
      );
    }

    if (summary.ccAvoidedInstances) {
      for (const avoided of summary.ccAvoidedInstances) {
        if (gateCcAvoidanceToDanger && !isDangerousTime(avoided.atSeconds)) {
          continue;
        }
        addEntry(
          avoided.atSeconds,
          `${fmtTime(avoided.atSeconds)}  [CC AVOIDED?]   ${pid(summary.playerName)} likely mitigated ${avoided.spellName} via ${avoided.avoidanceSpellName} (by ${enemyPid(avoided.sourceName)})`,
        );
      }
    }
  }

  // ── [UNCLEANSED DEBUFF] and [CLEANSE] events ──────────────────────────────────

  for (const miss of dispelSummary.missedCleanseWindows) {
    // B16: only emit if the log owner's spec can actually remove this debuff type
    if (!canDefensiveCleanse(owner, miss.dispelType)) continue;
    const dmgK = Math.round(miss.postCcDamage / 1000);
    const spellName = getEnglishSpellName(miss.spellId, miss.spellName);
    addEntry(
      miss.timeSeconds,
      `${fmtTime(miss.timeSeconds)}  [UNCLEANSED DEBUFF]   ${spellName} on ${pid(miss.targetName)} | ${miss.durationSeconds.toFixed(0)}s | ${dmgK}k taken during | dispel: ${miss.dispelType}`,
    );
  }

  if (DISPEL_FEATURE_FLAGS.F152_MISSED_PURGES_TIMELINE) {
    for (const miss of dispelSummary.missedPurgeWindows) {
      if (HIGH_VALUE_PURGEABLE_BUFFS.has(miss.spellId)) {
        addEntry(
          miss.timeSeconds,
          `${fmtTime(miss.timeSeconds)}  [MISSED PURGE OPPORTUNITY]   ${miss.spellName} active on ${enemyPid(miss.enemyName)} (unpurged for ${Math.round(miss.durationSeconds)}s)`,
        );
      }
    }
  }

  // B14: Consolidate same-second same-source cleanses (e.g. Mass Dispel) into one line.
  {
    const cleanseGroups = new Map<string, IDispelEvent[]>();
    for (const cleanse of dispelSummary.allyCleanse) {
      const key = `${Math.round(cleanse.timeSeconds)}|${cleanse.sourceName}`;
      const group = cleanseGroups.get(key) ?? [];
      group.push(cleanse);
      cleanseGroups.set(key, group);
    }
    for (const group of cleanseGroups.values()) {
      const first = group[0];
      const petTag = group.some((c) => c.isPetDispel) ? ' (pet)' : '';
      const fatalCleanse = DISPEL_FEATURE_FLAGS.F18_FATAL_DISPEL ? group.find((c) => c.wasFatal) : undefined;
      const fatalTag = fatalCleanse
        ? ` [FATAL DISPEL: ${pid(fatalCleanse.fatalUnitName ?? fatalCleanse.sourceName)}]`
        : '';
      const removedSpellName = getEnglishSpellName(first.removedSpellId, first.removedSpellName);
      if (group.length === 1) {
        addEntry(
          first.timeSeconds,
          `${fmtTime(first.timeSeconds)}  [CLEANSE]   ${pid(first.sourceName)} dispelled ${removedSpellName} off ${pid(first.targetName)}${petTag}${fatalTag}`,
        );
      } else {
        const effects = group
          .map((c) => `${getEnglishSpellName(c.removedSpellId, c.removedSpellName)} off ${pid(c.targetName)}`)
          .join(', ');
        addEntry(
          first.timeSeconds,
          `${fmtTime(first.timeSeconds)}  [CLEANSE]   ${pid(first.sourceName)} dispelled ${group.length} effects: ${effects}${petTag}${fatalTag}`,
        );
      }
    }
  }

  // ── [DMG SPIKE] events ─────────────────────────────────────────────────────

  for (const pw of pressureWindows) {
    if (pw.totalDamage < DMG_SPIKE_THRESHOLD) continue;
    const dmgM = (pw.totalDamage / 1_000_000).toFixed(2);
    const windowSec = Math.round(pw.toSeconds - pw.fromSeconds);

    const targetUnit = friends.find((f) => f.name === pw.targetName);
    const hpFrom = targetUnit ? getUnitHpAtTimestamp(targetUnit, matchStartMs + pw.fromSeconds * 1000, 2000) : null;
    const hpTo = targetUnit ? getUnitHpAtTimestamp(targetUnit, matchStartMs + pw.toSeconds * 1000, 2000) : null;
    const hpStr = hpFrom !== null && hpTo !== null ? ` (${hpFrom}% -> ${hpTo}% HP)` : '';

    const benchmarkKey = targetUnit ? specToBenchmarkKey(targetUnit.spec) : '';
    let b = benchmarks.bySpec[benchmarkKey];

    // Fallback logic for missing specs: try generic spec for same class (e.g. Shadow -> Holy Priest baseline)
    if (!b && targetUnit) {
      const className = benchmarkKey.split(' ')[0];
      const fallbackKey = Object.keys(benchmarks.bySpec).find((k) => k.startsWith(className));
      if (fallbackKey) b = benchmarks.bySpec[fallbackKey];
    }

    const fromMs = matchStartMs + pw.fromSeconds * 1000;
    const toMs = matchStartMs + pw.toSeconds * 1000;
    const windowEvents =
      targetUnit?.damageIn.filter((d) => d.logLine.timestamp >= fromMs && d.logLine.timestamp <= toMs) ?? [];
    const totalAbsorbed = windowEvents.reduce((sum, d) => {
      if (d.logLine.event === LogEvent.SPELL_ABSORBED) {
        return sum + ((d as unknown as CombatAbsorbAction).absorbedAmount ?? 0);
      }
      return sum;
    }, 0);

    const absorbStr = totalAbsorbed > 100_000 ? ` (${(totalAbsorbed / 1_000_000).toFixed(2)}M absorbed)` : '';

    addEntry(
      pw.fromSeconds,
      `${fmtTime(pw.fromSeconds)}  [DMG SPIKE]   ${pid(pw.targetName)} (${pw.targetSpec}): ${dmgM}M in ${windowSec}s${hpStr}${absorbStr}`,
    );
  }

  // ── [HEALER INACTIVITY] events (healer only) ────────────────────────────────────

  if (isHealer) {
    for (const gap of healingGaps) {
      addEntry(
        gap.fromSeconds,
        `${fmtTime(gap.fromSeconds)}  [INACTIVITY]   ${pid(owner.name)} inactive ${gap.durationSeconds.toFixed(1)}s (${gap.freeCastSeconds.toFixed(1)}s free) while ${pid(gap.mostDamagedName)} under pressure`,
      );
    }
  }

  // Compile key moment seconds where major events occur
  const keyMomentSeconds = new Set<number>();
  for (const d of friendlyDeaths) keyMomentSeconds.add(Math.floor(d.atSeconds));
  for (const d of enemyDeaths) keyMomentSeconds.add(Math.floor(d.atSeconds));
  for (const cd of ownerCDs) {
    for (const cast of cd.casts) keyMomentSeconds.add(Math.floor(cast.timeSeconds));
  }
  for (const { cds } of teammateCDs) {
    for (const cd of cds) {
      for (const cast of cd.casts) keyMomentSeconds.add(Math.floor(cast.timeSeconds));
    }
  }
  for (const player of enemyCDTimeline.players) {
    for (const cd of player.offensiveCDs) keyMomentSeconds.add(Math.floor(cd.castTimeSeconds));
  }
  for (const summary of ccTrinketSummaries) {
    for (const cc of summary.ccInstances) {
      if (cc.durationSeconds > 0) keyMomentSeconds.add(Math.floor(cc.atSeconds));
    }
    for (const t of summary.trinketUseTimes) keyMomentSeconds.add(Math.floor(t));
  }
  for (const pw of pressureWindows) {
    if (pw.totalDamage >= DMG_SPIKE_THRESHOLD) keyMomentSeconds.add(Math.floor(pw.fromSeconds));
  }
  for (const miss of dispelSummary.missedCleanseWindows) {
    if (canDefensiveCleanse(owner, miss.dispelType)) keyMomentSeconds.add(Math.floor(miss.timeSeconds));
  }
  for (const cleanse of dispelSummary.allyCleanse) {
    keyMomentSeconds.add(Math.floor(cleanse.timeSeconds));
  }
  if (outgoingCCChains && outgoingCCChains.length > 0) {
    for (const event of extractAoeCCEvents(outgoingCCChains)) {
      keyMomentSeconds.add(Math.floor(event.atSeconds));
    }
  }

  // Emit HP ticks — use a narrower sample window inside critical windows so adjacent
  // 1-second ticks cannot both claim the same underlying reading (which would give a
  // misleadingly flat HP line during a fast drop).
  const HP_SAMPLE_WINDOW_CRITICAL_MS = 1_500; // ±1.5s for 1s dense ticks
  const HP_SAMPLE_WINDOW_BASELINE_MS = 3_000; // ±3s for 3s baseline ticks

  // B106: when a numeric ID map is present, sort HP tokens by player ID so the model
  // can align HP readings with class labels listed elsewhere in player-ID order.
  // Owner is always assigned ID 1 in buildPlayerLoadout, so sorting by ID also satisfies
  // the "owner first" property; fall back to owner-first ordering when no map is provided.
  const friendlyOrdered: ICombatUnit[] = playerIdMap
    ? [...friends].sort((a, b) => {
        const aId = playerIdMap.get(a.name);
        const bId = playerIdMap.get(b.name);
        if (aId === undefined && bId === undefined) return 0;
        if (aId === undefined) return 1;
        if (bId === undefined) return -1;
        return aId - bId;
      })
    : [...friends.filter((u) => u.name === owner.name), ...friends.filter((u) => u.name !== owner.name)];

  const friendlyHpUnits: Array<{ unit: ICombatUnit; label: (name: string) => string }> = friendlyOrdered.map((u) => ({
    unit: u,
    label: (name: string) => pid(name),
  }));

  const enemiesOrdered: ICombatUnit[] = enemyIdMap
    ? [...(enemies ?? [])].sort((a, b) => {
        const aId = enemyIdMap.get(a.name);
        const bId = enemyIdMap.get(b.name);
        if (aId === undefined && bId === undefined) return 0;
        if (aId === undefined) return 1;
        if (bId === undefined) return -1;
        return aId - bId;
      })
    : [...(enemies ?? [])];

  const enemyHpUnits: Array<{ unit: ICombatUnit; label: (name: string) => string }> = enemiesOrdered.map((u) => ({
    unit: u,
    label: (name: string) => enemyPid(name),
  }));

  // B42: Build death-time lookup so [STATE] ticks show :dead instead of silently omitting dead players.
  const friendlyDeathAtByName = new Map<string, number>(friendlyDeaths.map((d) => [d.name, d.atSeconds]));
  const enemyDeathAtByName = new Map<string, number>(enemyDeaths.map((d) => [d.name, d.atSeconds]));

  const lastEmittedHp = new Map<string, number>();
  const lastEmittedStatus = new Map<string, string>(); // 'alive' | 'dead'

  for (let t = 0; t <= Math.floor(matchDurationS); t++) {
    const tsMs = matchStartMs + t * 1000;
    const sampleWindowMs = criticalWindowSet.has(t) ? HP_SAMPLE_WINDOW_CRITICAL_MS : HP_SAMPLE_WINDOW_BASELINE_MS;

    const friendlyParts: string[] = [];
    const currentFriendlies = friendlyHpUnits.map(({ unit, label }) => {
      const deathAt = friendlyDeathAtByName.get(unit.name);
      let isDead = deathAt !== undefined && t >= Math.floor(deathAt);

      const isGhost = spiritOfRedemptionIntervals.some(
        (i) => i.player.name === unit.name && i.intervals.some((int) => t >= int.startSeconds && t <= int.endSeconds),
      );

      const pct = getUnitHpAtTimestamp(unit, tsMs, sampleWindowMs);
      const clamped = pct !== null ? Math.min(pct, 100) : null;

      if (isGhost) {
        friendlyParts.push(`${label(unit.name)}:ghost`);
        isDead = false;
      } else if (isDead) {
        friendlyParts.push(`${label(unit.name)}:dead`);
      } else if (clamped !== null) {
        friendlyParts.push(`${label(unit.name)}:${clamped}`);
      }
      return { name: unit.name, isDead, hp: clamped };
    });

    const enemyParts: string[] = [];
    const currentEnemies =
      criticalWindowSet.has(t) && enemyHpUnits.length > 0
        ? enemyHpUnits.map(({ unit, label }) => {
            const deathAt = enemyDeathAtByName.get(unit.name);
            let isDead = deathAt !== undefined && t >= Math.floor(deathAt);

            const isGhost = spiritOfRedemptionIntervals.some(
              (i) =>
                i.player.name === unit.name && i.intervals.some((int) => t >= int.startSeconds && t <= int.endSeconds),
            );

            const pct = getUnitHpAtTimestamp(unit, tsMs, sampleWindowMs);
            const clamped = pct !== null ? Math.min(pct, 100) : null;

            if (isGhost) {
              enemyParts.push(`${label(unit.name)}:ghost`);
              isDead = false;
            } else if (isDead) {
              enemyParts.push(`${label(unit.name)}:dead`);
            } else if (clamped !== null) {
              enemyParts.push(`${label(unit.name)}:${clamped}`);
            }
            return { name: unit.name, isDead, hp: clamped };
          })
        : [];

    if (friendlyParts.length === 0 && enemyParts.length === 0) continue;

    // B15: Option 2 (Event-Gating) - strictly emit ONLY inside critical windows, or if a player died.
    const isInCritical = criticalWindowSet.has(t);
    const someoneDied = currentFriendlies.some((p) => p.isDead) || currentEnemies.some((p) => p.isDead);

    const wasSomeoneDead = Array.from(lastEmittedStatus.values()).some((status) => status === 'dead');
    const isFirstDeathTick = someoneDied && !wasSomeoneDead;

    // Only emit if inside critical window, or death. No time anchors!
    if (!isInCritical && !isFirstDeathTick) continue;

    // Decide if it's a key moment or delta change
    let shouldEmit = false;
    if (t === 0) {
      shouldEmit = true; // Always emit first tick
    } else if (keyMomentSeconds.has(t)) {
      shouldEmit = true; // Key moment snapshot
    } else {
      // Check if any player's HP changed by at least 10% or status changed since last emitted tick
      for (const p of [...currentFriendlies, ...currentEnemies]) {
        const lastHp = lastEmittedHp.get(p.name);
        const lastStatus = lastEmittedStatus.get(p.name) ?? 'alive';
        const currentStatus = p.isDead ? 'dead' : 'alive';

        if (currentStatus !== lastStatus) {
          shouldEmit = true;
          break;
        }

        if (p.hp !== null) {
          if (lastHp === undefined || Math.abs(p.hp - lastHp) >= 10) {
            shouldEmit = true;
            break;
          }
        }
      }
    }

    if (!shouldEmit) continue;

    // Update last emitted state
    for (const p of [...currentFriendlies, ...currentEnemies]) {
      if (p.hp !== null) lastEmittedHp.set(p.name, p.hp);
      lastEmittedStatus.set(p.name, p.isDead ? 'dead' : 'alive');
    }

    let stateParts: string;
    if (friendlyParts.length > 0 && enemyParts.length > 0) {
      stateParts = `friends ${friendlyParts.join(' ')} / enemies ${enemyParts.join(' ')}`;
    } else if (friendlyParts.length > 0) {
      stateParts = `friends ${friendlyParts.join(' ')}`;
    } else {
      stateParts = `enemies ${enemyParts.join(' ')}`;
    }

    addEntry(t, `${fmtTime(t)}  [STATE]   ${stateParts}`);
  }

  // 9. Add Form shifts (Verbose mode only)
  if (stateFormat === 'verbose') {
    for (const { player, intervals } of shapeshiftIntervals) {
      const isOwner = player.id === owner.id;
      const prefix = isOwner ? '[YOU]' : friends.some((f) => f.id === player.id) ? '[TEAM]' : '[ENEMY]';
      const pLabel = isOwner ? '' : ` ${pid(player.name)}`;

      for (const interval of intervals) {
        addEntry(
          interval.startSeconds,
          `${fmtTime(interval.startSeconds)}  ${prefix} [SHIFT]${pLabel} entered ${interval.form} Form`,
        );
      }
    }

    for (const { player, intervals } of spiritOfRedemptionIntervals) {
      const isOwner = player.id === owner.id;
      const prefix = isOwner ? '[YOU]' : friends.some((f) => f.id === player.id) ? '[TEAM]' : '[ENEMY]';
      const pLabel = isOwner ? '' : ` ${pid(player.name)}`;

      for (const interval of intervals) {
        addEntry(
          interval.startSeconds,
          `${fmtTime(interval.startSeconds)}  ${prefix} [SPIRIT OF REDEMPTION]${pLabel} entered Spirit of Redemption (Ghost Form)`,
        );
        addEntry(
          interval.endSeconds,
          `${fmtTime(interval.endSeconds)}  ${prefix} [SPIRIT OF REDEMPTION]${pLabel} form expired`,
        );
      }
    }
  }

  // 10. Process Stasis Events
  for (const stasis of stasisEvents) {
    if (stateFormat === 'summary') {
      // Prefer resolved spell names; fall back to the stored-spell count so an
      // unidentified release is never shown as an empty "→ " (which reads as a
      // wasted Stasis). Only skip releases that genuinely stored nothing.
      const contents =
        stasis.spells.length > 0
          ? stasis.spells.join(', ')
          : stasis.storedCount > 0
            ? `${stasis.storedCount} spell(s) stored (contents not identified)`
            : '';
      if (contents) {
        addEntry(stasis.releaseSeconds, `${fmtTime(stasis.releaseSeconds)}  [YOU] [STASIS RELEASE] → ${contents}`);
      }
    }
  }

  // ── Sort and format ───────────────────────────────────────────────────────

  entries.sort((a, b) => a.timeSeconds - b.timeSeconds);

  const summaryLines: string[] = [];
  if (stateFormat === 'summary' && shapeshiftIntervals.length > 0) {
    summaryLines.push('## NOTABLE STATES');
    for (const { player, intervals } of shapeshiftIntervals) {
      const bearTime = intervals
        .filter((i) => i.form === 'Bear')
        .reduce((acc, i) => acc + (i.endSeconds - i.startSeconds), 0);
      const catTime = intervals
        .filter((i) => i.form === 'Cat')
        .reduce((acc, i) => acc + (i.endSeconds - i.startSeconds), 0);
      const pLabel = player.id === owner.id ? 'YOU' : pid(player.name);

      if (bearTime > 0) summaryLines.push(`- ${pLabel} spent ${Math.round(bearTime)}s in Bear Form.`);
      if (catTime > 0) summaryLines.push(`- ${pLabel} spent ${Math.round(catTime)}s in Cat Form.`);
    }
    if (summaryLines.length > 1) {
      summaryLines.push('');
    } else {
      summaryLines.length = 0; // Empty if no valid times found
    }
  }

  const outputLines: string[] = [
    ...summaryLines,
    'MATCH TIMELINE',
    '  Units: M = Million damage (1,000,000), k = Thousand damage (1,000)',
    '',
    `[PERSPECTIVE: Log Owner - ${ownerSpec}]`,
    `(You are the ${ownerSpec} in this match. Your actions are marked with [YOU].)`,
    '',
  ];
  for (const entry of entries) {
    outputLines.push(...entry.lines);
  }

  outputLines.push(
    ...buildKillSequenceBlock({
      matchStartMs,
      matchEndSeconds,
      owner,
      friends,
      enemies: enemies ?? [],
      ownerCDs,
      teammateCDs,
      enemyCDTimeline,
      ccTrinketSummaries,
      friendlyDeaths,
      enemyDeaths,
      isHealer,
      pid,
    }),
  );

  outputLines.push(
    ...buildMatchEndBlock({
      matchStartMs,
      matchEndMs,
      matchEndSeconds,
      bracket,
      owner,
      friends,
      enemies: enemies ?? [],
      friendlyDeaths,
      enemyDeaths,
      pid,
      enemyPid,
    }),
  );

  return outputLines.join('\n');
}

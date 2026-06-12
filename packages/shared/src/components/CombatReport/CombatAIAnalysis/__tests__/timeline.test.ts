/* eslint-disable @typescript-eslint/no-explicit-any */
import { CombatUnitReaction, CombatUnitSpec, CombatUnitType, ICombatUnit, LogEvent } from '@wowarenalogs/parser';

import {
  makeAdvancedAction,
  makeAuraEvent,
  makeHealEvent,
  makeSpellCastEvent,
  makeUnit,
} from '../../../../utils/__tests__/testHelpers';
import { ICCInstance, IPlayerCCTrinketSummary } from '../../../../utils/ccTrinketAnalysis';
import { IDamageBucket, IMajorCooldownInfo } from '../../../../utils/cooldowns';
import { IDispelSummary } from '../../../../utils/dispelAnalysis';
import { DISPEL_FEATURE_FLAGS } from '../../../../utils/dispelFeatureFlags';
import { IOutgoingCCChain } from '../../../../utils/drAnalysis';
import { IAlignedBurstWindow, IEnemyCDTimeline } from '../../../../utils/enemyCDs';
import { IHealingGap } from '../../../../utils/healingGaps';
import { isCriticalNonPlayerUnit } from '../timelineHelpers';
import {
  buildJsonSituationSnapshot,
  buildMatchTimeline,
  BuildMatchTimelineParams,
  buildPlayerLoadout,
  buildResourceSnapshot,
  computeHealingInWindow,
  computeReadyNames,
  extractEnemyMajorBuffIntervals,
  extractOwnerCDBuffExpiry,
  HEALING_AMPLIFIER_SPELL_IDS,
  HEALING_WINDOW_EARLY_CD_SECONDS,
  HEALING_WINDOW_MIN_HPS,
} from '../utils';

beforeAll(() => {
  DISPEL_FEATURE_FLAGS.F18_FATAL_DISPEL = true;
  DISPEL_FEATURE_FLAGS.F124_ENHANCED_CC_ANNOTATIONS = true;
  DISPEL_FEATURE_FLAGS.F131_F132_CLEANSE_COOLDOWNS = true;
  DISPEL_FEATURE_FLAGS.F142_OFFENSIVE_DISPEL_SUMMARY = true;
  DISPEL_FEATURE_FLAGS.F152_MISSED_PURGES_TIMELINE = true;
});

// ── Factories ─────────────────────────────────────────────────────────────────

function makeOwner(name: string, spec: CombatUnitSpec = CombatUnitSpec.None): ICombatUnit {
  return { name, spec, advancedActions: [] } as unknown as ICombatUnit;
}

function makeCD(spellName: string, cooldownSeconds: number, neverUsed = false): IMajorCooldownInfo {
  return {
    spellId: '1',
    spellName,
    tag: 'Defensive',
    cooldownSeconds,
    maxChargesDetected: 1,
    casts: [],
    availableWindows: [],
    neverUsed,
  };
}

function makeEnemyTimeline(players: IEnemyCDTimeline['players'] = []): IEnemyCDTimeline {
  return { alignedBurstWindows: [], players };
}

// ── extractEnemyMajorBuffIntervals ────────────────────────────────────────────

describe('extractEnemyMajorBuffIntervals — pre-cast seeding', () => {
  it('detects a buff applied before matchStartMs with no prior removal', () => {
    const matchStartMs = 1_000_000;
    const matchEndMs = matchStartMs + 60_000;

    // PI was applied 5s before match start, never removed before start
    const enemy = makeUnit('enemy-1', {
      name: 'Dzinked',
      reaction: CombatUnitReaction.Hostile,
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '10060', matchStartMs - 5_000, 'healer-1', 'enemy-1'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '10060', matchStartMs + 15_000, 'healer-1', 'enemy-1'),
      ],
    });

    const result = extractEnemyMajorBuffIntervals([enemy], matchStartMs, matchEndMs);
    const intervals = result.get('Dzinked') ?? [];
    expect(intervals.length).toBeGreaterThan(0);
    expect(intervals[0].startSeconds).toBe(0);
    expect(intervals[0].endSeconds).toBeCloseTo(15, 1);
    expect(intervals[0].spellName).toBe('Power Infusion');
  });

  it('does NOT seed a buff that was applied and removed before matchStartMs', () => {
    const matchStartMs = 1_000_000;
    const matchEndMs = matchStartMs + 60_000;

    const enemy = makeUnit('enemy-1', {
      name: 'Dzinked',
      reaction: CombatUnitReaction.Hostile,
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '10060', matchStartMs - 10_000, 'healer-1', 'enemy-1'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '10060', matchStartMs - 2_000, 'healer-1', 'enemy-1'),
      ],
    });

    const result = extractEnemyMajorBuffIntervals([enemy], matchStartMs, matchEndMs);
    expect(result.get('Dzinked')).toBeUndefined();
  });

  it('seeds a buff that was applied, removed, then re-applied before matchStartMs', () => {
    const matchStartMs = 1_000_000;
    const matchEndMs = matchStartMs + 60_000;

    const enemy = makeUnit('enemy-1', {
      name: 'Dzinked',
      reaction: CombatUnitReaction.Hostile,
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '10060', matchStartMs - 20_000, 'healer-1', 'enemy-1'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '10060', matchStartMs - 15_000, 'healer-1', 'enemy-1'),
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '10060', matchStartMs - 5_000, 'healer-1', 'enemy-1'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '10060', matchStartMs + 10_000, 'healer-1', 'enemy-1'),
      ],
    });

    const result = extractEnemyMajorBuffIntervals([enemy], matchStartMs, matchEndMs);
    const intervals = result.get('Dzinked') ?? [];
    expect(intervals.length).toBeGreaterThan(0);
    expect(intervals[0].startSeconds).toBe(0);
    expect(intervals[0].endSeconds).toBeCloseTo(10, 1);
  });
});

// ── buildPlayerLoadout ────────────────────────────────────────────────────────

describe('buildPlayerLoadout', () => {
  it('labels the log owner with spec and (log owner)', () => {
    const { text } = buildPlayerLoadout(
      makeOwner('Feramonk'),
      'Mistweaver Monk',
      [makeCD('Life Cocoon', 120)],
      [],
      makeEnemyTimeline(),
    );
    expect(text).toContain('<unit id="1" name="Feramonk" spec="Mistweaver Monk" role="log owner">');
    expect(text).toContain('<cooldowns>Life Cocoon [120s]</cooldowns>');
  });

  it('includes teammates without the (log owner) label', () => {
    const { text } = buildPlayerLoadout(
      makeOwner('Feramonk'),
      'Mistweaver Monk',
      [],
      [
        {
          player: makeOwner('Simplesauce'),
          spec: 'Unholy Death Knight',
          cds: [makeCD('Anti-Magic Shell', 60)],
        },
      ],
      makeEnemyTimeline(),
    );
    expect(text).toContain('<unit id="2" name="Simplesauce" spec="Unholy Death Knight" role="teammate">');
    expect(text).toContain('<cooldowns>Anti-Magic Shell [60s]</cooldowns>');
  });

  it('includes enemies from CD timeline with (enemy) label', () => {
    const { text } = buildPlayerLoadout(
      makeOwner('Feramonk'),
      'Mistweaver Monk',
      [],
      [],
      makeEnemyTimeline([
        {
          playerName: 'Dzinked',
          specName: 'Holy Paladin',
          offensiveCDs: [
            {
              spellId: '31884',
              spellName: 'Avenging Crusader',
              castTimeSeconds: 30,
              cooldownSeconds: 120,
              availableAgainAtSeconds: 150,
              buffEndSeconds: 50,
            },
          ],
        },
      ]),
    );
    expect(text).toContain('<unit id="2" name="Dzinked" spec="Holy Paladin" role="enemy">');
    expect(text).toContain('<cooldowns>Avenging Crusader [120s]</cooldowns>');
  });

  it('deduplicates enemy CDs that were cast multiple times', () => {
    const { text } = buildPlayerLoadout(
      makeOwner('Feramonk'),
      'Mistweaver Monk',
      [],
      [],
      makeEnemyTimeline([
        {
          playerName: 'Ruminator',
          specName: 'Beast Mastery Hunter',
          offensiveCDs: [
            {
              spellId: '19574',
              spellName: 'Bestial Wrath',
              castTimeSeconds: 15,
              cooldownSeconds: 90,
              availableAgainAtSeconds: 105,
              buffEndSeconds: 25,
            },
            {
              spellId: '19574',
              spellName: 'Bestial Wrath',
              castTimeSeconds: 60,
              cooldownSeconds: 90,
              availableAgainAtSeconds: 150,
              buffEndSeconds: 70,
            },
          ],
        },
      ]),
    );
    // Should appear once, not twice
    const count = (text.match(/Bestial Wrath/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('does not annotate any CD as NEVER USED', () => {
    const neverUsedCD = makeCD('Paralysis', 45, true);
    const { text } = buildPlayerLoadout(
      makeOwner('Feramonk'),
      'Mistweaver Monk',
      [neverUsedCD],
      [],
      makeEnemyTimeline(),
    );
    expect(text).not.toMatch(/NEVER.USED/i);
    expect(text).toContain('Paralysis [45s]');
  });

  it('shows "none tracked" when owner has no CDs', () => {
    const { text } = buildPlayerLoadout(makeOwner('Feramonk'), 'Mistweaver Monk', [], [], makeEnemyTimeline());
    expect(text).toContain('none tracked');
  });

  it('includes enemies with no tracked CDs in loadout so their IDs can be resolved in timeline', () => {
    const { text, enemyIdMap } = buildPlayerLoadout(
      makeOwner('Feramonk'),
      'Mistweaver Monk',
      [],
      [],
      makeEnemyTimeline([{ playerName: 'Ghost', specName: 'Arms Warrior', offensiveCDs: [] }]),
    );
    // Player must appear so Claude can resolve their numeric ID from [HP] ticks and [YOU] [CAST] targets
    expect(text).toContain('Ghost');
    expect(text).toContain('none tracked');
    expect(enemyIdMap.get('Ghost')).toBeDefined();
  });

  it('assigns sequential numeric IDs starting at 1 for owner, then teammates, then enemies', () => {
    const { text, playerIdMap, enemyIdMap } = buildPlayerLoadout(
      makeOwner('Feramonk'),
      'Mistweaver Monk',
      [],
      [{ player: makeOwner('Simplesauce'), spec: 'Unholy Death Knight', cds: [] }],
      makeEnemyTimeline([
        {
          playerName: 'Dzinked',
          specName: 'Holy Paladin',
          offensiveCDs: [
            {
              spellId: '31884',
              spellName: 'Avenging Crusader',
              castTimeSeconds: 30,
              cooldownSeconds: 120,
              availableAgainAtSeconds: 150,
              buffEndSeconds: 50,
            },
          ],
        },
      ]),
    );
    expect(playerIdMap.get('Feramonk')).toBe(1);
    expect(playerIdMap.get('Simplesauce')).toBe(2);
    expect(enemyIdMap.get('Dzinked')).toBe(3);
    expect(text).toContain('<unit id="1" name="Feramonk"');
    expect(text).toContain('<unit id="2" name="Simplesauce"');
    expect(text).toContain('<unit id="3" name="Dzinked"');
  });
});

// ── Timeline factory helpers ──────────────────────────────────────────────────

function makeEmptyDispelSummary(): IDispelSummary {
  return {
    allyCleanse: [],
    ourPurges: [],
    hostilePurges: [],
    missedCleanseWindows: [],
    ccEfficiency: [],
    missedPurgeWindows: [],
  };
}

function makeEmptyCCTrinketSummary(playerName: string): IPlayerCCTrinketSummary {
  return {
    playerName,
    playerSpec: 'Mistweaver Monk',
    trinketType: 'Gladiator',
    trinketCooldownSeconds: 90,
    ccInstances: [],
    trinketUseTimes: [],
    missedTrinketWindows: [],
    rootInstances: [],
    disarmInstances: [],
    interruptInstances: [],
    ccAvoidedInstances: [],
  };
}

function makeBaseParams(overrides: Partial<BuildMatchTimelineParams> = {}): BuildMatchTimelineParams {
  const matchStartMs = overrides.matchStartMs ?? 0;
  return {
    owner: makeOwner('Feramonk'),
    ownerSpec: 'Holy Paladin',
    ownerCDs: [],
    teammateCDs: [],
    enemyCDTimeline: makeEnemyTimeline(),
    ccTrinketSummaries: [],
    dispelSummary: makeEmptyDispelSummary(),
    friendlyDeaths: [],
    enemyDeaths: [],
    pressureWindows: [] as IDamageBucket[],
    healingGaps: [] as IHealingGap[],
    friends: [],
    enemies: [],
    matchStartMs,
    matchEndMs: matchStartMs + 600_000, // 10 minutes default to avoid filtering events
    isHealer: true,
    ...overrides,
  };
}

// ── buildMatchTimeline — [DEATH] events ────────────────────────────────────────

describe('buildMatchTimeline — [DEATH] events', () => {
  it('emits a [DEATH] line for a friendly death', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        friendlyDeaths: [{ spec: 'Unholy Death Knight', name: 'Simplesauce', atSeconds: 118 }],
      }),
    );
    expect(result).toContain('[DEATH]');
    expect(result).toContain('Simplesauce (Unholy Death Knight — friendly)');
  });

  it('B17: includes note in [DEATH] line when note is provided (Spirit of Redemption)', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        friendlyDeaths: [
          {
            spec: 'Holy Priest',
            name: 'Healer',
            atSeconds: 45,
            note: 'Spirit of Redemption — healer casting as ghost',
          },
        ],
      }),
    );
    expect(result).toContain('[DEATH]');
    expect(result).toContain('[Spirit of Redemption — healer casting as ghost]');
  });

  it('emits a [DEATH] line for an enemy death', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        enemyDeaths: [{ spec: 'Affliction Warlock', name: 'Natjkis', atSeconds: 88 }],
      }),
    );
    expect(result).toContain('[DEATH]');
    expect(result).toContain('Natjkis (Affliction Warlock — enemy)');
  });

  it('F145: flags unused major defensives on a teammate death', () => {
    const teammate = { ...makeOwner('Simplesauce'), damageIn: [], auraEvents: [] } as any;
    const loh: IMajorCooldownInfo = {
      spellId: '633',
      spellName: 'Lay on Hands',
      tag: 'Defensive',
      cooldownSeconds: 600,
      maxChargesDetected: 1,
      casts: [],
      availableWindows: [{ fromSeconds: 0, toSeconds: 600, durationSeconds: 600 }],
      neverUsed: true,
    };
    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [makeOwner('Feramonk'), teammate],
        friendlyDeaths: [{ spec: 'Unholy Death Knight', name: 'Simplesauce', atSeconds: 118 }],
        teammateCDs: [{ player: teammate, spec: 'Unholy Death Knight', cds: [loh] }],
      }),
    );
    expect(result).toContain('[DEATH]');
    expect(result).toContain('Simplesauce');
    expect(result).toContain('(Unused: Lay on Hands)');
  });

  it('includes HP trajectory when advanced data is present', () => {
    const matchStartMs = 1_000_000;
    const deathAtSeconds = 118;
    const deathMs = matchStartMs + deathAtSeconds * 1000;

    const unit = makeUnit('player-1', {
      name: 'Simplesauce',
      advancedActions: [
        makeAdvancedAction(deathMs - 15_000, 0, 0, 500_000, 400_000), // 80% at T-15s
        makeAdvancedAction(deathMs - 5_000, 0, 0, 500_000, 200_000), // 40% at T-5s
      ],
    });

    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [unit],
        friendlyDeaths: [{ spec: 'Unholy Death Knight', name: 'Simplesauce', atSeconds: deathAtSeconds }],
        matchStartMs,
      }),
    );
    expect(result).toContain('HP:');
    expect(result).toContain('80%');
    expect(result).toContain('40%');
    expect(result).toContain('→ dead');
  });

  it('includes top damage sources in final 10s for friendly deaths', () => {
    const matchStartMs = 1_000_000;
    const deathAtSeconds = 118;
    const deathMs = matchStartMs + deathAtSeconds * 1000;

    const unit = makeUnit('player-1', {
      name: 'Simplesauce',
      damageIn: [
        {
          logLine: { timestamp: deathMs - 5_000 },
          effectiveAmount: -80_000,
          srcUnitName: 'Natjkis',
          srcUnitFlags: 0x00000040, // hostile player
          spellName: 'Unstable Affliction',
        } as any,
        {
          logLine: { timestamp: deathMs - 3_000 },
          effectiveAmount: -40_000,
          srcUnitName: 'Natjkis',
          srcUnitFlags: 0x00000040, // hostile player
          spellName: 'Dark Harvest',
        } as any,
      ],
    });

    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [unit],
        friendlyDeaths: [{ spec: 'Unholy Death Knight', name: 'Simplesauce', atSeconds: deathAtSeconds }],
        matchStartMs,
      }),
    );
    expect(result).toContain('Top damage in final 10s');
    expect(result).toContain('Unstable Affliction');
    expect(result).toContain('80k');
  });

  it('B20: excludes friendly-sourced damage from top damage sources (e.g. Time Dilation)', () => {
    const matchStartMs = 1_000_000;
    const deathAtSeconds = 60;
    const deathMs = matchStartMs + deathAtSeconds * 1000;

    const unit = makeUnit('player-1', {
      name: 'Simplesauce',
      damageIn: [
        {
          logLine: { timestamp: deathMs - 2_000 },
          effectiveAmount: -119_000,
          srcUnitName: 'Healer',
          srcUnitFlags: 0x00000010, // friendly player
          spellName: 'Time Dilation',
        } as any,
        {
          logLine: { timestamp: deathMs - 1_000 },
          effectiveAmount: -50_000,
          srcUnitName: 'Natjkis',
          srcUnitFlags: 0x00000040, // hostile player
          spellName: 'Shadow Bolt',
        } as any,
      ],
    });

    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [unit],
        friendlyDeaths: [{ spec: 'Unholy Death Knight', name: 'Simplesauce', atSeconds: deathAtSeconds }],
        matchStartMs,
      }),
    );
    expect(result).not.toContain('Time Dilation');
    expect(result).toContain('Shadow Bolt');
  });

  it('B24: replaces pet/guardian srcUnitName with [pet] in death attribution', () => {
    const matchStartMs = 1_000_000;
    const deathAtSeconds = 60;
    const deathMs = matchStartMs + deathAtSeconds * 1000;

    const unit = makeUnit('player-1', {
      name: 'Simplesauce',
      damageIn: [
        {
          logLine: { timestamp: deathMs - 2_000 },
          effectiveAmount: -87_000,
          srcUnitName: 'Ребан', // Cyrillic pet name (Bloodshed ghoul)
          srcUnitFlags: 0x00001040, // pet + hostile flags
          spellName: 'Bloodshed',
        } as any,
      ],
    });

    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [unit],
        friendlyDeaths: [{ spec: 'Unholy Death Knight', name: 'Simplesauce', atSeconds: deathAtSeconds }],
        matchStartMs,
      }),
    );
    expect(result).not.toContain('Ребан');
    expect(result).toContain('[pet]');
    expect(result).toContain('Bloodshed');
  });

  it('outputs MATCH TIMELINE header', () => {
    const result = buildMatchTimeline(makeBaseParams());
    expect(result).toContain('MATCH TIMELINE');
  });

  it('emits a [ROSTER] removed line after each enemy death', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        enemyDeaths: [{ spec: 'Affliction Warlock', name: 'Natjkis', atSeconds: 88 }],
      }),
    );
    expect(result).toContain('[ROSTER]');
    expect(result).toContain('enemy Natjkis removed (dead)');
  });

  it('[ROSTER] line appears immediately after the corresponding [DEATH] line', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        enemyDeaths: [{ spec: 'Affliction Warlock', name: 'Natjkis', atSeconds: 88 }],
      }),
    );
    const lines = result.split('\n');
    const deathIdx = lines.findIndex((l) => l.includes('[DEATH]') && l.includes('Natjkis'));
    const rosterIdx = lines.findIndex((l) => l.includes('[ROSTER]') && l.includes('Natjkis removed (dead)'));
    expect(deathIdx).toBeGreaterThanOrEqual(0);
    expect(rosterIdx).toBe(deathIdx + 1);
  });

  it('[ROSTER] uses numeric enemy ID when enemyIdMap is provided', () => {
    const enemyIdMap = new Map<string, number>([['Natjkis', 5]]);
    const result = buildMatchTimeline(
      makeBaseParams({
        enemyDeaths: [{ spec: 'Affliction Warlock', name: 'Natjkis', atSeconds: 88 }],
        enemyIdMap,
      }),
    );
    expect(result).toContain('enemy 5 removed (dead)');
    expect(result).not.toContain('enemy Natjkis removed (dead)');
  });
});

describe('buildMatchTimeline — CD events', () => {
  it('emits [YOU] [CD] for each cast', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        ownerCDs: [
          {
            spellId: '1',
            spellName: 'Life Cocoon',
            tag: 'Defensive',
            cooldownSeconds: 120,
            maxChargesDetected: 1,
            casts: [{ timeSeconds: 27 }],
            availableWindows: [],
            neverUsed: false,
          },
        ],
      }),
    );
    expect(result).toContain('[YOU] [CD]');
    expect(result).toContain('Life Cocoon');
    expect(result).toContain('0:27');
  });

  it('includes target name and HP when available on [YOU] [CD]', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        ownerCDs: [
          {
            spellId: '1',
            spellName: 'Life Cocoon',
            tag: 'Defensive',
            cooldownSeconds: 120,
            maxChargesDetected: 1,
            casts: [{ timeSeconds: 27, targetName: 'Gardianmini', targetHpPct: 27 }],
            availableWindows: [],
            neverUsed: false,
          },
        ],
      }),
    );
    expect(result).toContain('→ Gardianmini (27% HP)');
  });

  it('emits [TEAM] [CD] for each teammate cast', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        teammateCDs: [
          {
            player: makeOwner('Simplesauce'),
            spec: 'Unholy Death Knight',
            cds: [
              {
                spellId: '48707',
                spellName: 'Anti-Magic Shell',
                tag: 'Defensive',
                cooldownSeconds: 60,
                maxChargesDetected: 1,
                casts: [{ timeSeconds: 108 }],
                availableWindows: [],
                neverUsed: false,
              },
            ],
          },
        ],
      }),
    );
    expect(result).toContain('[TEAM] [CD]');
    expect(result).toContain('Simplesauce (Unholy Death Knight): Anti-Magic Shell');
    expect(result).toContain('1:48');
  });

  it('emits [ENEMY CD] for individual enemy casts (not grouped)', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        enemyCDTimeline: makeEnemyTimeline([
          {
            playerName: 'Dzinked',
            specName: 'Holy Paladin',
            offensiveCDs: [
              {
                spellId: '31884',
                spellName: 'Avenging Crusader',
                castTimeSeconds: 33,
                cooldownSeconds: 120,
                availableAgainAtSeconds: 153,
                buffEndSeconds: 51,
              },
              {
                spellId: '31884',
                spellName: 'Avenging Crusader',
                castTimeSeconds: 153,
                cooldownSeconds: 120,
                availableAgainAtSeconds: 273,
                buffEndSeconds: 171,
              },
            ],
          },
        ]),
      }),
    );
    // Both casts should appear individually
    const matches = result.match(/\[ENEMY CD\]/g) ?? [];
    expect(matches.length).toBe(2);
    // B107: repeated casts of the same spell are annotated with a per-spell sequence index
    expect(result).toContain('Dzinked (Holy Paladin): Avenging Crusader [1/2]');
    expect(result).toContain('Dzinked (Holy Paladin): Avenging Crusader [2/2]');
    expect(result).toContain('0:33');
    expect(result).toContain('2:33');
  });

  it('B107: does not annotate single-cast enemy CDs with sequence index', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        enemyCDTimeline: makeEnemyTimeline([
          {
            playerName: 'Dzinked',
            specName: 'Holy Paladin',
            offensiveCDs: [
              {
                spellId: '31884',
                spellName: 'Avenging Crusader',
                castTimeSeconds: 33,
                cooldownSeconds: 120,
                availableAgainAtSeconds: 153,
                buffEndSeconds: 51,
              },
            ],
          },
        ]),
      }),
    );
    expect(result).toContain('Dzinked (Holy Paladin): Avenging Crusader');
    expect(result).not.toMatch(/Avenging Crusader \[\d+\/\d+\]/);
  });

  it('B107: tracks sequence per spell per player independently', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        enemyCDTimeline: makeEnemyTimeline([
          {
            playerName: 'Ruminator',
            specName: 'Beast Mastery Hunter',
            offensiveCDs: [
              {
                spellId: '19574',
                spellName: 'Bestial Wrath',
                castTimeSeconds: 10,
                cooldownSeconds: 90,
                availableAgainAtSeconds: 100,
                buffEndSeconds: 25,
              },
              {
                spellId: '19574',
                spellName: 'Bestial Wrath',
                castTimeSeconds: 77,
                cooldownSeconds: 90,
                availableAgainAtSeconds: 167,
                buffEndSeconds: 92,
              },
              {
                spellId: '19574',
                spellName: 'Bestial Wrath',
                castTimeSeconds: 145,
                cooldownSeconds: 90,
                availableAgainAtSeconds: 235,
                buffEndSeconds: 160,
              },
              {
                spellId: '19574',
                spellName: 'Bestial Wrath',
                castTimeSeconds: 215,
                cooldownSeconds: 90,
                availableAgainAtSeconds: 305,
                buffEndSeconds: 230,
              },
              // Different spell on the same player must have its own counter
              {
                spellId: '193530',
                spellName: 'Aspect of the Wild',
                castTimeSeconds: 60,
                cooldownSeconds: 120,
                availableAgainAtSeconds: 180,
                buffEndSeconds: 80,
              },
            ],
          },
        ]),
      }),
    );
    expect(result).toContain('Bestial Wrath [1/4]');
    expect(result).toContain('Bestial Wrath [2/4]');
    expect(result).toContain('Bestial Wrath [3/4]');
    expect(result).toContain('Bestial Wrath [4/4]');
    // Single-cast spell on the same player is not annotated
    expect(result).toContain('Aspect of the Wild');
    expect(result).not.toMatch(/Aspect of the Wild \[\d+\/\d+\]/);
  });

  it('sorts all CD events chronologically', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        ownerCDs: [
          {
            spellId: '1',
            spellName: 'Life Cocoon',
            tag: 'Defensive',
            cooldownSeconds: 120,
            maxChargesDetected: 1,
            casts: [{ timeSeconds: 55 }],
            availableWindows: [],
            neverUsed: false,
          },
        ],
        enemyCDTimeline: makeEnemyTimeline([
          {
            playerName: 'Dzinked',
            specName: 'Holy Paladin',
            offensiveCDs: [
              {
                spellId: '31884',
                spellName: 'Avenging Crusader',
                castTimeSeconds: 33,
                cooldownSeconds: 120,
                availableAgainAtSeconds: 153,
                buffEndSeconds: 51,
              },
            ],
          },
        ]),
      }),
    );
    const acPos = result.indexOf('Avenging Crusader');
    const lcPos = result.indexOf('Life Cocoon');
    expect(acPos).toBeLessThan(lcPos); // 0:33 before 0:55
  });
});

describe('buildMatchTimeline — CC, dispel, pressure, healing gap events', () => {
  it('emits [CC ON TEAM] with trinket: available when trinket was available (B108 fix)', () => {
    const cc: ICCInstance = {
      atSeconds: 37,
      durationSeconds: 4,
      spellId: '853',
      spellName: 'Hammer of Justice',
      sourceName: 'Dzinked',
      sourceSpec: 'Holy Paladin',
      damageTakenDuring: 50_000,
      trinketState: 'available_unused',
      drInfo: null,
      distanceYards: null,
      losBlocked: null,
    };
    const result = buildMatchTimeline(
      makeBaseParams({
        ccTrinketSummaries: [{ ...makeEmptyCCTrinketSummary('Feramonk'), ccInstances: [cc] }],
      }),
    );
    expect(result).toContain('[CC ON TEAM]');
    expect(result).toContain('Feramonk ← Hammer of Justice (Dzinked)');
    expect(result).toContain('trinket: available');
    expect(result).toContain('0:37');
  });

  it('F124: emits [CC ON TEAM] with base duration, DR category/level, and dispel backlash annotations', () => {
    const cc: ICCInstance = {
      atSeconds: 37,
      durationSeconds: 4,
      spellId: '118',
      spellName: 'Polymorph',
      sourceName: 'Dzinked',
      sourceSpec: 'Frost Mage',
      damageTakenDuring: 50_000,
      trinketState: 'available_unused',
      drInfo: { category: 'Disorient', level: '50%' as const, sequenceIndex: 1 },
      distanceYards: null,
      losBlocked: null,
    };
    const ccBacklash: ICCInstance = {
      atSeconds: 45,
      durationSeconds: 3,
      spellId: '196363',
      spellName: 'Silence',
      sourceName: 'Dzinked',
      sourceSpec: 'Shadow Priest',
      damageTakenDuring: 10_000,
      trinketState: 'passive_trinket',
      drInfo: null,
      distanceYards: null,
      losBlocked: null,
    };

    const result = buildMatchTimeline(
      makeBaseParams({
        ccTrinketSummaries: [
          {
            ...makeEmptyCCTrinketSummary('Feramonk'),
            ccInstances: [cc, ccBacklash],
          },
        ],
      }),
    );

    expect(result).toContain('Feramonk ← Polymorph (Dzinked) | 4s (base 60s) [DR: Disorient 50%]');
    expect(result).toContain('Feramonk ← Silence (Dzinked) | 3s [DISPEL BACKLASH CC]');
  });

  it('emits [CC ON TEAM] with trinket: used when trinket was consumed', () => {
    const cc: ICCInstance = {
      atSeconds: 15,
      durationSeconds: 6,
      spellId: '853',
      spellName: 'Hammer of Justice',
      sourceName: 'Dzinked',
      sourceSpec: 'Holy Paladin',
      damageTakenDuring: 30_000,
      trinketState: 'used',
      drInfo: null,
      distanceYards: null,
      losBlocked: null,
    };
    const result = buildMatchTimeline(
      makeBaseParams({
        ccTrinketSummaries: [{ ...makeEmptyCCTrinketSummary('Feramonk'), ccInstances: [cc] }],
      }),
    );
    expect(result).toContain('trinket: used');
  });

  it('emits [CC ON TEAM] with trinket: ON CD (Xs left) when trinket is on cooldown', () => {
    const cc: ICCInstance = {
      atSeconds: 52,
      durationSeconds: 6,
      spellId: '853',
      spellName: 'Hammer of Justice',
      sourceName: 'Dzinked',
      sourceSpec: 'Holy Paladin',
      damageTakenDuring: 80_000,
      trinketState: 'on_cooldown',
      trinketCDSecondsLeft: 38,
      drInfo: null,
      distanceYards: null,
      losBlocked: null,
    };
    const result = buildMatchTimeline(
      makeBaseParams({
        ccTrinketSummaries: [{ ...makeEmptyCCTrinketSummary('Feramonk'), ccInstances: [cc] }],
      }),
    );
    expect(result).toContain('trinket: ON CD (38s left)');
  });

  it('emits [CC ON TEAM] with trinket: ON CD (on CD) when trinketCDSecondsLeft is absent', () => {
    const cc: ICCInstance = {
      atSeconds: 52,
      durationSeconds: 6,
      spellId: '853',
      spellName: 'Hammer of Justice',
      sourceName: 'Dzinked',
      sourceSpec: 'Holy Paladin',
      damageTakenDuring: 80_000,
      trinketState: 'on_cooldown',
      drInfo: null,
      distanceYards: null,
      losBlocked: null,
    };
    const result = buildMatchTimeline(
      makeBaseParams({
        ccTrinketSummaries: [{ ...makeEmptyCCTrinketSummary('Feramonk'), ccInstances: [cc] }],
      }),
    );
    expect(result).toContain('trinket: ON CD (on CD)');
  });

  it('emits [CC ON TEAM] with no trinket annotation for passive_trinket (Relentless)', () => {
    const cc: ICCInstance = {
      atSeconds: 30,
      durationSeconds: 5,
      spellId: '853',
      spellName: 'Hammer of Justice',
      sourceName: 'Dzinked',
      sourceSpec: 'Holy Paladin',
      damageTakenDuring: 0,
      trinketState: 'passive_trinket',
      drInfo: null,
      distanceYards: null,
      losBlocked: null,
    };
    const result = buildMatchTimeline(
      makeBaseParams({
        ccTrinketSummaries: [{ ...makeEmptyCCTrinketSummary('Feramonk'), ccInstances: [cc] }],
      }),
    );
    expect(result).toContain('[CC ON TEAM]');
    expect(result).not.toContain('trinket:');
  });

  it('suppresses [CC ON TEAM] when durationSeconds is 0 (instant-break artifact)', () => {
    const cc: ICCInstance = {
      atSeconds: 15,
      durationSeconds: 0,
      spellId: '853',
      spellName: 'Hammer of Justice',
      sourceName: 'Dzinked',
      sourceSpec: 'Holy Paladin',
      damageTakenDuring: 0,
      trinketState: 'used',
      drInfo: null,
      distanceYards: null,
      losBlocked: null,
    };
    const result = buildMatchTimeline(
      makeBaseParams({
        ccTrinketSummaries: [{ ...makeEmptyCCTrinketSummary('Feramonk'), ccInstances: [cc] }],
      }),
    );
    expect(result).not.toContain('[CC ON TEAM]');
  });

  it('emits [TRINKET] events for trinket uses', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        ccTrinketSummaries: [{ ...makeEmptyCCTrinketSummary('Feramonk'), trinketUseTimes: [68] }],
      }),
    );
    expect(result).toContain('[TRINKET]');
    expect(result).toContain('Feramonk used PvP trinket');
    expect(result).toContain('1:08');
  });

  it('emits [UNCLEANSED DEBUFF] with damage amount and dispel type', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: makeOwner('Feramonk', CombatUnitSpec.Paladin_Holy), // B16: owner must be able to Magic-dispel
        dispelSummary: {
          ...makeEmptyDispelSummary(),
          missedCleanseWindows: [
            {
              timeSeconds: 134,
              durationSeconds: 30,
              targetName: 'Simplesauce',
              targetSpec: 'Unholy Death Knight',
              spellName: 'Vampiric Touch',
              spellId: '34914',
              priority: 'High',
              dispelType: 'Magic' as any,
              postCcDamage: 212_000,
              cleanseWasOnCD: false,
            },
          ],
        },
      }),
    );
    expect(result).toContain('[UNCLEANSED DEBUFF]');
    expect(result).toContain('Vampiric Touch on Simplesauce');
    expect(result).toContain('212k');
    expect(result).toContain('dispel: Magic');
  });

  it('B16: suppresses [UNCLEANSED DEBUFF] when owner spec cannot dispel the debuff type', () => {
    // Mistweaver cannot remove Curse — should NOT emit [UNCLEANSED DEBUFF] for a Curse debuff
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: makeOwner('Feramonk', CombatUnitSpec.Monk_Mistweaver),
        dispelSummary: {
          ...makeEmptyDispelSummary(),
          missedCleanseWindows: [
            {
              timeSeconds: 10,
              durationSeconds: 8,
              targetName: 'Simplesauce',
              targetSpec: 'Unholy Death Knight',
              spellName: 'Mortal Coil',
              spellId: '6789',
              priority: 'High',
              dispelType: 'Curse' as any,
              postCcDamage: 50_000,
              cleanseWasOnCD: false,
            },
          ],
        },
      }),
    );
    expect(result).not.toContain('[UNCLEANSED DEBUFF]');
  });

  it('emits [CLEANSE] for successful dispels', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        dispelSummary: {
          ...makeEmptyDispelSummary(),
          allyCleanse: [
            {
              timeSeconds: 44,
              dispelSpellId: '115450',
              dispelSpellName: 'Detox',
              removedSpellId: '34914',
              removedSpellName: 'Vampiric Touch',
              sourceName: 'Feramonk',
              sourceSpec: 'Mistweaver Monk',
              targetName: 'Simplesauce',
              targetSpec: 'Unholy Death Knight',
              priority: 'High',
              hasDispelPenalty: false,
              isSpellSteal: false,
              isPetDispel: false,
            },
          ],
        },
      }),
    );
    expect(result).toContain('[CLEANSE]');
    expect(result).toContain('Feramonk dispelled Vampiric Touch off Simplesauce');
  });

  it('annotates [CLEANSE] with (pet) when isPetDispel is true', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        dispelSummary: {
          ...makeEmptyDispelSummary(),
          allyCleanse: [
            {
              timeSeconds: 44,
              dispelSpellId: '19505',
              dispelSpellName: 'Devour Magic',
              removedSpellId: '118',
              removedSpellName: 'Polymorph',
              sourceName: 'WarlockPlayer',
              sourceSpec: 'Affliction Warlock',
              targetName: 'Simplesauce',
              targetSpec: 'Unholy Death Knight',
              priority: 'High',
              hasDispelPenalty: false,
              isSpellSteal: false,
              isPetDispel: true,
            },
          ],
        },
      }),
    );
    expect(result).toContain('[CLEANSE]');
    expect(result).toContain('WarlockPlayer dispelled Polymorph off Simplesauce');
    expect(result).toContain('(pet)');
  });

  it('does NOT annotate [CLEANSE] with (pet) when isPetDispel is false', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        dispelSummary: {
          ...makeEmptyDispelSummary(),
          allyCleanse: [
            {
              timeSeconds: 44,
              dispelSpellId: '115450',
              dispelSpellName: 'Detox',
              removedSpellId: '118',
              removedSpellName: 'Polymorph',
              sourceName: 'Feramonk',
              sourceSpec: 'Mistweaver Monk',
              targetName: 'Simplesauce',
              targetSpec: 'Unholy Death Knight',
              priority: 'High',
              hasDispelPenalty: false,
              isSpellSteal: false,
              isPetDispel: false,
            },
          ],
        },
      }),
    );
    expect(result).toContain('[CLEANSE]');
    expect(result).toContain('Feramonk dispelled Polymorph off Simplesauce');
    expect(result).not.toContain('(pet)');
  });

  it('emits [FATAL DISPEL: ...] when a dispel event was fatal', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        dispelSummary: {
          ...makeEmptyDispelSummary(),
          allyCleanse: [
            {
              timeSeconds: 44,
              dispelSpellId: '115450',
              dispelSpellName: 'Detox',
              removedSpellId: '34914',
              removedSpellName: 'Vampiric Touch',
              sourceName: 'Feramonk',
              sourceSpec: 'Mistweaver Monk',
              targetName: 'Simplesauce',
              targetSpec: 'Unholy Death Knight',
              priority: 'High',
              hasDispelPenalty: false,
              isSpellSteal: false,
              isPetDispel: false,
              wasFatal: true,
              fatalUnitName: 'Feramonk',
              fatalUnitSpec: 'Mistweaver Monk',
            },
          ],
        },
      }),
    );
    expect(result).toContain('[CLEANSE]');
    expect(result).toContain('[FATAL DISPEL: Feramonk]');
  });

  it('F148: annotates [CC ON TEAM] with [CLEANSED] when a friendly dispel removed it', () => {
    const cc: ICCInstance = {
      atSeconds: 10,
      durationSeconds: 2, // ended early
      spellId: '605',
      spellName: 'Mind Control',
      sourceName: 'Dzinked',
      sourceSpec: 'Shadow Priest',
      damageTakenDuring: 0,
      trinketState: 'available_unused',
      drInfo: null,
      distanceYards: null,
      losBlocked: null,
    };
    const result = buildMatchTimeline(
      makeBaseParams({
        ccTrinketSummaries: [{ ...makeEmptyCCTrinketSummary('Feramonk'), ccInstances: [cc] }],
        dispelSummary: {
          ...makeEmptyDispelSummary(),
          allyCleanse: [
            {
              timeSeconds: 12, // 10 + 2
              dispelSpellId: '115450',
              dispelSpellName: 'Detox',
              removedSpellId: '605',
              removedSpellName: 'Mind Control',
              sourceName: 'Feramonk',
              sourceSpec: 'Mistweaver Monk',
              targetName: 'Feramonk',
              targetSpec: 'Mistweaver Monk',
              priority: 'High',
              hasDispelPenalty: false,
              isSpellSteal: false,
              isPetDispel: false,
            },
          ],
        },
      }),
    );
    expect(result).toContain('[CC ON TEAM]');
    expect(result).toContain('Mind Control');
    expect(result).toContain('2s');
    expect(result).toContain('[CLEANSED]');
  });

  it('emits [DMG SPIKE] only for windows ≥300k', () => {
    const windows: IDamageBucket[] = [
      {
        fromSeconds: 19,
        toSeconds: 24,
        totalDamage: 1_240_000,
        targetName: 'Gardianmini',
        targetSpec: 'Shadow Priest',
      },
      { fromSeconds: 50, toSeconds: 55, totalDamage: 200_000, targetName: 'Feramonk', targetSpec: 'Mistweaver Monk' },
    ];
    const result = buildMatchTimeline(makeBaseParams({ pressureWindows: windows }));
    expect(result).toContain('[DMG SPIKE]');
    expect(result).toContain('1.24M');
    // 200k window should NOT appear
    const spikeCount = (result.match(/\[DMG SPIKE\]/g) ?? []).length;
    expect(spikeCount).toBe(1);
  });

  describe('[OFFENSIVE WINDOW] synthesized headers', () => {
    const makeBurst = (
      fromSeconds: number,
      toSeconds: number,
      dangerLabel: 'Low' | 'Moderate' | 'High' | 'Critical' = 'Critical',
    ): IAlignedBurstWindow => ({
      fromSeconds,
      toSeconds,
      activeCDs: [
        { playerName: 'EnemyRogue', spellName: 'Shadow Blades', spellId: '121471' },
        { playerName: 'EnemyWarrior', spellName: 'Bladestorm', spellId: '227847' },
      ],
      dangerScore: 7.2,
      dangerLabel,
      dampeningPct: 0,
      damageInWindow: 840_000,
      damageRatio: 1.2,
      healerCCed: false,
    });

    const makeSpike = (fromSeconds: number, totalDamage = 840_000): IDamageBucket => ({
      fromSeconds,
      toSeconds: fromSeconds + 10,
      totalDamage,
      targetName: 'Feramonk',
      targetSpec: 'Holy Paladin',
    });

    it('emits [OFFENSIVE WINDOW] when burst window overlaps a qualifying spike', () => {
      const enemyCDTimeline: IEnemyCDTimeline = {
        players: [],
        alignedBurstWindows: [makeBurst(14, 24)],
      };
      const pressureWindows = [makeSpike(15)];
      const result = buildMatchTimeline(makeBaseParams({ enemyCDTimeline, pressureWindows }));
      expect(result).toContain('[OFFENSIVE WINDOW]');
      expect(result).toContain('0:14–0:24');
      expect(result).toContain('0.84M');
      expect(result).toContain('Shadow Blades + Bladestorm');
    });

    it('does NOT emit [OFFENSIVE WINDOW] when spike is below DMG_SPIKE_THRESHOLD', () => {
      const enemyCDTimeline: IEnemyCDTimeline = {
        players: [],
        alignedBurstWindows: [makeBurst(14, 24)],
      };
      const pressureWindows = [makeSpike(15, 200_000)]; // below 300k threshold
      const result = buildMatchTimeline(makeBaseParams({ enemyCDTimeline, pressureWindows }));
      expect(result).not.toContain('[OFFENSIVE WINDOW]');
    });

    it('does NOT emit [OFFENSIVE WINDOW] when spike is outside burst window ±5s', () => {
      const enemyCDTimeline: IEnemyCDTimeline = {
        players: [],
        alignedBurstWindows: [makeBurst(14, 24)],
      };
      const pressureWindows = [makeSpike(31)]; // 31 > 24 + 5 = 29 → no overlap
      const result = buildMatchTimeline(makeBaseParams({ enemyCDTimeline, pressureWindows }));
      expect(result).not.toContain('[OFFENSIVE WINDOW]');
    });

    it('does NOT emit [OFFENSIVE WINDOW] when no aligned burst windows exist', () => {
      const pressureWindows = [makeSpike(15)];
      const result = buildMatchTimeline(makeBaseParams({ pressureWindows }));
      expect(result).not.toContain('[OFFENSIVE WINDOW]');
    });

    it('[OFFENSIVE WINDOW] sorts before [DMG SPIKE] at the same timestamp', () => {
      const enemyCDTimeline: IEnemyCDTimeline = {
        players: [],
        alignedBurstWindows: [makeBurst(15, 25)],
      };
      const pressureWindows = [makeSpike(15)];
      const result = buildMatchTimeline(makeBaseParams({ enemyCDTimeline, pressureWindows }));
      const offIdx = result.indexOf('[OFFENSIVE WINDOW]');
      const spikeIdx = result.indexOf('[DMG SPIKE]');
      expect(offIdx).toBeGreaterThanOrEqual(0);
      expect(spikeIdx).toBeGreaterThanOrEqual(0);
      expect(offIdx).toBeLessThan(spikeIdx);
    });
  });

  it('damage unit legend string is self-consistent', () => {
    const legend = '  Damage units: M = 1,000,000  |  k = 1,000  (e.g. "0.84M" = 840,000 dmg)';
    expect(legend).toContain('M = 1,000,000');
    expect(legend).toContain('k = 1,000');
    expect(legend).toContain('0.84M');
    expect(legend).toContain('840,000 dmg');
  });

  it('emits [INACTIVITY] only when isHealer is true', () => {
    const gap: IHealingGap = {
      fromSeconds: 82,
      toSeconds: 86.2,
      durationSeconds: 4.2,
      freeCastSeconds: 2.1,
      mostDamagedSpec: 'Unholy Death Knight',
      mostDamagedName: 'Simplesauce',
      mostDamagedAmount: 400_000,
    };
    const healerResult = buildMatchTimeline(makeBaseParams({ healingGaps: [gap], isHealer: true }));
    const dpsResult = buildMatchTimeline(makeBaseParams({ healingGaps: [gap], isHealer: false }));

    expect(healerResult).toContain('[INACTIVITY]');
    expect(healerResult).toContain('Feramonk inactive 4.2s');
    expect(dpsResult).not.toContain('[INACTIVITY]');
  });

  it.skip('emits [HP] ticks every 3s when friends have HP data', () => {
    const unit = makeUnit('unit-1', {
      name: 'Feramonk',
      advancedActions: [
        makeAdvancedAction(3_000, 0, 0, 500_000, 420_000), // t=3s → 84%
        makeAdvancedAction(6_000, 0, 0, 500_000, 250_000), // t=6s → 50%
      ],
    }) as ICombatUnit;
    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [unit],
        matchStartMs: 0,
        matchEndMs: 9_000,
      }),
    );
    expect(result).toContain('[STATE]');
    expect(result).toContain('Feramonk:84');
    expect(result).toContain('Feramonk:50');
  });

  it.skip('emits [HP] for multiple friends on the same tick', () => {
    const unit1 = makeUnit('unit-1', {
      name: 'Healer',
      advancedActions: [makeAdvancedAction(3_000, 0, 0, 500_000, 400_000)], // 80%
    }) as ICombatUnit;
    const unit2 = makeUnit('unit-2', {
      name: 'DPS',
      advancedActions: [makeAdvancedAction(3_000, 0, 0, 500_000, 500_000)], // 100%
    }) as ICombatUnit;
    // Override advancedActorId so getUnitHpAtTimestamp finds the right unit
    (unit2 as any).advancedActions[0].advancedActorId = 'unit-2';
    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [unit1, unit2],
        matchStartMs: 0,
        matchEndMs: 6_000,
      }),
    );
    expect(result).toContain('Healer:80');
    expect(result).toContain('DPS:100');
    // Both should be on the same [STATE] line
    const hpLine = result.split('\n').find((l) => l.includes('[STATE]') && l.includes('Healer'));
    expect(hpLine).toContain('DPS');
  });

  it.skip('puts log owner first in [STATE] friends section regardless of input order', () => {
    // Owner is 'Feramonk' (default makeBaseParams owner name)
    const ownerUnit = makeUnit('unit-1', {
      name: 'Feramonk',
      advancedActions: [makeAdvancedAction(3_000, 0, 0, 500_000, 400_000)], // 80%
    }) as ICombatUnit;
    const dpsUnit = makeUnit('unit-2', {
      name: 'DPS',
      advancedActions: [makeAdvancedAction(3_000, 0, 0, 500_000, 500_000)], // 100%
    }) as ICombatUnit;
    (dpsUnit as any).advancedActions[0].advancedActorId = 'unit-2';

    // DPS is listed first in the friends array — owner should still appear first in output
    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [dpsUnit, ownerUnit],
        matchStartMs: 0,
        matchEndMs: 6_000,
      }),
    );

    const stateLine = result.split('\n').find((l) => l.includes('[STATE]') && l.includes('Feramonk'));
    expect(stateLine).toBeDefined();
    // Owner must appear before DPS in the friends section
    if (stateLine) {
      const ownerPos = stateLine.indexOf('Feramonk');
      const dpsPos = stateLine.indexOf('DPS');
      expect(ownerPos).toBeLessThan(dpsPos);
    }
  });

  it('omits [HP] ticks when no friends have advanced action data', () => {
    const unit = makeUnit('unit-1', { name: 'Feramonk', advancedActions: [] }) as ICombatUnit;
    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [unit],
        matchStartMs: 0,
        matchEndMs: 9_000,
      }),
    );
    expect(result).not.toContain('[STATE]');
  });

  it('B106: sorts [STATE] enemy HP tokens by player ID when enemyIdMap is provided', () => {
    // Three enemies, intentionally fed in non-ID order to mimic the bug example
    // where the prompt emitted `enemies 4:100 6:42 5:22`.
    const enemyA = makeUnit('enemy-A', {
      name: 'EnemyA',
      reaction: CombatUnitReaction.Hostile,
      advancedActions: [{ ...makeAdvancedAction(6_000, 0, 0, 500_000, 500_000), advancedActorId: 'enemy-A' }], // 100%
    }) as ICombatUnit;
    const enemyB = makeUnit('enemy-B', {
      name: 'EnemyB',
      reaction: CombatUnitReaction.Hostile,
      advancedActions: [{ ...makeAdvancedAction(6_000, 0, 0, 500_000, 210_000), advancedActorId: 'enemy-B' }], // 42%
    }) as ICombatUnit;
    const enemyC = makeUnit('enemy-C', {
      name: 'EnemyC',
      reaction: CombatUnitReaction.Hostile,
      advancedActions: [{ ...makeAdvancedAction(6_000, 0, 0, 500_000, 110_000), advancedActorId: 'enemy-C' }], // 22%
    }) as ICombatUnit;

    // Map IDs out of input order: input is A, B, C but IDs are 4, 6, 5.
    const enemyIdMap = new Map<string, number>([
      ['EnemyA', 4],
      ['EnemyB', 6],
      ['EnemyC', 5],
    ]);
    const playerIdMap = new Map<string, number>([['Feramonk', 1]]);

    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [makeUnit('unit-1', { name: 'Feramonk', advancedActions: [] }) as ICombatUnit],
        enemies: [enemyA, enemyB, enemyC],
        enemyDeaths: [{ spec: 'Affliction Warlock', name: 'EnemyC', atSeconds: 10 }],
        playerIdMap,
        enemyIdMap,
        matchStartMs: 0,
        matchEndMs: 12_000,
      }),
    );

    const stateLine = result.split('\n').find((l) => l.includes('[STATE]') && l.includes('enemies '));
    expect(stateLine).toBeDefined();
    if (stateLine) {
      const enemiesSection = stateLine.split('enemies ')[1];
      // Tokens must appear in player-ID order (4, 5, 6), not input order (4, 6, 5)
      const idOrder = (enemiesSection.match(/\b(\d+):/g) ?? []).map((s) => parseInt(s, 10));
      expect(idOrder).toEqual([4, 5, 6]);
    }
  });

  it.skip('B106: sorts [STATE] friendly HP tokens by player ID when playerIdMap is provided', () => {
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      advancedActions: [makeAdvancedAction(3_000, 0, 0, 500_000, 400_000)], // 80%
    }) as ICombatUnit;
    const dps = makeUnit('unit-2', {
      name: 'DPS',
      advancedActions: [{ ...makeAdvancedAction(3_000, 0, 0, 500_000, 350_000), advancedActorId: 'unit-2' }], // 70%
    }) as ICombatUnit;
    const other = makeUnit('unit-3', {
      name: 'Other',
      advancedActions: [{ ...makeAdvancedAction(3_000, 0, 0, 500_000, 250_000), advancedActorId: 'unit-3' }], // 50%
    }) as ICombatUnit;

    // Owner=1, DPS=2, Other=3. Feed friends in scrambled order to verify sort.
    const playerIdMap = new Map<string, number>([
      ['Feramonk', 1],
      ['DPS', 2],
      ['Other', 3],
    ]);

    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [other, dps, owner],
        playerIdMap,
        matchStartMs: 0,
        matchEndMs: 6_000,
      }),
    );

    const stateLine = result.split('\n').find((l) => l.includes('[STATE]') && l.includes('friends '));
    expect(stateLine).toBeDefined();
    if (stateLine) {
      const friendsSection = stateLine.split('friends ')[1].split(' / enemies')[0];
      const idOrder = (friendsSection.match(/\b(\d+):/g) ?? []).map((s) => parseInt(s, 10));
      expect(idOrder).toEqual([1, 2, 3]);
    }
  });
});

describe('buildMatchTimeline — [YOU] [CAST] (F61 healer gap-filler)', () => {
  it('emits [YOU] [CD] (B38 promotion) for major-CD healer spell not tracked in ownerCDs when isHealer=true', () => {
    // Healing Tide Totem (108280) has cooldownSeconds 180 in spellEffectData — B38 promotes it
    // from [YOU] [CAST] to [YOU] [CD] so it appears with the stronger event type.
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('108280', 30_000, 'team-1')], // HTT at T=30s
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [],
        matchStartMs: 0,
        matchEndMs: 60_000,
      }),
    );
    expect(result).toContain('[YOU] [CD]');
    expect(result).not.toContain('[YOU] [CAST]   Healing Tide Totem');
    expect(result).toContain('Healing Tide Totem');
    expect(result).toContain('0:30');
  });

  it('does not emit [YOU] [CAST] when spell is already tracked in ownerCDs within ±1s', () => {
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('10060', 20_000, 'team-1')], // PI at T=20s
    });
    const piCD: IMajorCooldownInfo = {
      spellId: '10060',
      spellName: 'Power Infusion',
      tag: 'External',
      cooldownSeconds: 120,
      maxChargesDetected: 1,
      casts: [{ timeSeconds: 20 }],
      availableWindows: [],
      neverUsed: false,
    };
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [piCD],
        matchStartMs: 0,
        matchEndMs: 60_000,
      }),
    );
    expect(result).not.toContain('[YOU] [CAST]');
  });

  it('does not emit [YOU] [CAST] when isHealer is false', () => {
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('108280', 30_000, 'team-1')], // HTT at T=30s
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: false,
        ownerCDs: [],
        matchStartMs: 0,
        matchEndMs: 60_000,
      }),
    );
    expect(result).not.toContain('[YOU] [CAST]');
  });

  it('emits [YOU] [CAST] for any spell the owner casts, not just the healer whitelist', () => {
    // Spell ID '9999' is not in HEALER_CAST_SPELL_ID_TO_NAME — after F65 it must still appear.
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('9999', 30_000, 'player-2', 'Simplesauce')],
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [],
        matchStartMs: 0,
        matchEndMs: 60_000,
      }),
    );
    expect(result).toContain('[YOU] [CAST]');
    // spellName echoes spellId in the mock (makeSpellCastEvent sets spellName = spellId)
    expect(result).toContain('9999');
  });

  it('B104: uses the log spellName when the spell ID is absent from curated metadata', () => {
    // Spell ID '47540' (Penance) is not in spellEffects.json nor HEALER_CAST_SPELL_ID_TO_NAME.
    // Pre-fix, the [YOU] [CAST] line emitted the raw numeric ID. Now it must fall back to
    // the spellName attached to the log event.
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('47540', 30_000, 'unit-1', 'Feramonk', 'unit-1', 'Feramonk', 0, 'Penance')],
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [],
        matchStartMs: 0,
        matchEndMs: 60_000,
      }),
    );
    const ownerCastLine = result.split('\n').find((l) => l.includes('[YOU] [CAST]'));
    expect(ownerCastLine).toBeDefined();
    expect(ownerCastLine).toContain('Penance');
    // The raw spell ID must NOT appear as the cast label (it may still appear elsewhere
    // in the line as part of a target/source name, so we anchor on the cast token position).
    expect(ownerCastLine).not.toMatch(/\[YOU\] \[CAST\]\s+47540\b/);
  });
});

describe('buildMatchTimeline — F65 [YOU] [CAST] target labels', () => {
  it('appends "self" when the owner targets themselves', () => {
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('1', 30_000, 'unit-1', 'Feramonk')],
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [],
        matchStartMs: 0,
        matchEndMs: 60_000,
      }),
    );
    expect(result).toContain('[YOU] [CAST]');
    expect(result).toContain('→ self');
  });

  it('appends a numeric ID when the target is a known friendly player', () => {
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('1', 30_000, 'unit-2', 'Simplesauce')],
    });
    const playerIdMap = new Map<string, number>([
      ['Feramonk', 1],
      ['Simplesauce', 2],
    ]);
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [],
        matchStartMs: 0,
        matchEndMs: 60_000,
        playerIdMap,
      }),
    );
    expect(result).toContain('→ 2');
  });

  it('appends a numeric ID when the target is a known enemy player', () => {
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('1', 30_000, 'enemy-1', 'Natjkis')],
    });
    const enemyIdMap = new Map<string, number>([['Natjkis', 3]]);
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [],
        matchStartMs: 0,
        matchEndMs: 60_000,
        enemyIdMap,
      }),
    );
    expect(result).toContain('→ 3');
  });

  it('appends raw target name when the target is not in any ID map', () => {
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('1', 30_000, 'npc-99', 'SomeNPC')],
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [],
        matchStartMs: 0,
        matchEndMs: 60_000,
      }),
    );
    expect(result).toContain('→ SomeNPC');
  });

  it('omits the target arrow when destUnitName is the literal string "nil" (WoW log convention for untargeted spells)', () => {
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('1', 30_000, 'nil', 'nil')],
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [],
        matchStartMs: 0,
        matchEndMs: 60_000,
      }),
    );
    expect(result).toContain('[YOU] [CAST]');
    expect(result).not.toContain('→');
  });

  it('omits the target arrow when destUnitName is empty', () => {
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('1', 30_000, '', '')],
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [],
        matchStartMs: 0,
        matchEndMs: 60_000,
      }),
    );
    expect(result).toContain('[YOU] [CAST]');
    expect(result).not.toContain('→');
  });

  it('uses the canonical spell name from HEALER_CAST_SPELL_ID_TO_NAME when available', () => {
    // spellId '108280' = Healing Tide Totem — makeSpellCastEvent sets spellName='108280',
    // but the canonical map overrides display to 'Healing Tide Totem'.
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('108280', 30_000, 'unit-1', 'Feramonk')],
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [],
        matchStartMs: 0,
        matchEndMs: 60_000,
      }),
    );
    expect(result).toContain('Healing Tide Totem');
  });

  it('suppresses trinket cast from [YOU] [CAST] when the same timestamp is already tracked by [TRINKET]', () => {
    // Trinket use at T=64s — should appear as [TRINKET] only, not also as [YOU] [CAST].
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('42292', 64_000, '', 'nil')], // PvP trinket spell ID
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [],
        matchStartMs: 0,
        matchEndMs: 120_000,
        ccTrinketSummaries: [{ ...makeEmptyCCTrinketSummary('Feramonk'), trinketUseTimes: [64] }],
      }),
    );
    expect(result).toContain('[TRINKET]');
    expect(result).not.toContain('[YOU] [CAST]');
  });

  it('still deduplicates against ownerCDs (does not double-emit spells tracked as [YOU] [CD])', () => {
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('108280', 30_000, 'unit-1', 'Feramonk')],
    });
    const httCD: IMajorCooldownInfo = {
      spellId: '108280',
      spellName: 'Healing Tide Totem',
      tag: 'Defensive',
      cooldownSeconds: 180,
      maxChargesDetected: 1,
      casts: [{ timeSeconds: 30 }],
      availableWindows: [],
      neverUsed: false,
    };
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [httCD],
        matchStartMs: 0,
        matchEndMs: 60_000,
      }),
    );
    expect(result).toContain('[YOU] [CD]');
    expect(result).not.toContain('[YOU] [CAST]');
  });

  it('appends [totem/pet] when [YOU] [CAST] target is a Guardian (totem, destUnitFlags 0x2000)', () => {
    const GUARDIAN_FLAGS = 0x00002000;
    // Use spell ID '1' (no CD data → stays [YOU] [CAST], not B38-promoted)
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: {
          ...makeOwner('Feramonk'),
          spellCastEvents: [
            makeSpellCastEvent('1', 30_000, 'totem-1', 'Tremor Totem', 'player-1', 'Feramonk', GUARDIAN_FLAGS),
          ],
        } as any,
      }),
    );
    expect(result).toContain('[YOU] [CAST]');
    expect(result).toContain('[totem/pet]');
    expect(result).toContain('Tremor Totem');
  });

  it('appends [totem/pet] when [YOU] [CAST] target is a Pet (destUnitFlags 0x1000)', () => {
    const PET_FLAGS = 0x00001000;
    // Use spell ID '1' (not in spellEffectData → no CD → stays [YOU] [CAST], not B38-promoted)
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: {
          ...makeOwner('Feramonk'),
          spellCastEvents: [makeSpellCastEvent('1', 30_000, 'pet-1', 'Fluffy', 'player-1', 'Feramonk', PET_FLAGS)],
        } as any,
      }),
    );
    expect(result).toContain('[YOU] [CAST]');
    expect(result).toContain('[totem/pet]');
  });

  // B44: Grounding Totem absorption
  it('B44: emits [absorbed: Grounding Totem] instead of [totem/pet] when destUnitName is Grounding Totem', () => {
    const GUARDIAN_FLAGS = 0x00002000;
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: {
          ...makeOwner('Feramonk'),
          spellCastEvents: [
            makeSpellCastEvent('88625', 30_000, 'totem-2', 'Grounding Totem', 'player-1', 'Feramonk', GUARDIAN_FLAGS),
          ],
        } as any,
      }),
    );
    expect(result).toContain('[absorbed: Grounding Totem]');
    expect(result).not.toContain('[totem/pet]');
  });

  it('B44: [YOU] [CD] also carries totemNote when dest is a Guardian', () => {
    // Spell ID '108280' = Healing Tide Totem — has CD ≥ 30s → promoted to [YOU] [CD] via B38
    const GUARDIAN_FLAGS = 0x00002000;
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: {
          ...makeOwner('Feramonk'),
          spellCastEvents: [
            makeSpellCastEvent('108280', 30_000, 'totem-3', 'Tremor Totem', 'player-1', 'Feramonk', GUARDIAN_FLAGS),
          ],
        } as any,
        ownerCDs: [],
      }),
    );
    expect(result).toContain('[YOU] [CD]');
    expect(result).toContain('[totem/pet]');
  });
});

describe('buildMatchTimeline — F95 [YOU] [CC]', () => {
  it('emits [YOU] [CC] for offensive CC casts by the owner when isHealer=true', () => {
    // Mind Control = spellId 605
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('605', 10000, 'enemy-1', 'Natjkis')],
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [makeCD('Psychic Scream', 40)],
        matchStartMs: 0,
        matchEndMs: 60000,
      }),
    );
    expect(result).toContain('[YOU] [CC]');
    expect(result).toContain('Mind Control');
    expect(result).toContain('0:10');
    expect(result).toContain('[RES]');
  });

  it('emits [YOU] [CC] for Hex (30s CD) even though it would normally be promoted to [YOU] [CD]', () => {
    // Hex = spellId 51514, CD 30s
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('51514', 10000, 'enemy-1', 'Natjkis')],
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [makeCD('Healing Stream Totem', 30)],
        matchStartMs: 0,
        matchEndMs: 60000,
      }),
    );
    expect(result).toContain('[YOU] [CC]');
    expect(result).not.toContain('[YOU] [CD]   Hex');
    expect(result).toContain('Hex');
  });

  it('does NOT emit [YOU] [CC] for non-healers (currently scoped to healer gap-filler)', () => {
    const owner = makeUnit('unit-1', {
      name: 'Feramonk',
      spellCastEvents: [makeSpellCastEvent('605', 10000, 'enemy-1', 'Natjkis')],
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: false,
        matchStartMs: 0,
        matchEndMs: 60000,
      }),
    );
    expect(result).not.toContain('[YOU] [CC]');
  });

  it('emits [YOU] [CC] for a major CC in ownerCDs (e.g. Psychic Scream)', () => {
    const owner = makeUnit('unit-1', { name: 'Feramonk' });
    const screamCD: IMajorCooldownInfo = {
      spellId: '8122',
      spellName: 'Psychic Scream',
      tag: 'Control',
      cooldownSeconds: 60,
      maxChargesDetected: 1,
      casts: [{ timeSeconds: 20 }],
      availableWindows: [],
      neverUsed: false,
    };
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        ownerCDs: [screamCD],
      }),
    );
    expect(result).toContain('[YOU] [CC]');
    expect(result).toContain('Psychic Scream');
  });

  it('emits [TEAM] [CC] for a major CC in teammateCDs (e.g. Hammer of Justice)', () => {
    const teammate = makeUnit('unit-2', { name: 'Simplesauce' });
    const hojCD: IMajorCooldownInfo = {
      spellId: '853',
      spellName: 'Hammer of Justice',
      tag: 'Control',
      cooldownSeconds: 60,
      maxChargesDetected: 1,
      casts: [{ timeSeconds: 30 }],
      availableWindows: [],
      neverUsed: false,
    };
    const result = buildMatchTimeline(
      makeBaseParams({
        teammateCDs: [{ player: teammate, spec: 'Holy Paladin', cds: [hojCD] }],
      }),
    );
    expect(result).toContain('[TEAM] [CC]');
    expect(result).toContain('Hammer of Justice');
  });
});

describe('buildMatchTimeline — F62 dense HP ticks in critical windows', () => {
  function makeUnitWithHp(
    id: string,
    name: string,
    matchStartMs: number,
    hpReadings: Array<[number, number]>,
  ): ICombatUnit {
    return makeUnit(id, {
      name,
      advancedActions: hpReadings.map(([offsetMs, currentHp]) =>
        makeAdvancedAction(offsetMs, 0, 0, 500_000, currentHp),
      ),
    }) as ICombatUnit;
  }

  it('emits 1s HP ticks in [T-10, T] window before a friendly DEATH', () => {
    // Death at T=30s; match 0–45s. Dense window: [20, 30].
    const unit = makeUnitWithHp('unit-1', 'Feramonk', 0, [
      [1_000, 400_000], // t=1s
      [20_000, 350_000], // t=20s → covers t=19–21
      [22_000, 300_000], // t=22s → covers t=21–23
      [24_000, 250_000], // t=24s → covers t=23–25
      [25_000, 200_000], // t=25s
      [30_000, 50_000], // t=30s → covers t=29–31
    ]);
    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [unit],
        friendlyDeaths: [{ spec: 'Mistweaver Monk', name: 'Feramonk', atSeconds: 30 }],
        matchStartMs: 0,
        matchEndMs: 45_000,
      }),
    );
    // Under delta-gated noise reduction, stable HP ticks are suppressed.
    // HP changes by 10% at t=20, 22, 24, 25, 29.
    expect(result).toContain('0:20');
    expect(result).toContain('0:22');
    expect(result).toContain('0:24');
    expect(result).toContain('0:25');
    expect(result).toContain('0:29');
    expect(result).not.toContain('0:21');
    expect(result).not.toContain('0:23');
    // T=19 is NOT in the dense window (window starts at 20) — should NOT appear as an [HP] tick
    // (T=18 would be a 3s baseline tick, T=19 should not)
    const lines = result.split('\n');
    const hp19Line = lines.find((l) => l.startsWith('0:19') && l.includes('[STATE]'));
    expect(hp19Line).toBeUndefined();
  });

  it.skip('emits 1s HP ticks centered around a DMG SPIKE (±5s)', () => {
    // Spike at T=20s (fromSeconds=20); dense window: [15, 25].
    const unit = makeUnitWithHp('unit-1', 'Feramonk', 0, [
      [12_000, 480_000], // t=12s
      [15_000, 430_000], // t=15s → covers t=14–16
      [18_000, 350_000], // t=18s → covers t=17–19
      [22_000, 250_000], // t=22s
    ]);
    const spike: IDamageBucket = {
      fromSeconds: 20,
      toSeconds: 25,
      totalDamage: 400_000,
      targetName: 'Feramonk',
      targetSpec: 'Mistweaver Monk',
    };
    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [unit],
        pressureWindows: [spike],
        matchStartMs: 0,
        matchEndMs: 45_000,
      }),
    );
    // Should have 1s ticks in [15, 25]
    expect(result).toContain('0:15');
    expect(result).toContain('0:16');
    expect(result).toContain('0:17');
    expect(result).toContain('0:18');
    // T=14 should NOT be a 1s tick (it's not at a 3s multiple either: 14 % 3 ≠ 0)
    const lines = result.split('\n');
    const hp14Line = lines.find((l) => l.startsWith('0:14') && l.includes('[STATE]'));
    expect(hp14Line).toBeUndefined();
    // T=12 IS a 3s baseline tick
    const hp12Line = lines.find((l) => l.startsWith('0:12') && l.includes('[STATE]'));
    expect(hp12Line).toBeDefined();
  });

  it('emits 1s HP ticks in [T, T+10] lookahead window after CC ON TEAM', () => {
    // CC at T=15s; dense window: [15, 25].
    const unit = makeUnitWithHp('unit-1', 'Feramonk', 0, [
      [12_000, 480_000],
      [15_000, 430_000], // t=15s → covers t=14–16
      [18_000, 350_000],
      [24_000, 250_000],
    ]);
    const cc: ICCInstance = {
      atSeconds: 15,
      spellName: 'Cyclone',
      spellId: '33786',
      durationSeconds: 6,
      sourceName: 'Dzinked',
      sourceSpec: 'Balance Druid',
      damageTakenDuring: 0,
      trinketState: 'available_unused',
      drInfo: null,
      distanceYards: null,
      losBlocked: null,
    };
    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [unit],
        ccTrinketSummaries: [{ ...makeEmptyCCTrinketSummary('Feramonk'), ccInstances: [cc] }],
        matchStartMs: 0,
        matchEndMs: 45_000,
      }),
    );
    // Under delta-gated noise reduction, stable HP ticks are suppressed.
    // HP changes at t=15 (CC cast - key moment), t=17 (70% - delta), t=23 (50% - delta).
    expect(result).toContain('0:15');
    expect(result).toContain('0:17');
    expect(result).toContain('0:23');
    expect(result).not.toContain('0:16');
    // T=14 is not in window and not a 3s multiple
    const lines = result.split('\n');
    const hp14Line = lines.find((l) => l.startsWith('0:14') && l.includes('[STATE]'));
    expect(hp14Line).toBeUndefined();
  });

  it('does not emit duplicate HP ticks when windows overlap', () => {
    // DEATH at T=30, DMG SPIKE at T=26 → windows [20,30] and [21,31] overlap in [21,30].
    const unit = makeUnitWithHp('unit-1', 'Feramonk', 0, [
      [20_000, 350_000],
      [26_000, 200_000],
      [30_000, 50_000],
    ]);
    const spike: IDamageBucket = {
      fromSeconds: 26,
      toSeconds: 31,
      totalDamage: 500_000,
      targetName: 'Feramonk',
      targetSpec: 'Mistweaver Monk',
    };
    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [unit],
        friendlyDeaths: [{ spec: 'Mistweaver Monk', name: 'Feramonk', atSeconds: 30 }],
        pressureWindows: [spike],
        matchStartMs: 0,
        matchEndMs: 45_000,
      }),
    );
    // Count occurrences of '0:25' in [STATE] lines — should be exactly 1
    const lines = result.split('\n').filter((l) => l.includes('[STATE]') && l.startsWith('0:25'));
    expect(lines.length).toBe(1);
  });

  it.skip('outside all critical windows, only emits HP ticks at 3s multiples', () => {
    // Match 0–45s, no deaths/spikes/CC. Only 3s ticks should appear.
    const unit = makeUnitWithHp('unit-1', 'Feramonk', 0, [
      [3_000, 480_000],
      [6_000, 460_000],
      [9_000, 440_000],
      [12_000, 420_000],
    ]);
    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [unit],
        matchStartMs: 0,
        matchEndMs: 15_000,
      }),
    );
    // T=1,2,4,5,7,8,10,11 should NOT have [HP] lines
    const lines = result.split('\n');
    for (const nonMultiple of [1, 2, 4, 5, 7, 8, 10, 11]) {
      const ts = `0:0${nonMultiple}`;
      const found = lines.find((l) => l.startsWith(ts) && l.includes('[STATE]'));
      expect(found).toBeUndefined();
    }
    // T=3,6,9,12 SHOULD have [HP] lines
    expect(result).toContain('0:03');
    expect(result).toContain('0:06');
    expect(result).toContain('0:09');
    expect(result).toContain('0:12');
  });
});

describe('buildMatchTimeline — F64 enemy HP in [HP] ticks', () => {
  it('includes friendly and enemy HP in a single [STATE] line during a critical window', () => {
    const matchStartMs = 0;

    const friend = makeUnit('unit-1', {
      name: 'Feramonk',
      advancedActions: [
        makeAdvancedAction(6_000, 0, 0, 500_000, 450_000), // 90% at t=6s
      ],
    }) as ICombatUnit;

    // advancedActorId must match the unit's id for getUnitHpAtTimestamp to pick it up
    const enemy = makeUnit('enemy-1', {
      name: 'Natjkis',
      reaction: CombatUnitReaction.Hostile,
      advancedActions: [
        { ...makeAdvancedAction(6_000, 0, 0, 500_000, 175_000), advancedActorId: 'enemy-1' }, // 35% at t=6s
      ],
    }) as ICombatUnit;

    // Enemy death at t=10s creates a critical window [0, 10] that covers t=6s
    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [friend],
        enemies: [enemy],
        enemyDeaths: [{ spec: 'Affliction Warlock', name: 'Natjkis', atSeconds: 10 }],
        matchStartMs,
        matchEndMs: 12_000,
      }),
    );

    // Both friend and enemy appear in [STATE] lines during critical window
    const stateLines = result.split('\n').filter((l) => l.includes('[STATE]'));
    expect(stateLines.some((l) => l.includes('Feramonk:90'))).toBeTruthy();
    expect(stateLines.some((l) => l.includes('Natjkis:35'))).toBeTruthy();
    // Enemy appears after '/ enemies', not in the friends section.
    // Lines that contain only an enemies section (no '/ enemies' separator) are enemies-only
    // and don't have a friends section to check — skip them.
    for (const line of stateLines.filter((l) => l.includes('Natjkis') && l.includes('/ enemies'))) {
      const friendsPart = line.split('/ enemies')[0];
      expect(friendsPart).not.toContain('Natjkis');
    }
  });

  it('adds 1s dense ticks in [T-10, T] window before an enemy death', () => {
    const matchStartMs = 0;

    const enemy = makeUnit('enemy-1', {
      name: 'Natjkis',
      reaction: CombatUnitReaction.Hostile,
      advancedActions: [
        { ...makeAdvancedAction(51_000, 0, 0, 500_000, 100_000), advancedActorId: 'enemy-1' }, // 20% at t=51s
        { ...makeAdvancedAction(53_000, 0, 0, 500_000, 65_000), advancedActorId: 'enemy-1' }, // 13% at t=53s
        { ...makeAdvancedAction(55_000, 0, 0, 500_000, 25_000), advancedActorId: 'enemy-1' }, // 5% at t=55s
      ],
    }) as ICombatUnit;

    const result = buildMatchTimeline(
      makeBaseParams({
        enemies: [enemy],
        enemyDeaths: [{ spec: 'Affliction Warlock', name: 'Natjkis', atSeconds: 60 }],
        matchStartMs,
        matchEndMs: 65_000,
      }),
    );

    // Dense window [50, 60] — expect consecutive 1s ticks on [STATE] lines with enemies
    const enemyHpLines = result.split('\n').filter((l) => l.includes('[STATE]') && l.includes('enemies'));
    const tickSeconds = enemyHpLines
      .map((l) => {
        const m = l.match(/^(\d+):(\d+)/);
        return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : null;
      })
      .filter((t): t is number => t !== null);
    const inDenseWindow = tickSeconds.filter((t) => t >= 50 && t <= 60);
    // Under delta-gated noise reduction, stable HP ticks are suppressed.
    // HP changes at t=50 (20%), t=55 (5%), and t=60 (death key moment).
    expect(inDenseWindow).toEqual([50, 55, 60]);
  });
});

// ── buildMatchTimeline — [CC CAST] events ─────────────────────────────────────

describe('buildMatchTimeline — [CC CAST] events', () => {
  function makeAoeCCChain(
    targetName: string,
    casterName: string,
    spellId: string,
    spellName: string,
    atSeconds: number,
    durationSeconds: number,
  ): IOutgoingCCChain {
    return {
      targetName,
      targetSpec: 'Shadow Priest',
      applications: [
        {
          atSeconds,
          durationSeconds,
          spellId,
          spellName,
          casterName,
          casterSpec: 'Holy Priest',
          drInfo: { category: 'Disorient', level: 'Full' as const, sequenceIndex: 0 },
        },
      ],
      hasWastedApplications: false,
    };
  }

  it('emits nothing when outgoingCCChains is not provided', () => {
    const result = buildMatchTimeline(makeBaseParams());
    expect(result).not.toContain('[CC CAST]');
  });

  it('emits nothing when outgoingCCChains is empty', () => {
    const result = buildMatchTimeline(makeBaseParams({ outgoingCCChains: [] }));
    expect(result).not.toContain('[CC CAST]');
  });

  it('does not emit [CC CAST] for single-target CC (Cyclone 33786)', () => {
    const chains: IOutgoingCCChain[] = [makeAoeCCChain('EnemyA', 'Feramonk', '33786', 'Cyclone', 21, 6)];
    const result = buildMatchTimeline(makeBaseParams({ outgoingCCChains: chains }));
    expect(result).not.toContain('[CC CAST]');
  });

  it('emits [CC CAST] for Psychic Scream hitting 1 enemy (whitelisted AoE spell)', () => {
    const chains: IOutgoingCCChain[] = [makeAoeCCChain('EnemyA', 'Feramonk', '8122', 'Psychic Scream', 21, 8)];
    const result = buildMatchTimeline(makeBaseParams({ outgoingCCChains: chains }));
    expect(result).toContain('[CC CAST]');
    expect(result).toContain('Psychic Scream');
    expect(result).toContain('0:21');
  });

  it('emits [CC CAST] for Psychic Scream hitting 2 enemies, listing both targets and count', () => {
    const chains: IOutgoingCCChain[] = [
      makeAoeCCChain('EnemyA', 'Feramonk', '8122', 'Psychic Scream', 21, 8),
      makeAoeCCChain('EnemyB', 'Feramonk', '8122', 'Psychic Scream', 21, 8),
    ];
    const result = buildMatchTimeline(makeBaseParams({ outgoingCCChains: chains }));
    expect(result).toContain('[CC CAST]');
    expect(result).toContain('EnemyA');
    expect(result).toContain('EnemyB');
    expect(result).toContain('[2 enemies]');
  });

  it('emits one [CC CAST] line per cast event, not per target', () => {
    const chains: IOutgoingCCChain[] = [
      makeAoeCCChain('EnemyA', 'Feramonk', '8122', 'Psychic Scream', 21, 8),
      makeAoeCCChain('EnemyB', 'Feramonk', '8122', 'Psychic Scream', 21, 8),
      makeAoeCCChain('EnemyC', 'Feramonk', '8122', 'Psychic Scream', 21, 8),
    ];
    const result = buildMatchTimeline(makeBaseParams({ outgoingCCChains: chains }));
    const castLines = result.split('\n').filter((l) => l.includes('[CC CAST]'));
    expect(castLines).toHaveLength(1);
    expect(result).toContain('[3 enemies]');
  });

  it('uses enemyPid to compress enemy target names when idMaps are provided', () => {
    const chains: IOutgoingCCChain[] = [makeAoeCCChain('EnemyA', 'Feramonk', '8122', 'Psychic Scream', 21, 8)];
    const playerIdMap = new Map([['Feramonk', 1]]);
    const enemyIdMap = new Map([['EnemyA', 4]]);
    const result = buildMatchTimeline(makeBaseParams({ outgoingCCChains: chains, playerIdMap, enemyIdMap }));
    expect(result).toContain('[CC CAST]');
    expect(result).toContain('4');
  });

  it('emits separate [CC CAST] lines for separate casts of same spell (> 0.5s apart)', () => {
    const chains: IOutgoingCCChain[] = [
      makeAoeCCChain('EnemyA', 'Feramonk', '8122', 'Psychic Scream', 21, 8),
      makeAoeCCChain('EnemyA', 'Feramonk', '8122', 'Psychic Scream', 45, 8),
    ];
    const result = buildMatchTimeline(makeBaseParams({ outgoingCCChains: chains }));
    const castLines = result.split('\n').filter((l) => l.includes('[CC CAST]'));
    expect(castLines).toHaveLength(2);
  });

  // B105: CC targeting non-player units should be suppressed
  it('B105: does NOT emit [CC CAST] when a friendly player CCs a Guardian unit (suppress noise)', () => {
    const GUARDIAN_FLAGS = 0x00002000;
    // Spell 118 = Polymorph — a CC spell in ccSpellIds
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: {
          ...makeOwner('Feramonk'),
          spellCastEvents: [
            makeSpellCastEvent('118', 30_000, 'totem-99', 'Tremor Totem', 'player-1', 'Feramonk', GUARDIAN_FLAGS),
          ],
        } as any,
      }),
    );
    expect(result).not.toContain('[CC CAST]');
    expect(result).not.toContain('[non-player target]');
  });

  it('B46/B105: does NOT emit [non-player target] for CC cast on an enemy player', () => {
    // Spell 118 = Polymorph, targeting a player (no guardian flags)
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: {
          ...makeOwner('Feramonk'),
          spellCastEvents: [
            makeSpellCastEvent('118', 30_000, 'enemy-1', 'EnemyPlayer', 'player-1', 'Feramonk', 0x0511),
          ],
        } as any,
        outgoingCCChains: [],
      }),
    );
    // Should not appear in [CC CAST] at all (that path belongs to outgoingCCChains for player targets)
    const nonPlayerLines = result.split('\n').filter((l) => l.includes('[non-player target]'));
    expect(nonPlayerLines).toHaveLength(0);
  });

  it('B46/B105: does NOT emit [CC CAST] for non-CC spells cast at a Guardian', () => {
    const GUARDIAN_FLAGS = 0x00002000;
    // Spell ID '1' is not a CC spell
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: {
          ...makeOwner('Feramonk'),
          spellCastEvents: [
            makeSpellCastEvent('1', 30_000, 'totem-99', 'Tremor Totem', 'player-1', 'Feramonk', GUARDIAN_FLAGS),
          ],
        } as any,
      }),
    );
    const nonPlayerLines = result.split('\n').filter((l) => l.includes('[non-player target]'));
    expect(nonPlayerLines).toHaveLength(0);
  });
});

// ── buildMatchTimeline — F67 [ENEMY BUFFS] line ──────────────────────────────

describe('buildMatchTimeline — F67 [ENEMY BUFFS]', () => {
  function makeEnemyWithAura(
    id: string,
    name: string,
    spellId: string,
    appliedMs: number,
    removedMs: number,
  ): ICombatUnit {
    return makeUnit(id, {
      name,
      reaction: CombatUnitReaction.Hostile,
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, spellId, appliedMs, 'src-1', id),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, spellId, removedMs, 'src-1', id),
      ],
    });
  }

  it('emits [ENEMY BUFF] and [ENEMY BUFF END] when enemy has Power Infusion active', () => {
    // PI active on Natjkis from 20s to 40s; owner CD cast at 30s
    const enemy = makeEnemyWithAura('enemy-1', 'Natjkis', '10060', 20_000, 40_000);
    const result = buildMatchTimeline(
      makeBaseParams({
        enemies: [enemy],
        matchStartMs: 0,
        matchEndMs: 60_000,
        ownerCDs: [
          {
            spellId: '33206',
            spellName: 'Pain Suppression',
            tag: 'Defensive',
            cooldownSeconds: 180,
            maxChargesDetected: 1,
            casts: [{ timeSeconds: 30 }],
            availableWindows: [],
            neverUsed: false,
          },
        ],
      }),
    );
    expect(result).toContain('[ENEMY BUFF]');
    expect(result).toContain('[ENEMY BUFF END]');
    expect(result).toContain('Power Infusion');
    expect(result).not.toContain('[ENEMY BUFFS]');
  });

  it('marks Power Infusion as purgeable in [ENEMY BUFF] event', () => {
    const enemy = makeEnemyWithAura('enemy-1', 'Natjkis', '10060', 20_000, 40_000);
    const result = buildMatchTimeline(
      makeBaseParams({
        enemies: [enemy],
        matchStartMs: 0,
        matchEndMs: 60_000,
        ownerCDs: [
          {
            spellId: '33206',
            spellName: 'Pain Suppression',
            tag: 'Defensive',
            cooldownSeconds: 180,
            maxChargesDetected: 1,
            casts: [{ timeSeconds: 30 }],
            availableWindows: [],
            neverUsed: false,
          },
        ],
      }),
    );
    const buffLine = result.split('\n').find((l) => l.includes('[ENEMY BUFF]') && !l.includes('[ENEMY BUFF END]'));
    expect(buffLine).toBeDefined();
    expect(buffLine).toContain('purgeable');
  });

  it('emits [ENEMY BUFF] / [ENEMY BUFF END] even when only [TEAMMATE CD] is cast', () => {
    const enemy = makeEnemyWithAura('enemy-1', 'Natjkis', '10060', 20_000, 40_000);
    const result = buildMatchTimeline(
      makeBaseParams({
        enemies: [enemy],
        matchStartMs: 0,
        matchEndMs: 60_000,
        teammateCDs: [
          {
            player: makeOwner('Simplesauce'),
            spec: 'Unholy Death Knight',
            cds: [
              {
                spellId: '48707',
                spellName: 'Anti-Magic Shell',
                tag: 'Defensive',
                cooldownSeconds: 60,
                maxChargesDetected: 1,
                casts: [{ timeSeconds: 25 }],
                availableWindows: [],
                neverUsed: false,
              },
            ],
          },
        ],
      }),
    );
    expect(result).toContain('[ENEMY BUFF]');
    expect(result).toContain('[ENEMY BUFF END]');
    expect(result).toContain('Power Infusion');
    expect(result).not.toContain('[ENEMY BUFFS]');
  });

  it('emits [ENEMY BUFF] and [ENEMY BUFF END] even when buff expires before snapshot CD time', () => {
    // PI active 20–40s, owner CD at 50s (after PI expired)
    // Events-based format shows both start and end regardless of snapshot timing
    const enemy = makeEnemyWithAura('enemy-1', 'Natjkis', '10060', 20_000, 40_000);
    const result = buildMatchTimeline(
      makeBaseParams({
        enemies: [enemy],
        matchStartMs: 0,
        matchEndMs: 60_000,
        ownerCDs: [
          {
            spellId: '33206',
            spellName: 'Pain Suppression',
            tag: 'Defensive',
            cooldownSeconds: 180,
            maxChargesDetected: 1,
            casts: [{ timeSeconds: 50 }],
            availableWindows: [],
            neverUsed: false,
          },
        ],
      }),
    );
    expect(result).not.toContain('[ENEMY BUFFS]');
    expect(result).toContain('[ENEMY BUFF]');
    expect(result).toContain('[ENEMY BUFF END]');
  });

  it('does NOT emit [ENEMY BUFFS] when enemies array is empty', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        enemies: [],
        matchStartMs: 0,
        matchEndMs: 60_000,
        ownerCDs: [
          {
            spellId: '33206',
            spellName: 'Pain Suppression',
            tag: 'Defensive',
            cooldownSeconds: 180,
            maxChargesDetected: 1,
            casts: [{ timeSeconds: 30 }],
            availableWindows: [],
            neverUsed: false,
          },
        ],
      }),
    );
    expect(result).not.toContain('[ENEMY BUFFS]');
    expect(result).not.toContain('[ENEMY BUFF]');
    expect(result).not.toContain('[ENEMY BUFF END]');
  });

  it('does NOT emit [ENEMY BUFFS] for untracked spell IDs (e.g. Bloodlust 2825 is not logged as aura on enemies)', () => {
    // Bloodlust (2825) and other mass-buff effects do not generate SPELL_AURA_APPLIED on
    // enemy team members in WoW combat logs — only targeted externals like PI do.
    const enemy = makeEnemyWithAura('enemy-1', 'Natjkis', '2825', 20_000, 40_000);
    const result = buildMatchTimeline(
      makeBaseParams({
        enemies: [enemy],
        matchStartMs: 0,
        matchEndMs: 60_000,
        ownerCDs: [
          {
            spellId: '33206',
            spellName: 'Pain Suppression',
            tag: 'Defensive',
            cooldownSeconds: 180,
            maxChargesDetected: 1,
            casts: [{ timeSeconds: 30 }],
            availableWindows: [],
            neverUsed: false,
          },
        ],
      }),
    );
    expect(result).not.toContain('[ENEMY BUFFS]');
    expect(result).not.toContain('[ENEMY BUFF]');
    expect(result).not.toContain('[ENEMY BUFF END]');
  });

  it('emits [ENEMY BUFF] at start time and [ENEMY BUFF END] at end time', () => {
    // PI active 20–50s; [ENEMY BUFF] appears at 0:20, [ENEMY BUFF END] at 0:50
    const enemy = makeEnemyWithAura('enemy-1', 'Natjkis', '10060', 20_000, 50_000);
    const result = buildMatchTimeline(
      makeBaseParams({
        enemies: [enemy],
        matchStartMs: 0,
        matchEndMs: 60_000,
        ownerCDs: [
          {
            spellId: '33206',
            spellName: 'Pain Suppression',
            tag: 'Defensive',
            cooldownSeconds: 180,
            maxChargesDetected: 1,
            casts: [{ timeSeconds: 30 }],
            availableWindows: [],
            neverUsed: false,
          },
        ],
      }),
    );
    const buffLine = result.split('\n').find((l) => l.includes('[ENEMY BUFF]') && !l.includes('[ENEMY BUFF END]'));
    const buffEndLine = result.split('\n').find((l) => l.includes('[ENEMY BUFF END]'));
    expect(buffLine).toBeDefined();
    expect(buffLine).toContain('0:20');
    expect(buffEndLine).toBeDefined();
    expect(buffEndLine).toContain('0:50');
  });

  it('uses numeric enemy ID in [ENEMY BUFF] event when enemyIdMap is provided', () => {
    const enemy = makeEnemyWithAura('enemy-1', 'Natjkis', '10060', 20_000, 40_000);
    const playerIdMap = new Map([['Feramonk', 1]]);
    const enemyIdMap = new Map([['Natjkis', 3]]);
    const result = buildMatchTimeline(
      makeBaseParams({
        enemies: [enemy],
        matchStartMs: 0,
        matchEndMs: 60_000,
        playerIdMap,
        enemyIdMap,
        ownerCDs: [
          {
            spellId: '33206',
            spellName: 'Pain Suppression',
            tag: 'Defensive',
            cooldownSeconds: 180,
            maxChargesDetected: 1,
            casts: [{ timeSeconds: 30 }],
            availableWindows: [],
            neverUsed: false,
          },
        ],
      }),
    );
    expect(result).toContain('[ENEMY BUFF]');
    expect(result).toContain('[ENEMY BUFF END]');
    expect(result).not.toContain('[ENEMY BUFFS]');
    // numeric ID '3' should appear in the [ENEMY BUFF] line
    const buffLine = result.split('\n').find((l) => l.includes('[ENEMY BUFF]') && !l.includes('[ENEMY BUFF END]'));
    expect(buffLine).toBeDefined();
    expect(buffLine).toContain('3');
  });
});

// ── buildMatchTimeline — [ENEMY BUFF] events ──────────────────────────────────

describe('buildMatchTimeline — [ENEMY BUFF] events', () => {
  it('emits [ENEMY BUFF] at buff start and [ENEMY BUFF END] at buff end', () => {
    const matchStartMs = 1_000_000;
    const matchEndMs = matchStartMs + 60_000;

    const enemy = makeUnit('enemy-1', {
      name: 'Dzinked',
      reaction: CombatUnitReaction.Hostile,
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '10060', matchStartMs + 23_000, 'healer-1', 'enemy-1'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '10060', matchStartMs + 43_000, 'healer-1', 'enemy-1'),
      ],
    });

    const result = buildMatchTimeline(
      makeBaseParams({
        enemies: [enemy],
        matchStartMs,
        matchEndMs,
      }),
    );

    expect(result).toContain('[ENEMY BUFF]');
    expect(result).toContain('[ENEMY BUFF END]');
    expect(result).toContain('Power Infusion');
    expect(result).not.toContain('[ENEMY BUFFS]');
  });

  it('does NOT repeat buff info on every [RES] snapshot during the buff window', () => {
    const matchStartMs = 1_000_000;
    const matchEndMs = matchStartMs + 60_000;

    const enemy = makeUnit('enemy-1', {
      name: 'Dzinked',
      reaction: CombatUnitReaction.Hostile,
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '10060', matchStartMs + 5_000, 'healer-1', 'enemy-1'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '10060', matchStartMs + 55_000, 'healer-1', 'enemy-1'),
      ],
    });

    const ownerCDs: IMajorCooldownInfo[] = [
      {
        spellId: '31884',
        spellName: 'Avenging Wrath',
        tag: 'Offensive',
        cooldownSeconds: 120,
        maxChargesDetected: 1,
        casts: [{ timeSeconds: 10 }],
        availableWindows: [],
        neverUsed: false,
      },
      {
        spellId: '6940',
        spellName: 'Blessing of Sacrifice',
        tag: 'Defensive',
        cooldownSeconds: 120,
        maxChargesDetected: 1,
        casts: [{ timeSeconds: 20 }],
        availableWindows: [],
        neverUsed: false,
      },
    ];

    const result = buildMatchTimeline(
      makeBaseParams({
        enemies: [enemy],
        ownerCDs,
        matchStartMs,
        matchEndMs,
      }),
    );

    const buffCount = (result.match(/\[ENEMY BUFF\]/g) ?? []).length;
    const buffEndCount = (result.match(/\[ENEMY BUFF END\]/g) ?? []).length;
    expect(buffCount).toBe(1);
    expect(buffEndCount).toBe(1);
    expect(result).not.toContain('[ENEMY BUFFS]');
    expect(result).not.toContain('[RESOURCES]');
    expect(result).toContain('[RES]');
  });
});

describe('buildMatchTimeline — F68 cast/CC disambiguation', () => {
  // Holy Shock (20473) has a 6s cooldown in spellEffectData — well below the 30s B38 threshold,
  // so it stays as [YOU] [CAST]. Holy Prism's 45s CD now B38-promotes to [YOU] [CD].
  const HEALER_SPELL_ID = '20473'; // Holy Shock (CD 6s — stays [YOU] [CAST]; Holy Prism's 45s CD now B38-promotes to [YOU] [CD])
  const MATCH_START_MS = 1_000_000;

  function makeOwnerWithCast(castTimestampMs: number): ICombatUnit {
    return {
      ...makeOwner('Feramonk'),
      spellCastEvents: [
        makeSpellCastEvent(HEALER_SPELL_ID, castTimestampMs, 'player-2', 'Simplesauce', 'player-1', 'Feramonk'),
      ],
    } as ICombatUnit;
  }

  function makeCCSummary(ccAtMs: number): IPlayerCCTrinketSummary {
    const cc: ICCInstance = {
      atSeconds: (ccAtMs - MATCH_START_MS) / 1000,
      durationSeconds: 4,
      spellId: '107570',
      spellName: 'Storm Bolt',
      sourceName: 'EnemyPlayer',
      sourceSpec: 'Arms Warrior',
      damageTakenDuring: 50_000,
      trinketState: 'available_unused',
      drInfo: null,
      distanceYards: null,
      losBlocked: null,
    };
    return { ...makeEmptyCCTrinketSummary('Feramonk'), ccInstances: [cc] };
  }

  it('annotates [YOU] [CAST] with [completed before CC landed] when cast ms < CC ms in same second', () => {
    // cast at 21.100s, CC at 21.700s — both display as 0:21
    const castMs = MATCH_START_MS + 21_100;
    const ccMs = MATCH_START_MS + 21_700;
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: makeOwnerWithCast(castMs),
        isHealer: true,
        matchStartMs: MATCH_START_MS,
        matchEndMs: MATCH_START_MS + 30_000,
        ccTrinketSummaries: [makeCCSummary(ccMs)],
      }),
    );
    const castLine = result.split('\n').find((l) => l.includes('[YOU] [CAST]') && l.includes('Holy Shock'));
    expect(castLine).toBeDefined();
    expect(castLine).toContain('[completed before CC landed]');
  });

  it('annotates [YOU] [CAST] with [succeeded after CC arrived] when cast ms > CC ms in same second', () => {
    // CC at 21.100s, cast at 21.800s — both display as 0:21
    const ccMs = MATCH_START_MS + 21_100;
    const castMs = MATCH_START_MS + 21_800;
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: makeOwnerWithCast(castMs),
        isHealer: true,
        matchStartMs: MATCH_START_MS,
        matchEndMs: MATCH_START_MS + 30_000,
        ccTrinketSummaries: [makeCCSummary(ccMs)],
      }),
    );
    const castLine = result.split('\n').find((l) => l.includes('[YOU] [CAST]') && l.includes('Holy Shock'));
    expect(castLine).toBeDefined();
    expect(castLine).toContain('[succeeded after CC arrived — within 1s in log]');
  });

  it('annotates [YOU] [CAST] with [same server tick as CC] when cast ms === CC ms', () => {
    const sharedMs = MATCH_START_MS + 21_500;
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: makeOwnerWithCast(sharedMs),
        isHealer: true,
        matchStartMs: MATCH_START_MS,
        matchEndMs: MATCH_START_MS + 30_000,
        ccTrinketSummaries: [makeCCSummary(sharedMs)],
      }),
    );
    const castLine = result.split('\n').find((l) => l.includes('[YOU] [CAST]') && l.includes('Holy Shock'));
    expect(castLine).toBeDefined();
    expect(castLine).toContain('[same server tick as CC — cast succeeded per log]');
  });

  it('does not annotate [YOU] [CAST] when cast and CC are more than 1s apart', () => {
    // cast at 21.000s (0:21), CC at 23.000s (0:23) — 2s apart, outside ±1000ms proximity window
    const castMs = MATCH_START_MS + 21_000;
    const ccMs = MATCH_START_MS + 23_000;
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: makeOwnerWithCast(castMs),
        isHealer: true,
        matchStartMs: MATCH_START_MS,
        matchEndMs: MATCH_START_MS + 30_000,
        ccTrinketSummaries: [makeCCSummary(ccMs)],
      }),
    );
    const castLine = result.split('\n').find((l) => l.includes('[YOU] [CAST]') && l.includes('Holy Shock'));
    expect(castLine).toBeDefined();
    expect(castLine).not.toContain('[completed before');
    expect(castLine).not.toContain('[succeeded after');
    expect(castLine).not.toContain('[same server tick');
  });

  it('does not annotate [YOU] [CAST] when there are no CC events', () => {
    const castMs = MATCH_START_MS + 21_500;
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: makeOwnerWithCast(castMs),
        isHealer: true,
        matchStartMs: MATCH_START_MS,
        matchEndMs: MATCH_START_MS + 30_000,
        ccTrinketSummaries: [],
      }),
    );
    const castLine = result.split('\n').find((l) => l.includes('[YOU] [CAST]') && l.includes('Holy Shock'));
    expect(castLine).toBeDefined();
    expect(castLine).not.toContain('[completed before');
    expect(castLine).not.toContain('[succeeded after');
    expect(castLine).not.toContain('[same server tick');
  });

  it('annotates [YOU] [CAST] with [completed before CC landed] when cast is in second N and CC is at start of second N+1 (boundary case)', () => {
    // cast at 21.950s (displayed 0:21), CC at 22.050s (displayed 0:22)
    // 100ms apart — should annotate even though displayed seconds differ
    const castMs = MATCH_START_MS + 21_950;
    const ccMs = MATCH_START_MS + 22_050;
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: makeOwnerWithCast(castMs),
        isHealer: true,
        matchStartMs: MATCH_START_MS,
        matchEndMs: MATCH_START_MS + 30_000,
        ccTrinketSummaries: [makeCCSummary(ccMs)],
      }),
    );
    const castLine = result.split('\n').find((l) => l.includes('[YOU] [CAST]') && l.includes('Holy Shock'));
    expect(castLine).toBeDefined();
    expect(castLine).toContain('[completed before CC landed]');
  });

  it('annotates [YOU] [CAST] with [succeeded after CC arrived] when CC is in second N and cast is at start of second N+1 (boundary case)', () => {
    // CC at 21.950s (displayed 0:21), cast at 22.050s (displayed 0:22)
    // 100ms apart — should annotate even though displayed seconds differ
    const ccMs = MATCH_START_MS + 21_950;
    const castMs = MATCH_START_MS + 22_050;
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: makeOwnerWithCast(castMs),
        isHealer: true,
        matchStartMs: MATCH_START_MS,
        matchEndMs: MATCH_START_MS + 30_000,
        ccTrinketSummaries: [makeCCSummary(ccMs)],
      }),
    );
    const castLine = result.split('\n').find((l) => l.includes('[YOU] [CAST]') && l.includes('Holy Shock'));
    expect(castLine).toBeDefined();
    expect(castLine).toContain('[succeeded after CC arrived — within 1s in log]');
  });
});

// ── buildMatchTimeline — B38: major CD promotion ──────────────────────────────

describe('buildMatchTimeline — B38: major CD promotion from [YOU] [CAST] to [YOU] [CD]', () => {
  const MATCH_START_MS = 1_000_000;

  it('B38: emits [YOU] [CD] (not [YOU] [CAST]) when healer casts a spell with CD >= 30s not in ownerCDs', () => {
    // Avenging Crusader: spellId 216331, cooldownSeconds 60 in spellEffectData
    const castMs = MATCH_START_MS + 10_000;
    const owner: ICombatUnit = {
      ...makeOwner('Feramonk', CombatUnitSpec.Paladin_Holy),
      spellCastEvents: [makeSpellCastEvent('216331', castMs, 'player-2', 'Teammate', 'player-1', 'Feramonk')],
    } as ICombatUnit;

    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        matchStartMs: MATCH_START_MS,
        matchEndMs: MATCH_START_MS + 60_000,
        ownerCDs: [], // not in ownerCDs — simulates missed detection by extractMajorCooldowns
      }),
    );

    expect(result).toContain('[YOU] [CD]');
    expect(result).toContain('Avenging Crusader');
    const ownerCastLines = result
      .split('\n')
      .filter((l) => l.includes('[YOU] [CAST]') && l.includes('Avenging Crusader'));
    expect(ownerCastLines).toHaveLength(0); // must NOT appear as [YOU] [CAST]
  });

  it('B38: emits [YOU] [CAST] for low-CD healer spells (CD < 30s)', () => {
    // Pain Suppression (33206) has cooldownSeconds 180 — should be promoted (sanity: still in ownerCDs path normally)
    // Use a spell NOT in spellEffectData or with CD < 30s to verify the fallthrough stays as [YOU] [CAST]
    // Holy Light (82326) has no cooldown in spellEffectData — stays [YOU] [CAST]
    const castMs = MATCH_START_MS + 5_000;
    const owner: ICombatUnit = {
      ...makeOwner('Feramonk', CombatUnitSpec.Paladin_Holy),
      spellCastEvents: [makeSpellCastEvent('82326', castMs, 'player-2', 'Teammate', 'player-1', 'Feramonk')],
    } as ICombatUnit;

    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        matchStartMs: MATCH_START_MS,
        matchEndMs: MATCH_START_MS + 60_000,
        ownerCDs: [],
      }),
    );

    // Holy Light (82326) is not in HEALER_CAST_SPELL_ID_TO_NAME so it won't appear at all — just verify no crash
    expect(result).toContain('MATCH TIMELINE');
  });
});

// ── extractOwnerCDBuffExpiry ──────────────────────────────────────────────────

describe('extractOwnerCDBuffExpiry', () => {
  const MATCH_START_MS = 1_000_000;

  function makeCDWithCast(
    spellId: string,
    spellName: string,
    castAtSeconds: number,
    cooldownSeconds = 180,
  ): IMajorCooldownInfo {
    return {
      spellId,
      spellName,
      tag: 'Defensive',
      cooldownSeconds,
      maxChargesDetected: 1,
      casts: [{ timeSeconds: castAtSeconds }],
      availableWindows: [],
      neverUsed: false,
    };
  }

  it('returns expiry from SPELL_AURA_REMOVED when available (Pain Suppression = spellId 33206)', () => {
    const ownerId = 'owner-1';
    const owner = makeUnit(ownerId, { name: 'Healer' });
    const target = makeUnit('target-1', {
      name: 'Teammate',
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '33206', MATCH_START_MS + 10_000, ownerId, 'target-1'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '33206', MATCH_START_MS + 17_500, ownerId, 'target-1'),
      ],
    });

    const cd = makeCDWithCast('33206', 'Pain Suppression', 10);
    const result = extractOwnerCDBuffExpiry([cd], ownerId, [owner, target], MATCH_START_MS);

    expect(result).toHaveLength(1);
    expect(result[0].spellId).toBe('33206');
    expect(result[0].spellName).toBe('Pain Suppression');
    expect(result[0].castAtSeconds).toBe(10);
    expect(result[0].expiresAtSeconds).toBeCloseTo(17.5, 1);
    expect(result[0].isEstimated).toBe(false);
  });

  it('falls back to cast + durationSeconds when no SPELL_AURA_REMOVED event exists', () => {
    const ownerId = 'owner-1';
    const owner = makeUnit(ownerId, { name: 'Healer' });
    const cd = makeCDWithCast('33206', 'Pain Suppression', 10);
    const result = extractOwnerCDBuffExpiry([cd], ownerId, [owner], MATCH_START_MS);

    expect(result).toHaveLength(1);
    // spellEffectData['33206'].durationSeconds === 8
    expect(result[0].expiresAtSeconds).toBeCloseTo(18, 1); // 10 + 8
    expect(result[0].isEstimated).toBe(true);
  });

  it('skips CDs with no durationSeconds in spellEffectData', () => {
    const ownerId = 'owner-1';
    const owner = makeUnit(ownerId, { name: 'Healer' });
    const cd = makeCDWithCast('9999999', 'Unknown Spell', 10);
    const result = extractOwnerCDBuffExpiry([cd], ownerId, [owner], MATCH_START_MS);
    expect(result).toHaveLength(0);
  });

  it('skips Control-tagged CDs (CC spells) — aura is on enemy, not friendly, so always estimated and DR-wrong', () => {
    const ownerId = 'owner-1';
    const owner = makeUnit(ownerId, { name: 'Ret' });
    // Hammer of Justice = spellId 853, Control tag — should be skipped entirely
    const cd: IMajorCooldownInfo = {
      spellId: '853',
      spellName: 'Hammer of Justice',
      tag: 'Control',
      cooldownSeconds: 60,
      maxChargesDetected: 1,
      casts: [{ timeSeconds: 10 }],
      availableWindows: [],
      neverUsed: false,
    };
    const result = extractOwnerCDBuffExpiry([cd], ownerId, [owner], MATCH_START_MS);
    expect(result).toHaveLength(0);
  });

  it('ignores SPELL_AURA_REMOVED events cast by a different unit (not the owner)', () => {
    const ownerId = 'owner-1';
    const owner = makeUnit(ownerId, { name: 'Healer' });
    const target = makeUnit('target-1', {
      name: 'Teammate',
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '33206', MATCH_START_MS + 17_500, 'other-healer', 'target-1'),
      ],
    });

    const cd = makeCDWithCast('33206', 'Pain Suppression', 10);
    const result = extractOwnerCDBuffExpiry([cd], ownerId, [owner, target], MATCH_START_MS);

    expect(result[0].isEstimated).toBe(true);
  });

  it('matches two casts to their respective SPELL_AURA_REMOVED events in order', () => {
    const ownerId = 'owner-1';
    const target1 = makeUnit('target-1', {
      name: 'Teammate1',
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '33206', MATCH_START_MS + 10_000, ownerId, 'target-1'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '33206', MATCH_START_MS + 17_500, ownerId, 'target-1'),
      ],
    });
    const target2 = makeUnit('target-2', {
      name: 'Teammate2',
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '33206', MATCH_START_MS + 40_000, ownerId, 'target-2'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '33206', MATCH_START_MS + 47_000, ownerId, 'target-2'),
      ],
    });
    const owner = makeUnit(ownerId, { name: 'Healer' });

    const cd: IMajorCooldownInfo = {
      spellId: '33206',
      spellName: 'Pain Suppression',
      tag: 'Defensive',
      cooldownSeconds: 180,
      maxChargesDetected: 2,
      casts: [{ timeSeconds: 10 }, { timeSeconds: 40 }],
      availableWindows: [],
      neverUsed: false,
    };

    const result = extractOwnerCDBuffExpiry([cd], ownerId, [owner, target1, target2], MATCH_START_MS);

    expect(result).toHaveLength(2);
    expect(result[0].expiresAtSeconds).toBeCloseTo(17.5, 1);
    expect(result[0].isEstimated).toBe(false);
    expect(result[1].expiresAtSeconds).toBeCloseTo(47, 1);
    expect(result[1].isEstimated).toBe(false);
  });
});

// ── buildMatchTimeline [BUFF FADED] events ────────────────────────────────────

describe('buildMatchTimeline [BUFF FADED] events', () => {
  const MATCH_START_MS = 1_000_000;
  const MATCH_END_MS = 1_120_000; // 120s match

  function baseParams(): BuildMatchTimelineParams {
    return {
      owner: makeUnit('owner-1', { name: 'Healer' }),
      ownerSpec: 'Discipline Priest',
      ownerCDs: [],
      teammateCDs: [],
      enemyCDTimeline: makeEnemyTimeline(),
      ccTrinketSummaries: [],
      dispelSummary: makeEmptyDispelSummary(),
      friendlyDeaths: [],
      enemyDeaths: [],
      pressureWindows: [],
      healingGaps: [],
      friends: [],
      matchStartMs: MATCH_START_MS,
      matchEndMs: MATCH_END_MS,
      isHealer: true,
    };
  }

  it('emits [BUFF FADED] at the SPELL_AURA_REMOVED timestamp when log event is present', () => {
    const ownerId = 'owner-1';
    const owner = makeUnit(ownerId, { name: 'Healer' });
    const teammate = makeUnit('tm-1', {
      name: 'Teammate',
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '33206', MATCH_START_MS + 10_000, ownerId, 'tm-1'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '33206', MATCH_START_MS + 17_500, ownerId, 'tm-1'),
      ],
    });

    const cd: IMajorCooldownInfo = {
      spellId: '33206',
      spellName: 'Pain Suppression',
      tag: 'Defensive',
      cooldownSeconds: 180,
      maxChargesDetected: 1,
      casts: [{ timeSeconds: 10 }],
      availableWindows: [],
      neverUsed: false,
    };

    const timeline = buildMatchTimeline({
      ...baseParams(),
      owner,
      ownerCDs: [cd],
      friends: [owner, teammate],
    });

    expect(timeline).toContain('[BUFF FADED]');
    expect(timeline).toContain('Pain Suppression');
    const expiryLine = timeline.split('\n').find((l) => l.includes('[BUFF FADED]'));
    expect(expiryLine).toBeDefined();
    expect(expiryLine).not.toContain('(estimated)');
  });

  it('emits [BUFF FADED] with (estimated) when no aura event exists', () => {
    const ownerId = 'owner-1';
    const owner = makeUnit(ownerId, { name: 'Healer' });

    const cd: IMajorCooldownInfo = {
      spellId: '33206',
      spellName: 'Pain Suppression',
      tag: 'Defensive',
      cooldownSeconds: 180,
      maxChargesDetected: 1,
      casts: [{ timeSeconds: 10 }],
      availableWindows: [],
      neverUsed: false,
    };

    const timeline = buildMatchTimeline({
      ...baseParams(),
      owner,
      ownerCDs: [cd],
      friends: [owner],
    });

    expect(timeline).toContain('[BUFF FADED]');
    const expiryLine = timeline.split('\n').find((l) => l.includes('[BUFF FADED]'));
    expect(expiryLine).toBeDefined();
    expect(expiryLine).toContain('(estimated)');
    // Fallback: 10 + 8 = 18s → displays as 0:18
    expect(expiryLine).toContain('0:18');
  });

  it('does not emit [BUFF FADED] for CDs with no durationSeconds in spellEffectData', () => {
    const ownerId = 'owner-1';
    const owner = makeUnit(ownerId, { name: 'Healer' });

    const cd: IMajorCooldownInfo = {
      spellId: '9999999',
      spellName: 'Unknown Spell',
      tag: 'Defensive',
      cooldownSeconds: 180,
      maxChargesDetected: 1,
      casts: [{ timeSeconds: 10 }],
      availableWindows: [],
      neverUsed: false,
    };

    const timeline = buildMatchTimeline({
      ...baseParams(),
      owner,
      ownerCDs: [cd],
      friends: [owner],
    });

    expect(timeline).not.toContain('[BUFF FADED]');
  });

  it('[BUFF FADED] appears after [YOU] [CD] in sorted timeline output', () => {
    const ownerId = 'owner-1';
    const owner = makeUnit(ownerId, { name: 'Healer' });

    const cd: IMajorCooldownInfo = {
      spellId: '33206',
      spellName: 'Pain Suppression',
      tag: 'Defensive',
      cooldownSeconds: 180,
      maxChargesDetected: 1,
      casts: [{ timeSeconds: 10 }],
      availableWindows: [],
      neverUsed: false,
    };

    const timeline = buildMatchTimeline({
      ...baseParams(),
      owner,
      ownerCDs: [cd],
      friends: [owner],
    });

    const lines = timeline.split('\n');
    const ownerCDIndex = lines.findIndex((l) => l.includes('[YOU] [CD]') && l.includes('Pain Suppression'));
    const expiredIndex = lines.findIndex((l) => l.includes('[BUFF FADED]'));
    expect(ownerCDIndex).toBeGreaterThanOrEqual(0);
    expect(expiredIndex).toBeGreaterThan(ownerCDIndex);
  });
});

// ── computeHealingInWindow (F69) ──────────────────────────────────────────────

describe('computeHealingInWindow', () => {
  const matchStartMs = 1_000_000;

  it('returns null when no healing events fall in the window', () => {
    expect(computeHealingInWindow([] as any, matchStartMs, matchStartMs + 15_000)).toBeNull();
  });

  it('returns null when all healing events are outside the window', () => {
    const healOut = [makeHealEvent(matchStartMs - 1, 'healer-1', 50_000)];
    expect(computeHealingInWindow(healOut as any, matchStartMs, matchStartMs + 15_000)).toBeNull();
  });

  it('calculates HPS per 5s bucket for a 15s PI window', () => {
    // 150k at t+2s (bucket 0–5), 100k at t+7s (bucket 5–10), 50k at t+12s (bucket 10–15)
    const healOut = [
      makeHealEvent(matchStartMs + 2_000, 'healer-1', 150_000),
      makeHealEvent(matchStartMs + 7_000, 'healer-1', 100_000),
      makeHealEvent(matchStartMs + 12_000, 'healer-1', 50_000),
    ];
    const result = computeHealingInWindow(healOut as any, matchStartMs, matchStartMs + 15_000);
    if (!result) throw new Error('expected non-null result');
    expect(result.buckets).toHaveLength(3);
    expect(result.buckets[0]).toEqual({ fromSeconds: 0, toSeconds: 5, hps: 30_000 }); // 150k / 5s
    expect(result.buckets[1]).toEqual({ fromSeconds: 5, toSeconds: 10, hps: 20_000 }); // 100k / 5s
    expect(result.buckets[2]).toEqual({ fromSeconds: 10, toSeconds: 15, hps: 10_000 }); // 50k / 5s
  });

  it('handles a short 8s Innervate window with two buckets', () => {
    const healOut = [
      makeHealEvent(matchStartMs + 3_000, 'healer-1', 100_000),
      makeHealEvent(matchStartMs + 7_000, 'healer-1', 60_000),
    ];
    const result = computeHealingInWindow(healOut as any, matchStartMs, matchStartMs + 8_000);
    if (!result) throw new Error('expected non-null result');
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[0]).toEqual({ fromSeconds: 0, toSeconds: 5, hps: 20_000 }); // 100k / 5s
    expect(result.buckets[1]).toEqual({ fromSeconds: 5, toSeconds: 8, hps: 20_000 }); // 60k / 3s
  });

  it('calculates overheal % correctly', () => {
    const healOut = [
      makeHealEvent(matchStartMs + 2_000, 'healer-1', 100_000, 30_000), // 30k overheal
      makeHealEvent(matchStartMs + 7_000, 'healer-1', 100_000, 70_000), // 70k overheal
    ];
    const result = computeHealingInWindow(healOut as any, matchStartMs, matchStartMs + 15_000);
    if (!result) throw new Error('expected non-null result');
    // total amount = 200k, total effective = 100k → 50% overheal
    expect(result.overhealPct).toBe(50);
  });

  it('reports 0% overheal when no overheal', () => {
    const healOut = [makeHealEvent(matchStartMs + 2_000, 'healer-1', 100_000, 0)];
    const result = computeHealingInWindow(healOut as any, matchStartMs, matchStartMs + 15_000);
    if (!result) throw new Error('expected non-null result');
    expect(result.overhealPct).toBe(0);
  });

  it('HEALING_AMPLIFIER_SPELL_IDS contains PI, Innervate, and Ascendance', () => {
    expect(HEALING_AMPLIFIER_SPELL_IDS.has('10060')).toBe(true); // PI
    expect(HEALING_AMPLIFIER_SPELL_IDS.has('29166')).toBe(true); // Innervate
    expect(HEALING_AMPLIFIER_SPELL_IDS.has('114052')).toBe(true); // Ascendance
    expect(HEALING_AMPLIFIER_SPELL_IDS.has('9999')).toBe(false);
  });
});

// ── HEALING_WINDOW_EARLY_CD_SECONDS / HEALING_WINDOW_MIN_HPS constants (F93) ──

describe('HEALING_WINDOW constants (F93)', () => {
  it('HEALING_WINDOW_EARLY_CD_SECONDS is 10', () => {
    expect(HEALING_WINDOW_EARLY_CD_SECONDS).toBe(10);
  });

  it('HEALING_WINDOW_MIN_HPS is 1000', () => {
    expect(HEALING_WINDOW_MIN_HPS).toBe(1_000);
  });
});

// ── buildMatchTimeline — [HEALING] line (F69) ─────────────────────────────────

describe('buildMatchTimeline — [HEALING] line on healing amplifier CDs', () => {
  const matchStartMs = 1_000_000;
  const matchEndMs = matchStartMs + 120_000;

  function makeBaseParams(ownerHealOut: any[], ownerCDs: IMajorCooldownInfo[]): BuildMatchTimelineParams {
    const owner = makeUnit('healer-1', { name: 'Healer', healOut: ownerHealOut });
    return {
      owner,
      ownerSpec: 'Holy Priest',
      ownerCDs,
      teammateCDs: [],
      enemyCDTimeline: makeEnemyTimeline(),
      ccTrinketSummaries: [],
      dispelSummary: {
        missedCleanseWindows: [],
        allyCleanse: [],
        ourPurges: [],
        hostilePurges: [],
        ccEfficiency: [],
        missedPurgeWindows: [],
      },
      friendlyDeaths: [],
      enemyDeaths: [],
      pressureWindows: [],
      healingGaps: [],
      friends: [owner],
      matchStartMs,
      matchEndMs,
      isHealer: true,
    };
  }

  function makePICD(castAtSeconds: number): IMajorCooldownInfo {
    return {
      spellId: '10060',
      spellName: 'Power Infusion',
      tag: 'Healing',
      cooldownSeconds: 120,
      maxChargesDetected: 1,
      neverUsed: false,
      casts: [
        {
          timeSeconds: castAtSeconds,
          timingLabel: 'Unknown',
          timingContext: undefined,
          targetName: undefined,
          targetHpPct: undefined,
        },
      ],
      availableWindows: [],
    };
  }

  it('appends a [HEALING] line to [YOU] [CD] entries for PI when healing occurred', () => {
    // PI cast at 10s; window is 10–25s. Healing at 12s (bucket 0–5), 17s (bucket 5–10), 22s (bucket 10–15)
    const healOut = [
      makeHealEvent(matchStartMs + 12_000, 'healer-1', 150_000),
      makeHealEvent(matchStartMs + 17_000, 'healer-1', 100_000),
      makeHealEvent(matchStartMs + 22_000, 'healer-1', 50_000),
    ];
    const timeline = buildMatchTimeline(makeBaseParams(healOut, [makePICD(10)]));
    expect(timeline).toContain('[YOU] [CD]   Power Infusion');
    expect(timeline).toContain('[HEALING]');
    expect(timeline).toContain('0–5s: 30.0k HPS');
    expect(timeline).toContain('5–10s: 20.0k HPS');
    expect(timeline).toContain('10–15s: 10.0k HPS');
    expect(timeline).toContain('Overheal: 0%');
  });

  it('appends [HEALING] with overheal % when some healing was wasted', () => {
    const healOut = [makeHealEvent(matchStartMs + 12_000, 'healer-1', 100_000, 60_000)];
    const timeline = buildMatchTimeline(makeBaseParams(healOut, [makePICD(10)]));
    expect(timeline).toContain('Overheal: 60%');
  });

  it('appends "No healing logged" when no healing events fall in the PI window', () => {
    // PI cast at 10s, duration 15s → window 10–25s. Healing event at 30s is outside window.
    const healOut = [makeHealEvent(matchStartMs + 30_000, 'healer-1', 100_000)];
    const timeline = buildMatchTimeline(makeBaseParams(healOut, [makePICD(10)]));
    expect(timeline).toContain('[HEALING]');
    expect(timeline).toContain('No healing logged during this window');
  });

  it('does NOT append [HEALING] for non-amplifier CDs like Pain Suppression (33206)', () => {
    const painSuppCD: IMajorCooldownInfo = {
      spellId: '33206',
      spellName: 'Pain Suppression',
      tag: 'Defensive',
      cooldownSeconds: 180,
      maxChargesDetected: 1,
      neverUsed: false,
      casts: [
        {
          timeSeconds: 10,
          timingLabel: 'Unknown',
          timingContext: undefined,
          targetName: undefined,
          targetHpPct: undefined,
        },
      ],
      availableWindows: [],
    };
    const healOut = [makeHealEvent(matchStartMs + 12_000, 'healer-1', 100_000)];
    const timeline = buildMatchTimeline(makeBaseParams(healOut, [painSuppCD]));
    expect(timeline).not.toContain('[HEALING]');
  });

  it('suppresses [HEALING] when PI is cast before 10s and healing events are outside the window (0 HPS)', () => {
    // PI cast at 5s (early), duration 15s → window [5s, 20s]. Heal at 25s is outside → maxBucketHps = 0.
    const healOut = [makeHealEvent(matchStartMs + 25_000, 'healer-1', 100_000)];
    const timeline = buildMatchTimeline(makeBaseParams(healOut, [makePICD(5)]));
    expect(timeline).toContain('[YOU] [CD]   Power Infusion');
    expect(timeline).not.toContain('[HEALING]');
  });

  it('suppresses [HEALING] when PI is cast before 10s and max bucket HPS is below 1k', () => {
    // PI cast at 3s (early), 500 effective heal in window → falls in bucket [0–5s] → 100 HPS max bucket — below 1k threshold.
    const healOut = [makeHealEvent(matchStartMs + 5_000, 'healer-1', 500)];
    const timeline = buildMatchTimeline(makeBaseParams(healOut, [makePICD(3)]));
    expect(timeline).toContain('[YOU] [CD]   Power Infusion');
    expect(timeline).not.toContain('[HEALING]');
  });

  it('does NOT suppress [HEALING] when PI is cast before 10s but max bucket HPS is above 1k', () => {
    // PI cast at 5s (early), but real healing → max bucket HPS well above 1k.
    const healOut = [
      makeHealEvent(matchStartMs + 6_000, 'healer-1', 50_000),
      makeHealEvent(matchStartMs + 10_000, 'healer-1', 80_000),
    ];
    const timeline = buildMatchTimeline(makeBaseParams(healOut, [makePICD(5)]));
    expect(timeline).toContain('[HEALING]');
  });

  it('does NOT suppress [HEALING] when PI is cast at exactly 10s (boundary is exclusive)', () => {
    // cast.timeSeconds < 10 is false at exactly 10s → guard does not apply.
    const healOut = [makeHealEvent(matchStartMs + 12_000, 'healer-1', 150_000)];
    const timeline = buildMatchTimeline(makeBaseParams(healOut, [makePICD(10)]));
    expect(timeline).toContain('[HEALING]');
  });

  it('does NOT suppress [HEALING] when PI is cast after 10s even with low HPS', () => {
    // Cast at 15s (not early) — low HPS alone is not a suppression condition.
    const healOut = [makeHealEvent(matchStartMs + 16_000, 'healer-1', 500)];
    const timeline = buildMatchTimeline(makeBaseParams(healOut, [makePICD(15)]));
    expect(timeline).toContain('[HEALING]');
  });
});

// ── buildMatchTimeline — [HP] / [ENEMY HP] split ─────────────────────────────

describe('buildMatchTimeline — [HP] / [ENEMY HP] split', () => {
  it.skip('emits [HP] for friendly units on baseline ticks (no critical window)', () => {
    const matchStartMs = 0;
    const matchEndMs = 12_000; // 12s match, no deaths

    // unit id must match advancedActorId ('unit-1') so getUnitHpAtTimestamp picks it up
    const friend = makeUnit('unit-1', {
      name: 'Feramonk',
      advancedActions: [makeAdvancedAction(3_000, 0, 0, 500_000, 450_000)],
    });

    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [friend],
        matchStartMs,
        matchEndMs,
      }),
    );

    expect(result).toContain('[STATE]');
  });

  it.skip('does NOT emit enemies section on baseline ticks (no critical window)', () => {
    const matchStartMs = 0;
    const matchEndMs = 12_000;

    const enemy = makeUnit('enemy-1', {
      name: 'Dzinked',
      reaction: CombatUnitReaction.Hostile,
      advancedActions: [{ ...makeAdvancedAction(3_000, 0, 0, 500_000, 450_000), advancedActorId: 'enemy-1' }],
    });

    const result = buildMatchTimeline(
      makeBaseParams({
        enemies: [enemy],
        matchStartMs,
        matchEndMs,
      }),
    );

    // On baseline [STATE] ticks, no enemies section — [MATCH END] shows enemies separately
    const hasEnemiesInState = result.split('\n').some((l) => l.includes('[STATE]') && l.includes('enemies'));
    expect(hasEnemiesInState).toBe(false);
  });

  it('emits enemies section in [STATE] on critical-window ticks (death window)', () => {
    const matchStartMs = 0;
    const deathAtSeconds = 30;
    const matchEndMs = 60_000;

    const enemy = makeUnit('enemy-1', {
      name: 'Dzinked',
      reaction: CombatUnitReaction.Hostile,
      advancedActions: [
        { ...makeAdvancedAction((deathAtSeconds - 5) * 1000, 0, 0, 500_000, 100_000), advancedActorId: 'enemy-1' },
      ],
    });

    const result = buildMatchTimeline(
      makeBaseParams({
        enemies: [enemy],
        enemyDeaths: [{ spec: 'Affliction Warlock', name: 'Dzinked', atSeconds: deathAtSeconds }],
        matchStartMs,
        matchEndMs,
      }),
    );

    expect(result).toContain('[STATE]   enemies Dzinked');
  });

  it('does NOT include enemy HP in the friends section of [STATE]', () => {
    const matchStartMs = 0;
    const deathAtSeconds = 30;
    const matchEndMs = 60_000;

    // unit-1 matches default advancedActorId from makeAdvancedAction
    const friend = makeUnit('unit-1', {
      name: 'Feramonk',
      advancedActions: [makeAdvancedAction((deathAtSeconds - 3) * 1000, 0, 0, 500_000, 400_000)],
    });
    const enemy = makeUnit('enemy-1', {
      name: 'Dzinked',
      reaction: CombatUnitReaction.Hostile,
      advancedActions: [
        { ...makeAdvancedAction((deathAtSeconds - 3) * 1000, 0, 0, 500_000, 50_000), advancedActorId: 'enemy-1' },
      ],
    });

    const result = buildMatchTimeline(
      makeBaseParams({
        friends: [friend],
        enemies: [enemy],
        enemyDeaths: [{ spec: 'Affliction Warlock', name: 'Dzinked', atSeconds: deathAtSeconds }],
        matchStartMs,
        matchEndMs,
      }),
    );

    // Enemy HP goes in the enemies section, not the friends section.
    // Lines with only an enemies section (no '/ enemies' separator) are enemies-only — skip them.
    const stateLines = result
      .split('\n')
      .filter((l) => l.includes('[STATE]') && l.includes('Dzinked') && l.includes('/ enemies'));
    for (const line of stateLines) {
      const friendsPart = line.split('/ enemies')[0];
      expect(friendsPart).not.toContain('Dzinked');
    }
  });
});

// ── buildResourceSnapshot — F72 compact format ────────────────────────────────

describe('buildResourceSnapshot — F72 compact [RES] format', () => {
  const BASE_ENEMY_TIMELINE = makeEnemyTimeline();

  function makeCC(spellName: string, atSeconds: number, durationSeconds: number, category: string): ICCInstance {
    return {
      atSeconds,
      durationSeconds,
      spellId: '0',
      spellName,
      sourceName: 'enemy',
      sourceSpec: 'Unknown',
      damageTakenDuring: 0,
      trinketState: 'available_unused',
      drInfo: { category, level: 'Full' as const, sequenceIndex: 0 },
      distanceYards: null,
      losBlocked: null,
    };
  }

  function makeSummary(
    playerName: string,
    ccInstances: ICCInstance[] = [],
    trinketUseTimes: number[] = [],
  ): IPlayerCCTrinketSummary {
    return {
      playerName,
      playerSpec: 'Holy Paladin',
      trinketType: 'Gladiator',
      trinketCooldownSeconds: 90,
      ccInstances,
      trinketUseTimes,
      missedTrinketWindows: [],
      rootInstances: [],
      disarmInstances: [],
      interruptInstances: [],
      ccAvoidedInstances: [],
    };
  }

  it('calm state: emits rdy and cd only, no enemy or cc fields', () => {
    const avWr = { ...makeCD('Avenging Wrath', 120), casts: [] };
    const ps = {
      ...makeCD('Pain Suppression', 120),
      casts: [{ timeSeconds: 5 }],
    };
    const result = buildResourceSnapshot({
      timeSeconds: 30,
      ownerCDs: [avWr, ps],
      ownerName: 'Player1',
      ownerSpec: 'Holy Paladin',
      teammateCDs: [],
      ccTrinketSummaries: [],
      enemyCDTimeline: BASE_ENEMY_TIMELINE,
    });
    expect(result).toMatch(/^\s*\[RES\] rdy:/);
    expect(result).toContain('rdy:Avenging Wrath');
    expect(result).toContain('cd:Pain Suppression(');
    expect(result).not.toContain('enemy:');
    expect(result).not.toContain('cc:');
  });

  it('enemy burst: includes enemy field with seconds-since-cast', () => {
    const result = buildResourceSnapshot({
      timeSeconds: 20,
      ownerCDs: [],
      ownerName: 'Player1',
      ownerSpec: 'Holy Paladin',
      teammateCDs: [],
      ccTrinketSummaries: [],
      enemyCDTimeline: makeEnemyTimeline([
        {
          playerName: 'Rogue1',
          specName: 'Outlaw Rogue',
          offensiveCDs: [
            {
              spellId: '0',
              spellName: 'Adrenaline Rush',
              castTimeSeconds: 12,
              cooldownSeconds: 180,
              availableAgainAtSeconds: 192,
              buffEndSeconds: 22,
            },
          ],
        },
      ]),
    });
    expect(result).toContain('enemy:Adrenaline Rush/Outlaw Rogue(8s)');
    expect(result).not.toContain('cc:');
  });

  it('enemy CD older than 30s is omitted from enemy field', () => {
    const result = buildResourceSnapshot({
      timeSeconds: 60,
      ownerCDs: [],
      ownerName: 'Player1',
      ownerSpec: 'Holy Paladin',
      teammateCDs: [],
      ccTrinketSummaries: [],
      enemyCDTimeline: makeEnemyTimeline([
        {
          playerName: 'Rogue1',
          specName: 'Outlaw Rogue',
          offensiveCDs: [
            {
              spellId: '0',
              spellName: 'Adrenaline Rush',
              castTimeSeconds: 20,
              cooldownSeconds: 180,
              availableAgainAtSeconds: 200,
              buffEndSeconds: 30,
            },
          ],
        },
      ]),
    });
    // Empty because no player CDs and enemy CD is too old
    expect(result).toBe('');
  });

  it('CC present: includes cc field, omits free players', () => {
    const cc = makeCC('Psychic Scream', 27, 8, 'Fear');
    const freePlayer = makeSummary('Player2', []);
    const result = buildResourceSnapshot({
      timeSeconds: 30,
      ownerCDs: [],
      ownerName: 'Player1',
      ownerSpec: 'Holy Paladin',
      teammateCDs: [],
      ccTrinketSummaries: [makeSummary('Player1', [cc]), freePlayer],
      enemyCDTimeline: BASE_ENEMY_TIMELINE,
    });
    expect(result).toMatch(/^\s*\[RES\] rdy:/);
    expect(result).toContain('cc:Player1/Psychic Scream-5s');
    expect(result).not.toContain('Player2');
    expect(result).not.toContain('[stun]');
    expect(result).not.toContain('[trinketed]');
  });

  it('physical stun appends [stun] tag', () => {
    const cc = makeCC('Kidney Shot', 27, 8, 'Stun');
    const result = buildResourceSnapshot({
      timeSeconds: 30,
      ownerCDs: [],
      ownerName: 'Player1',
      ownerSpec: 'Holy Paladin',
      teammateCDs: [],
      ccTrinketSummaries: [makeSummary('Player1', [cc])],
      enemyCDTimeline: BASE_ENEMY_TIMELINE,
    });
    expect(result).toContain('cc:Player1/Kidney Shot-5s[stun]');
  });

  it('stun + trinket at same second appends [trinketed] tag', () => {
    const cc = makeCC('Kidney Shot', 27, 8, 'Stun');
    const result = buildResourceSnapshot({
      timeSeconds: 30,
      ownerCDs: [],
      ownerName: 'Player1',
      ownerSpec: 'Holy Paladin',
      teammateCDs: [],
      ccTrinketSummaries: [makeSummary('Player1', [cc], [30])],
      enemyCDTimeline: BASE_ENEMY_TIMELINE,
    });
    expect(result).toContain('[stun][trinketed]');
  });

  it('non-stun CC does not get [trinketed] even with trinket use at same time', () => {
    const cc = makeCC('Psychic Scream', 27, 8, 'Fear');
    const result = buildResourceSnapshot({
      timeSeconds: 30,
      ownerCDs: [],
      ownerName: 'Player1',
      ownerSpec: 'Holy Paladin',
      teammateCDs: [],
      ccTrinketSummaries: [makeSummary('Player1', [cc], [30])],
      enemyCDTimeline: BASE_ENEMY_TIMELINE,
    });
    expect(result).toMatch(/^\s*\[RES\] rdy:/);
    expect(result).not.toContain('[trinketed]');
  });

  it('all players free: cc field absent entirely', () => {
    const result = buildResourceSnapshot({
      timeSeconds: 30,
      ownerCDs: [],
      ownerName: 'Player1',
      ownerSpec: 'Holy Paladin',
      teammateCDs: [],
      ccTrinketSummaries: [makeSummary('Player1', [])],
      enemyCDTimeline: BASE_ENEMY_TIMELINE,
    });
    // Empty because no player CDs and all players are CC-free
    expect(result).toBe('');
  });

  it('playerIdMap compresses names to numeric IDs in cc field', () => {
    const cc = makeCC('Kidney Shot', 27, 8, 'Stun');
    const playerIdMap = new Map([['Player1', 1]]);
    const result = buildResourceSnapshot({
      timeSeconds: 30,
      ownerCDs: [],
      ownerName: 'Player1',
      ownerSpec: 'Holy Paladin',
      teammateCDs: [],
      ccTrinketSummaries: [makeSummary('Player1', [cc])],
      enemyCDTimeline: BASE_ENEMY_TIMELINE,
      playerIdMap,
    });
    expect(result).toContain('cc:1/Kidney Shot-5s[stun]');
    expect(result).not.toContain('Player1');
  });

  it('returns empty string when timeSeconds ≤ 5 and all CDs never-used (early-match empty line)', () => {
    const avWr = makeCD('Avenging Wrath', 120);
    const result = buildResourceSnapshot({
      timeSeconds: 3,
      ownerCDs: [avWr],
      ownerName: 'Player1',
      ownerSpec: 'Holy Paladin',
      teammateCDs: [],
      ccTrinketSummaries: [],
      enemyCDTimeline: BASE_ENEMY_TIMELINE,
    });
    expect(result).toBe('');
  });

  it('does NOT suppress when a CD is on cooldown (rdy empty but cd has content)', () => {
    const cd = { ...makeCD('Holy Light', 30), casts: [{ timeSeconds: 18 }] };
    const result = buildResourceSnapshot({
      timeSeconds: 20,
      ownerCDs: [cd],
      ownerName: 'Player1',
      ownerSpec: 'Holy Paladin',
      teammateCDs: [],
      ccTrinketSummaries: [],
      enemyCDTimeline: BASE_ENEMY_TIMELINE,
    });
    expect(result).not.toBe('');
    expect(result).toContain('cd:Holy Light(');
  });

  it('returns empty string when truly all data is absent', () => {
    const result = buildResourceSnapshot({
      timeSeconds: 60,
      ownerCDs: [],
      ownerName: 'Player1',
      ownerSpec: 'Holy Paladin',
      teammateCDs: [],
      ccTrinketSummaries: [],
      enemyCDTimeline: BASE_ENEMY_TIMELINE,
    });
    expect(result).toBe('');
  });
});

describe('buildResourceSnapshot — delta form (F83)', () => {
  const BASE_ENEMY_TIMELINE = makeEnemyTimeline();

  function makeParams(timeSeconds: number, ownerCDs: IMajorCooldownInfo[], prevReadyNames?: string[]) {
    return {
      timeSeconds,
      ownerCDs,
      ownerName: 'Player1',
      ownerSpec: 'Holy Paladin',
      teammateCDs: [],
      ccTrinketSummaries: [],
      enemyCDTimeline: BASE_ENEMY_TIMELINE,
      prevReadyNames,
    };
  }

  it('emits full rdy: list when prevReadyNames is undefined (first call)', () => {
    const avWr = { ...makeCD('Avenging Wrath', 120), casts: [] };
    const result = buildResourceSnapshot(makeParams(30, [avWr]));
    expect(result).toContain('rdy:Avenging Wrath');
    expect(result).not.toContain('Δ');
  });

  it.skip('emits rdy:Δ when ready list is unchanged from prev', () => {
    const avWr = { ...makeCD('Avenging Wrath', 120), casts: [] };
    const result = buildResourceSnapshot(makeParams(30, [avWr], ['Avenging Wrath']));
    expect(result).toContain('rdy:Δ');
    expect(result).not.toContain('rdy:Avenging Wrath');
  });

  it('emits rdy:Δ-SpellName when a CD was just used (no longer ready)', () => {
    // avWr cast at t=10; at t=30, priorCasts=[{t=10}] (10 < 29.5), 10+120=130 > 30.5 → on CD
    const avWr = { ...makeCD('Avenging Wrath', 120), casts: [{ timeSeconds: 10 }] };
    const result = buildResourceSnapshot(makeParams(30, [avWr], ['Avenging Wrath']));
    expect(result).toContain('rdy:Δ-Avenging Wrath');
  });

  it('emits rdy:Δ+SpellName when a CD just came off cooldown', () => {
    // avWr cast at t=10, CD=30s; at t=45, 10+30=40 ≤ 45.5 → ready; prev=[]
    const avWr = { ...makeCD('Avenging Wrath', 30), casts: [{ timeSeconds: 10 }] };
    const result = buildResourceSnapshot(makeParams(45, [avWr], []));
    expect(result).toContain('rdy:Δ+Avenging Wrath');
  });

  it('emits rdy:Δ+Added-Removed when one CD became ready and another went on CD', () => {
    // ps cast at t=10, CD=120s: at t=50, 10+120=130 > 50.5 → on CD (was in prev)
    const ps = { ...makeCD('Pain Suppression', 120), casts: [{ timeSeconds: 10 }] };
    // avWr cast at t=10, CD=30s: at t=50, 10+30=40 ≤ 50.5 → ready (was NOT in prev)
    const avWr = { ...makeCD('Avenging Wrath', 30), casts: [{ timeSeconds: 10 }] };
    const result = buildResourceSnapshot(makeParams(50, [ps, avWr], ['Pain Suppression']));
    expect(result).toContain('+Avenging Wrath');
    expect(result).toContain('-Pain Suppression');
    expect(result).toContain('Δ');
  });

  describe('computeReadyNames', () => {
    it('returns empty array when no ownerCDs and no teammateCDs', () => {
      expect(computeReadyNames(30, [], [])).toEqual([]);
    });

    it('returns spell name when CD has no prior casts and timeSeconds > 5', () => {
      const avWr = { ...makeCD('Avenging Wrath', 120), casts: [] };
      expect(computeReadyNames(30, [avWr], [])).toEqual(['Avenging Wrath']);
    });

    it('does NOT return spell when not yet 5s into match', () => {
      const avWr = { ...makeCD('Avenging Wrath', 120), casts: [] };
      expect(computeReadyNames(3, [avWr], [])).toEqual([]);
    });

    it('returns spell name when cooldown has expired', () => {
      // cast at t=5, CD=30s → ready at t=35; query at t=40
      const avWr = { ...makeCD('Avenging Wrath', 30), casts: [{ timeSeconds: 5 }] };
      expect(computeReadyNames(40, [avWr], [])).toContain('Avenging Wrath');
    });

    it('does NOT return spell while still on cooldown', () => {
      // cast at t=5, CD=120s → ready at t=125; query at t=40
      const avWr = { ...makeCD('Avenging Wrath', 120), casts: [{ timeSeconds: 5 }] };
      expect(computeReadyNames(40, [avWr], [])).not.toContain('Avenging Wrath');
    });
  });
});

describe('buildResourceSnapshot — root/disarm/kick in cc: line', () => {
  function makeSummaryWithRoot(playerName: string, atSeconds: number, durationSeconds: number) {
    return {
      playerName,
      playerSpec: 'Druid_Restoration',
      trinketType: 'Gladiator' as const,
      trinketCooldownSeconds: 90,
      ccInstances: [],
      trinketUseTimes: [],
      missedTrinketWindows: [],
      rootInstances: [
        {
          atSeconds,
          durationSeconds,
          spellId: '339',
          spellName: 'Entangling Roots',
          sourceName: 'EnemyDruid',
          sourceSpec: 'Druid_Balance',
        },
      ],
      disarmInstances: [],
      interruptInstances: [],
      ccAvoidedInstances: [],
    };
  }

  function makeSummaryWithDisarm(playerName: string, atSeconds: number, durationSeconds: number) {
    return {
      playerName,
      playerSpec: 'Warrior_Arms',
      trinketType: 'Gladiator' as const,
      trinketCooldownSeconds: 120,
      ccInstances: [],
      trinketUseTimes: [],
      missedTrinketWindows: [],
      rootInstances: [],
      disarmInstances: [
        {
          atSeconds,
          durationSeconds,
          spellId: '236077',
          spellName: 'Disarm',
          sourceName: 'EnemyWarrior',
          sourceSpec: 'Warrior_Arms',
        },
      ],
      interruptInstances: [],
      ccAvoidedInstances: [],
    };
  }

  function makeSummaryWithKick(playerName: string, atSeconds: number, lockoutDurationSeconds: number) {
    return {
      playerName,
      playerSpec: 'Mage_Frost',
      trinketType: 'Gladiator' as const,
      trinketCooldownSeconds: 120,
      ccInstances: [],
      trinketUseTimes: [],
      missedTrinketWindows: [],
      rootInstances: [],
      disarmInstances: [],
      interruptInstances: [
        {
          atSeconds,
          lockoutDurationSeconds,
          kickSpellId: '1766',
          kickSpellName: 'Kick',
          interruptedSpellName: 'Frostbolt',
          sourceName: 'EnemyRogue',
          sourceSpec: 'Rogue_Subtlety',
        },
      ],
    };
  }

  function minimalParams(ccTrinketSummaries: unknown[], ownerName: string) {
    return {
      timeSeconds: 30,
      ownerCDs: [],
      ownerName,
      ownerSpec: 'Holy Paladin',
      teammateCDs: [],
      ccTrinketSummaries: ccTrinketSummaries as IPlayerCCTrinketSummary[],
      enemyCDTimeline: makeEnemyTimeline(),
    };
  }

  it('shows [root] tag when player is rooted at snapshot time', () => {
    // Root applied at t=25, lasts 8s → still active at t=30
    const summary = makeSummaryWithRoot('Player1', 25, 8);
    const result = buildResourceSnapshot(minimalParams([summary], 'Player1'));
    expect(result).toContain('cc:');
    expect(result).toContain('[root]');
    expect(result).toContain('Entangling Roots');
  });

  it('omits root from cc: when root has expired at snapshot time', () => {
    // Root at t=20, lasts 3s → expired by t=30
    const summary = makeSummaryWithRoot('Player1', 20, 3);
    const result = buildResourceSnapshot(minimalParams([summary], 'Player1'));
    expect(result).not.toContain('[root]');
  });

  it('shows [disarm] tag when player is disarmed at snapshot time', () => {
    // Disarm at t=28, lasts 5s → still active at t=30
    const summary = makeSummaryWithDisarm('Player1', 28, 5);
    const result = buildResourceSnapshot(minimalParams([summary], 'Player1'));
    expect(result).toContain('[disarm]');
    expect(result).toContain('Disarm');
  });

  it('shows [kick] tag when player is within kick lockout at snapshot time', () => {
    // Kick at t=27, lockout 5s → expires at t=32, still active at t=30
    const summary = makeSummaryWithKick('Player1', 27, 5);
    const result = buildResourceSnapshot(minimalParams([summary], 'Player1'));
    expect(result).toContain('[kick]');
    expect(result).toContain('Kick');
  });

  it('omits kick from cc: when lockout has expired', () => {
    // Kick at t=20, lockout 5s → expired at t=25, before snapshot t=30
    const summary = makeSummaryWithKick('Player1', 20, 5);
    const result = buildResourceSnapshot(minimalParams([summary], 'Player1'));
    expect(result).not.toContain('[kick]');
  });
});

describe('buildJsonSituationSnapshot — root/disarm/kick in cc array', () => {
  // Reuse factory helpers from above describe block
  function makeSummaryWithRoot(playerName: string, atSeconds: number, durationSeconds: number) {
    return {
      playerName,
      playerSpec: 'Druid_Restoration',
      trinketType: 'Gladiator' as const,
      trinketCooldownSeconds: 90,
      ccInstances: [],
      trinketUseTimes: [],
      missedTrinketWindows: [],
      rootInstances: [
        {
          atSeconds,
          durationSeconds,
          spellId: '339',
          spellName: 'Entangling Roots',
          sourceName: 'EnemyDruid',
          sourceSpec: 'Druid_Balance',
        },
      ],
      disarmInstances: [],
      interruptInstances: [],
      ccAvoidedInstances: [],
    };
  }

  function makeSummaryWithDisarm(playerName: string, atSeconds: number, durationSeconds: number) {
    return {
      playerName,
      playerSpec: 'Warrior_Arms',
      trinketType: 'Gladiator' as const,
      trinketCooldownSeconds: 120,
      ccInstances: [],
      trinketUseTimes: [],
      missedTrinketWindows: [],
      rootInstances: [],
      disarmInstances: [
        {
          atSeconds,
          durationSeconds,
          spellId: '236077',
          spellName: 'Disarm',
          sourceName: 'EnemyWarrior',
          sourceSpec: 'Warrior_Arms',
        },
      ],
      interruptInstances: [],
      ccAvoidedInstances: [],
    };
  }

  function makeSummaryWithKick(playerName: string, atSeconds: number, lockoutDurationSeconds: number) {
    return {
      playerName,
      playerSpec: 'Mage_Frost',
      trinketType: 'Gladiator' as const,
      trinketCooldownSeconds: 120,
      ccInstances: [],
      trinketUseTimes: [],
      missedTrinketWindows: [],
      rootInstances: [],
      disarmInstances: [],
      interruptInstances: [
        {
          atSeconds,
          lockoutDurationSeconds,
          kickSpellId: '1766',
          kickSpellName: 'Kick',
          interruptedSpellName: 'Frostbolt',
          sourceName: 'EnemyRogue',
          sourceSpec: 'Rogue_Subtlety',
        },
      ],
    };
  }

  function minimalParams(ccTrinketSummaries: unknown[], ownerName: string) {
    return {
      timeSeconds: 30,
      ownerCDs: [],
      ownerName,
      ownerSpec: 'Holy Paladin',
      teammateCDs: [],
      ccTrinketSummaries: ccTrinketSummaries as IPlayerCCTrinketSummary[],
      enemyCDTimeline: makeEnemyTimeline(),
    };
  }

  it('includes root:true in cc entry when player is rooted at snapshot time', () => {
    const summary = makeSummaryWithRoot('Player1', 25, 8);
    const result = buildJsonSituationSnapshot(minimalParams([summary], 'Player1'));
    const parsed = JSON.parse(result.replace(/^\s+\[SIT\]\s+/, ''));
    expect(parsed.cc).toBeDefined();
    expect(parsed.cc[0].root).toBe(true);
    expect(parsed.cc[0].spell).toBe('Entangling Roots');
  });

  it('includes disarm:true in cc entry when player is disarmed', () => {
    const summary = makeSummaryWithDisarm('Player1', 28, 5);
    const result = buildJsonSituationSnapshot(minimalParams([summary], 'Player1'));
    const parsed = JSON.parse(result.replace(/^\s+\[SIT\]\s+/, ''));
    expect(parsed.cc[0].disarm).toBe(true);
  });

  it('includes kick:true in cc entry when player is within lockout', () => {
    const summary = makeSummaryWithKick('Player1', 27, 5);
    const result = buildJsonSituationSnapshot(minimalParams([summary], 'Player1'));
    const parsed = JSON.parse(result.replace(/^\s+\[SIT\]\s+/, ''));
    expect(parsed.cc[0].kick).toBe(true);
  });

  it('omits cc entry for expired kick lockout', () => {
    const summary = makeSummaryWithKick('Player1', 20, 5);
    const result = buildJsonSituationSnapshot(minimalParams([summary], 'Player1'));
    const parsed = JSON.parse(result.replace(/^\s+\[SIT\]\s+/, ''));
    expect(parsed.cc).toBeUndefined();
  });
});

describe('buildMatchTimeline — [MATCH END] block', () => {
  it('emits [MATCH END] header at match end time', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        matchStartMs: 0,
        matchEndMs: 300_000,
      }),
    );
    expect(result).toContain('[MATCH END]');
    expect(result).toContain('5:00');
  });

  it('shows final dampening when bracket is provided', () => {
    // bracket=undefined → no damp line; bracket provided → damp shown
    const withBracket = buildMatchTimeline(
      makeBaseParams({
        matchStartMs: 0,
        matchEndMs: 300_000,
        bracket: '3v3',
      } as any),
    );
    expect(withBracket).toContain('damp:');

    const withoutBracket = buildMatchTimeline(
      makeBaseParams({
        matchStartMs: 0,
        matchEndMs: 300_000,
      }),
    );
    // No damp info when bracket is absent
    expect(withoutBracket).not.toContain('damp:');
  });

  it('shows surviving friend HP at match end using playerIdMap', () => {
    const friend = makeUnit('p1', {
      name: 'Feramonk',
      spec: CombatUnitSpec.Monk_Mistweaver,
      advancedActions: [
        makeAdvancedAction(295_000, 0, 0, 500_000, 225_000), // 45% HP at t=295s (5s before end)
      ],
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        matchStartMs: 0,
        matchEndMs: 300_000,
        friends: [friend],
        playerIdMap: new Map([['Feramonk', 1]]),
      }),
    );
    expect(result).toContain('[MATCH END]');
    // Friend shown as pid:pct%
    expect(result).toContain('1:45%');
  });

  it('shows dead friend as dead(M:SS) rather than HP', () => {
    const friend = makeUnit('p1', {
      name: 'Feramonk',
      spec: CombatUnitSpec.Monk_Mistweaver,
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        matchStartMs: 0,
        matchEndMs: 300_000,
        friends: [friend],
        playerIdMap: new Map([['Feramonk', 1]]),
        friendlyDeaths: [{ spec: 'Mistweaver Monk', name: 'Feramonk', atSeconds: 83 }],
      }),
    );
    expect(result).toContain('[MATCH END]');
    expect(result).toContain('1:dead(1:23)');
  });

  it('shows enemy HP and dead enemies using enemyIdMap', () => {
    const enemy = makeUnit('e1', {
      name: 'EnemyMage',
      spec: CombatUnitSpec.Mage_Frost,
      advancedActions: [
        makeAdvancedAction(290_000, 0, 0, 600_000, 132_000), // 22% HP
      ],
    });
    const deadEnemy = makeUnit('e2', {
      name: 'EnemyWarrior',
      spec: CombatUnitSpec.None,
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        matchStartMs: 0,
        matchEndMs: 300_000,
        enemies: [enemy, deadEnemy],
        enemyIdMap: new Map([
          ['EnemyMage', 4],
          ['EnemyWarrior', 5],
        ]),
        enemyDeaths: [{ spec: 'Arms Warrior', name: 'EnemyWarrior', atSeconds: 165 }],
      }),
    );
    expect(result).toContain('[MATCH END]');
    // alive enemy shown as pct%
    expect(result).toContain('4:22%');
    // dead enemy shown as dead(M:SS)
    expect(result).toContain('5:dead(2:45)');
  });

  it('combines friends and enemies in one state line', () => {
    const friend = makeUnit('p1', {
      name: 'Feramonk',
      spec: CombatUnitSpec.Monk_Mistweaver,
      advancedActions: [makeAdvancedAction(295_000, 0, 0, 500_000, 250_000)], // 50%
    });
    const enemy = makeUnit('e1', {
      name: 'EnemyMage',
      spec: CombatUnitSpec.Mage_Frost,
      advancedActions: [makeAdvancedAction(295_000, 0, 0, 600_000, 120_000)], // 20%
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        matchStartMs: 0,
        matchEndMs: 300_000,
        friends: [friend],
        enemies: [enemy],
        playerIdMap: new Map([['Feramonk', 1]]),
        enemyIdMap: new Map([['EnemyMage', 4]]),
      }),
    );
    expect(result).toContain('friends');
    expect(result).toContain('/ enemies');
    expect(result).toContain('1:50%');
    expect(result).toContain('4:20%');
  });

  it('shows ? when HP data is unavailable for an alive player', () => {
    // Unit with no advancedActions — getUnitHpAtTimestamp returns null
    const friend = makeUnit('p1', {
      name: 'Feramonk',
      spec: CombatUnitSpec.Monk_Mistweaver,
      // No advancedActions set — HP data unavailable
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        matchStartMs: 0,
        matchEndMs: 300_000,
        friends: [friend],
        playerIdMap: new Map([['Feramonk', 1]]),
      }),
    );
    expect(result).toContain('[MATCH END]');
    expect(result).toContain('1:?');
  });
});

// ── buildMatchTimeline — B42: dead players in [STATE] ticks ──────────────────

describe('buildMatchTimeline — B42: dead players shown as :dead in [STATE] ticks', () => {
  it('shows :dead for a friendly player in [STATE] ticks at and after their death second', () => {
    const matchStartMs = 0;
    const matchEndMs = 60_000;
    const deathAtSeconds = 20;

    const friend = makeUnit('unit-1', {
      name: 'Simplesauce',
      advancedActions: [makeAdvancedAction(15_000, 0, 0, 500_000, 100_000)], // low HP before death
    });
    const owner = makeUnit('unit-2', {
      name: 'Feramonk',
      advancedActions: [makeAdvancedAction(15_000, 0, 0, 500_000, 400_000)],
    });

    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        friends: [owner, friend],
        friendlyDeaths: [{ spec: 'Unholy Death Knight', name: 'Simplesauce', atSeconds: deathAtSeconds }],
        matchStartMs,
        matchEndMs,
      }),
    );

    // At t >= 20, Simplesauce should appear as :dead in [STATE] lines
    const stateLines = result.split('\n').filter((l) => l.includes('[STATE]'));
    const linesAtOrAfterDeath = stateLines.filter((l) => {
      const m = l.match(/^(\d+):(\d+)/);
      if (!m) return false;
      const sec = parseInt(m[1]) * 60 + parseInt(m[2]);
      return sec >= deathAtSeconds;
    });
    expect(linesAtOrAfterDeath.length).toBeGreaterThan(0);
    expect(linesAtOrAfterDeath.every((l) => l.includes('Simplesauce:dead'))).toBe(true);
  });

  it('shows :dead for an enemy in critical-window [STATE] ticks after their death', () => {
    const matchStartMs = 0;
    const matchEndMs = 60_000;
    const deathAtSeconds = 15;

    const enemy = makeUnit('enemy-1', {
      name: 'Dzinked',
      reaction: CombatUnitReaction.Hostile,
      advancedActions: [{ ...makeAdvancedAction(10_000, 0, 0, 500_000, 50_000), advancedActorId: 'enemy-1' }],
    });

    const result = buildMatchTimeline(
      makeBaseParams({
        enemies: [enemy],
        enemyDeaths: [{ spec: 'Holy Paladin', name: 'Dzinked', atSeconds: deathAtSeconds }],
        // trigger critical window so enemy HP is shown
        friendlyDeaths: [{ spec: 'Mistweaver Monk', name: 'Feramonk', atSeconds: 25 }],
        matchStartMs,
        matchEndMs,
      }),
    );

    const stateLines = result.split('\n').filter((l) => l.includes('[STATE]'));
    const linesAfterDeath = stateLines.filter((l) => {
      const m = l.match(/^(\d+):(\d+)/);
      if (!m) return false;
      const sec = parseInt(m[1]) * 60 + parseInt(m[2]);
      return sec >= deathAtSeconds && l.includes('enemies');
    });
    expect(linesAfterDeath.length).toBeGreaterThan(0);
    expect(linesAfterDeath.every((l) => l.includes('Dzinked:dead'))).toBe(true);
  });
});

describe('buildMatchTimeline — [RES] deduplication (F115/F104)', () => {
  it('suppresses redundant [RES] snapshots within 2s of each other', () => {
    const matchStartMs = 1000000;
    const matchEndMs = 1060000;
    const owner = {
      id: '1',
      name: 'Player1',
      spec: CombatUnitSpec.Paladin_Holy,
      advancedActions: [],
      spellCastEvents: [],
    } as any;

    const result = buildMatchTimeline({
      owner,
      ownerSpec: 'Holy Paladin',
      ownerCDs: [
        {
          spellId: '1',
          spellName: 'Bubble',
          tag: 'Defensive',
          cooldownSeconds: 300,
          maxChargesDetected: 1,
          casts: [
            { timeSeconds: 10 },
            { timeSeconds: 11.5 }, // within 2s
            { timeSeconds: 14 }, // > 2s after 10
          ],
          availableWindows: [],
          neverUsed: false,
        },
      ],
      teammateCDs: [],
      enemyCDTimeline: { players: [], alignedBurstWindows: [] },
      ccTrinketSummaries: [],
      dispelSummary: {
        allyCleanse: [],
        ourPurges: [],
        hostilePurges: [],
        missedCleanseWindows: [],
        ccEfficiency: [],
        missedPurgeWindows: [],
      } as any,
      friendlyDeaths: [],
      enemyDeaths: [],
      pressureWindows: [],
      healingGaps: [],
      friends: [owner],
      matchStartMs,
      matchEndMs,
      isHealer: false,
    });

    const resLines = result.split('\n').filter((l) => l.includes('[RES]'));

    // Snapshot at 10.0 (emitted)
    // Snapshot at 11.5 (suppressed: 11.5 - 10.0 < 2)
    // Snapshot at 14.0 (emitted: 14.0 - 10.0 > 2)
    expect(resLines.length).toBe(2);

    const lines = result.split('\n').map((l) => l.trim());
    const bubbleIdx = lines.findIndex((l) => l.includes('0:10  [YOU] [CD]   Bubble'));
    const otherIdx = lines.findIndex((l) => l.includes('0:11  [YOU] [CD]   Bubble'));
    const nextIdx = lines.findIndex((l) => l.includes('0:14  [YOU] [CD]   Bubble'));

    expect(lines[bubbleIdx + 1]).toContain('[RES]');
    expect(lines[otherIdx + 1]).not.toContain('[RES]');
    expect(lines[nextIdx + 1]).toContain('[RES]');
  });
});

describe('buildMatchTimeline — B106/F84: [STATE] ordering', () => {
  it('pins the log owner first in [STATE] friendly sections', () => {
    const matchStartMs = 0;
    const matchEndMs = 60_000;
    const owner = makeUnit('unit-owner', {
      name: 'Feramonk',
      advancedActions: [makeAdvancedAction(0, 0, 0, 500_000, 500_000)],
    });
    // Align ID to make getUnitHpAtTimestamp work
    (owner.advancedActions[0] as any).advancedActorId = 'unit-owner';

    const friend = makeUnit('unit-friend', {
      name: 'Simplesauce',
      advancedActions: [makeAdvancedAction(0, 0, 0, 500_000, 500_000)],
    });
    (friend.advancedActions[0] as any).advancedActorId = 'unit-friend';

    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        friends: [friend, owner], // out of order
        // trigger critical window to emit [STATE]
        friendlyDeaths: [{ spec: 'Mistweaver Monk', name: 'Feramonk', atSeconds: 5 }],
        matchStartMs,
        matchEndMs,
      }),
    );

    const stateLine = result.split('\n').find((l) => l.includes('[STATE]'));
    expect(stateLine).toContain('friends Feramonk:100 Simplesauce:100');
  });

  it('sorts [STATE] by playerIdMap when provided', () => {
    const matchStartMs = 0;
    const matchEndMs = 60_000;
    const p1 = makeUnit('p1', { name: 'Player1', advancedActions: [makeAdvancedAction(0, 0, 0)] });
    (p1.advancedActions[0] as any).advancedActorId = 'p1';
    const p2 = makeUnit('p2', { name: 'Player2', advancedActions: [makeAdvancedAction(0, 0, 0)] });
    (p2.advancedActions[0] as any).advancedActorId = 'p2';
    const p3 = makeUnit('p3', { name: 'Player3', advancedActions: [makeAdvancedAction(0, 0, 0)] });
    (p3.advancedActions[0] as any).advancedActorId = 'p3';

    const result = buildMatchTimeline(
      makeBaseParams({
        owner: p1,
        friends: [p3, p1, p2],
        playerIdMap: new Map([
          ['Player1', 1],
          ['Player2', 2],
          ['Player3', 3],
        ]),
        // trigger critical window
        friendlyDeaths: [{ spec: 'Spec', name: 'Player1', atSeconds: 5 }],
        matchStartMs,
        matchEndMs,
      }),
    );

    const stateLine = result.split('\n').find((l) => l.includes('[STATE]'));
    expect(stateLine).toContain('friends 1:100 2:100 3:100');
  });
});

describe('buildMatchTimeline — B38: Healer CD promotion', () => {
  it('promotes untagged healer casts with CD >= 30s to [YOU] [CD]', () => {
    const matchStartMs = 0;
    const matchEndMs = 60_000;
    const owner = makeUnit('u1', {
      name: 'Feramonk',
      spec: CombatUnitSpec.Priest_Holy,
      spellCastEvents: [
        // Pain Suppression (33206) has 180s CD in spellEffects.json
        makeSpellCastEvent('33206', matchStartMs + 10_000, 'u1', 'self', 'u1', 'Feramonk'),
      ],
    });

    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [], // Empty, so it must be found in spellCastEvents and promoted
        matchStartMs,
        matchEndMs,
      }),
    );

    expect(result).toContain('0:10  [YOU] [CD]   Pain Suppression');
  });

  it('does NOT promote untagged casts with CD < 30s', () => {
    const matchStartMs = 0;
    const matchEndMs = 60_000;
    const owner = makeUnit('u1', {
      name: 'Feramonk',
      spec: CombatUnitSpec.Priest_Holy,
      spellCastEvents: [
        // Flash Heal (2061) is not in metadata or has no CD
        makeSpellCastEvent('2061', matchStartMs + 10_000, 'u2', 'Friend', 'u1', 'Feramonk', 0, 'Flash Heal'),
      ],
    });

    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        isHealer: true,
        ownerCDs: [],
        matchStartMs,
        matchEndMs,
      }),
    );

    expect(result).toContain('0:10  [YOU] [CAST]   Flash Heal');
    expect(result).not.toContain('[YOU] [CD]   Flash Heal');
  });
});

describe('buildMatchTimeline — F138 periodic full [RES] refresh', () => {
  it('re-emits a full rdy: list (not delta) at least every 60s in long matches', () => {
    // An always-ready CD (never cast) should appear by name in the full rdy: form.
    const alwaysReady = makeCD('Divine Toll', 60, true);
    alwaysReady.spellId = '2';
    // A second CD cast at 6s and 66s forces a [RES] emission at both timestamps.
    const trigger = makeCD('Avenging Wrath', 120);
    trigger.casts = [{ timeSeconds: 6 }, { timeSeconds: 66 }] as IMajorCooldownInfo['casts'];

    const result = buildMatchTimeline(
      makeBaseParams({
        owner: makeOwner('Feramonk'),
        ownerCDs: [alwaysReady, trigger],
      }),
    );

    // Full form prints "rdy:Divine Toll"; delta form would print "rdy:Δ".
    // Without the 60s refresh, the 1:06 snapshot would be delta and omit the name.
    const fullRdyCount = (result.match(/rdy:Divine Toll/g) ?? []).length;
    expect(fullRdyCount).toBeGreaterThanOrEqual(2);
  });
});

describe('buildMatchTimeline — F113/F114: Event-Gating and [STATE] pruning', () => {
  it('suppresses all [STATE] ticks in a low-activity game (no critical windows)', () => {
    const matchStartMs = 0;
    const matchEndMs = 60_000;
    const owner = makeUnit('u1', {
      name: 'Player1',
      advancedActions: [makeAdvancedAction(0, 0, 0)],
    });
    (owner.advancedActions[0] as any).advancedActorId = 'u1';

    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        friends: [owner],
        matchStartMs,
        matchEndMs,
      }),
    );

    const hasState = result.split('\n').some((l) => l.includes('[STATE]'));
    expect(hasState).toBe(false);
  });

  it('emits [STATE] ticks only during a critical window (DMG SPIKE)', () => {
    const matchStartMs = 0;
    const matchEndMs = 60_000;
    const owner = makeUnit('u1', {
      name: 'Player1',
      advancedActions: [
        makeAdvancedAction(0, 0, 0),
        makeAdvancedAction(30_000, 0, 0), // at spike
        makeAdvancedAction(60_000, 0, 0),
      ],
    });
    owner.advancedActions.forEach((a) => ((a as any).advancedActorId = 'u1'));

    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        friends: [owner],
        // Spike at 30s (±5s critical window)
        pressureWindows: [
          {
            targetName: 'Player1',
            targetSpec: 'Spec',
            totalDamage: 2_000_000, // Above threshold
            fromSeconds: 30,
            toSeconds: 32,
          } as any,
        ],
        matchStartMs,
        matchEndMs,
      }),
    );

    const stateLines = result.split('\n').filter((l) => l.includes('[STATE]'));
    expect(stateLines.length).toBeGreaterThan(0);

    // Check that all state ticks are within [25s, 37s] (window is ±5s around 30-32)
    stateLines.forEach((l) => {
      const m = l.match(/^(\d+):(\d+)/);
      if (m) {
        const sec = parseInt(m[1]) * 60 + parseInt(m[2]);
        expect(sec).toBeGreaterThanOrEqual(25);
        expect(sec).toBeLessThanOrEqual(37);
      }
    });
  });
});

describe('buildMatchTimeline — KILL SEQUENCE block (characterization)', () => {
  it('emits a KILL SEQUENCE with [KILL] line for a sub-90s match with a friendly death', () => {
    const owner = makeOwner('Feramonk', CombatUnitSpec.Priest_Holy);
    // Build a real unit for the dying player so damageIn attribution works
    const dyingUnit = makeUnit('dying-1', {
      name: 'Simplesauce',
      damageIn: [
        {
          logLine: { timestamp: 38_000 },
          effectiveAmount: -100_000,
          srcUnitName: 'Natjkis',
          srcUnitFlags: 0x00000040, // hostile player
          spellName: 'Obliterate',
        } as any,
      ],
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        matchEndMs: 80_000,
        friendlyDeaths: [{ spec: 'Unholy Death Knight', name: 'Simplesauce', atSeconds: 40 }],
        friends: [owner, dyingUnit],
      }),
    );
    expect(result).toContain('KILL SEQUENCE');
    expect(result).toContain('[KILL]');
  });

  it('omits KILL SEQUENCE for matches >= 90s', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        matchEndMs: 120_000,
        friendlyDeaths: [{ spec: 'Unholy Death Knight', name: 'Simplesauce', atSeconds: 40 }],
      }),
    );
    expect(result).not.toContain('KILL SEQUENCE');
  });
});

describe('buildMatchTimeline — F152 Missed Purges', () => {
  it('F152: formats missed whitelisted purges in the timeline', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: makeOwner('Purger', CombatUnitSpec.Priest_Shadow),
        dispelSummary: {
          ...makeEmptyDispelSummary(),
          missedPurgeWindows: [
            {
              timeSeconds: 10,
              durationSeconds: 15,
              expectedBuffDurationSeconds: 20,
              enemyName: 'Dzinked',
              enemySpec: 'Holy Paladin',
              spellName: 'Power Infusion',
              spellId: '10060', // whitelisted
              priority: 'High',
              purgeWasOnCD: false,
              teamUnderPressure: false,
            },
          ],
        },
      }),
    );
    expect(result).toContain('[MISSED PURGE OPPORTUNITY]');
    expect(result).toContain('Power Infusion active on Dzinked');
    expect(result).toContain('15s');
  });
});

describe('buildMatchTimeline — Grounding Totem NPC ID detection', () => {
  it('F143: detects Grounding Totem by NPC ID 5925 and annotates absorbs', () => {
    const totemGuid = 'Creature-0-3132-1504-17829-5925-00002FBA9E';
    const result = buildMatchTimeline(
      makeBaseParams({
        owner: {
          ...makeOwner('Feramonk'),
          id: 'player-1',
          spellCastEvents: [makeSpellCastEvent('204336', 30_000, '', undefined, 'player-1', 'Feramonk')],
        } as any,
        ownerCDs: [
          {
            spellId: '204336',
            spellName: 'Grounding Totem',
            casts: [
              {
                timeSeconds: 30,
              },
            ],
          } as any,
        ],
        allUnits: [
          {
            id: totemGuid,
            name: 'Erdungstotem',
            ownerId: 'player-1',
            deathRecords: [],
            absorbsIn: [
              {
                timestamp: 31_000,
                spellId: '118',
                spellName: 'Polymorph',
                effectiveAmount: 0,
              },
            ],
          } as any,
        ],
      }),
    );
    expect(result).toContain('[YOU] [CD]   Grounding Totem [ABSORBED: Polymorph]');
  });
});

describe('isCriticalNonPlayerUnit', () => {
  it('returns true for whitelisted critical NPCs', () => {
    // 19668 is Shadowfiend
    const shadowfiend = {
      id: 'Creature-0-3132-1504-17829-19668-00002FBA9E',
      type: CombatUnitType.Pet,
    } as unknown as ICombatUnit;
    expect(isCriticalNonPlayerUnit(shadowfiend)).toBe(true);

    // 5925 is Grounding Totem
    const groundingTotem = {
      id: 'Creature-0-3132-1504-17829-5925-00002FBA9E',
      type: CombatUnitType.Pet,
    } as unknown as ICombatUnit;
    expect(isCriticalNonPlayerUnit(groundingTotem)).toBe(true);
  });

  it('returns false for generic pets that are not in the whitelist', () => {
    const genericPet = {
      id: 'Pet-0-3132-1504-17829-99999-00002FBA9E',
      type: CombatUnitType.Pet,
    } as unknown as ICombatUnit;
    expect(isCriticalNonPlayerUnit(genericPet)).toBe(false);
  });

  it('returns false for player units', () => {
    const playerUnit = {
      id: 'Player-3676-0834375A',
      type: CombatUnitType.Player,
    } as unknown as ICombatUnit;
    expect(isCriticalNonPlayerUnit(playerUnit)).toBe(false);
  });
});

describe('buildMatchTimeline — Dampening Milestone Alerts (F149)', () => {
  it('emits dampening alert immediately at t=0 when initial dampening matches or exceeds milestone', () => {
    const p1 = makeUnit('p1', { name: 'Priest', spec: CombatUnitSpec.Priest_Discipline, info: { teamId: '0' } });
    const p2 = makeUnit('p2', { name: 'Paladin', spec: CombatUnitSpec.Paladin_Holy, info: { teamId: '1' } });
    const params = makeBaseParams({
      bracket: '2v2',
      friends: [p1],
      enemies: [p2],
      matchStartMs: 0,
      matchEndMs: 60_000,
    });
    const result = buildMatchTimeline(params);
    expect(result).toContain('0:00  [DAMPENING ALERT: 30%]');
    expect(result).not.toContain('0:00  [DAMPENING ALERT: 50%]');
  });

  it('emits dampening alert at the exact second milestone is reached/crossed', () => {
    const dose1 = makeAuraEvent(LogEvent.SPELL_AURA_APPLIED_DOSE as any, '110310', 45_000, 'h', 'h');
    (dose1.logLine as any).parameters[12] = 32; // 32% at 45s
    const dose2 = makeAuraEvent(LogEvent.SPELL_AURA_APPLIED_DOSE as any, '110310', 90_000, 'h', 'h');
    (dose2.logLine as any).parameters[12] = 51; // 51% at 90s

    const p = makeUnit('Feramonk', { name: 'Feramonk', auraEvents: [dose1 as any, dose2 as any] });
    const params = makeBaseParams({
      bracket: '3v3',
      friends: [p],
      matchStartMs: 0,
      matchEndMs: 120_000,
    });
    const result = buildMatchTimeline(params);
    expect(result).toContain('0:45  [DAMPENING ALERT: 30%]');
    expect(result).toContain('1:30  [DAMPENING ALERT: 50%]');
    expect(result).not.toContain('[DAMPENING ALERT: 70%]');
  });
});

describe('buildMatchTimeline — Rot Pressure Detection (F147)', () => {
  it('emits [ROT PRESSURE] when a player has 3+ dots and sub-40% HP for >3s', () => {
    // 3 dots applied at T=10s
    const corruption = makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '172', 10_000, 'enemy-1', 'unit-1');
    const agony = makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '980', 10_000, 'enemy-1', 'unit-1');
    const siphon = makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '63106', 10_000, 'enemy-1', 'unit-1');

    const p1 = makeUnit('unit-1', {
      name: 'Priest',
      spec: CombatUnitSpec.Priest_Discipline,
      auraEvents: [corruption, agony, siphon],
      advancedActions: [
        makeAdvancedAction(10_000, 0, 0, 100_000, 35_000), // 35% HP
        makeAdvancedAction(11_000, 0, 0, 100_000, 35_000),
        makeAdvancedAction(12_000, 0, 0, 100_000, 35_000),
        makeAdvancedAction(13_000, 0, 0, 100_000, 35_000), // Active for 4 ticks (T=10,11,12,13)
      ],
    });

    const params = makeBaseParams({
      friends: [p1],
      matchStartMs: 0,
      matchEndMs: 30_000,
      playerIdMap: new Map([['Priest', 1]]),
    });
    const result = buildMatchTimeline(params);
    expect(result).toContain('0:13  [ROT PRESSURE]   1 (Discipline Priest) at 35% HP with 3 active DoTs');
  });

  it('does NOT emit [ROT PRESSURE] if the duration is 3s or less', () => {
    const corruption = makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '172', 10_000, 'enemy-1', 'unit-1');
    const agony = makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '980', 10_000, 'enemy-1', 'unit-1');
    const siphon = makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '63106', 10_000, 'enemy-1', 'unit-1');

    const p1 = makeUnit('unit-1', {
      name: 'Priest',
      spec: CombatUnitSpec.Priest_Discipline,
      auraEvents: [corruption, agony, siphon],
      advancedActions: [
        makeAdvancedAction(10_000, 0, 0, 100_000, 35_000), // 35% HP
        makeAdvancedAction(11_000, 0, 0, 100_000, 35_000),
        makeAdvancedAction(12_000, 0, 0, 100_000, 35_000), // 3 ticks total
        makeAdvancedAction(13_000, 0, 0, 100_000, 100_000), // 100% HP (breaks the chain)
      ],
    });

    const params = makeBaseParams({
      friends: [p1],
      matchStartMs: 0,
      matchEndMs: 30_000,
      playerIdMap: new Map([['Priest', 1]]),
    });
    const result = buildMatchTimeline(params);
    expect(result).not.toContain('[ROT PRESSURE]');
  });
});

describe('buildMatchTimeline — Repetitive Cast Folding (F151)', () => {
  it('folds consecutive identical casts in low pressure', () => {
    const spell1 = makeSpellCastEvent('585', 10_000, 'enemy-1', 'Enemy', 'unit-1', 'Priest', 0, 'Smite');
    const spell2 = makeSpellCastEvent('585', 12_000, 'enemy-1', 'Enemy', 'unit-1', 'Priest', 0, 'Smite');
    const spell3 = makeSpellCastEvent('585', 14_000, 'enemy-1', 'Enemy', 'unit-1', 'Priest', 0, 'Smite');

    const p1 = makeUnit('unit-1', {
      name: 'Priest',
      spec: CombatUnitSpec.Priest_Discipline,
      spellCastEvents: [spell1, spell2, spell3],
      advancedActions: [
        makeAdvancedAction(10_000, 0, 0, 100_000, 100_000),
        makeAdvancedAction(12_000, 0, 0, 100_000, 100_000),
        makeAdvancedAction(14_000, 0, 0, 100_000, 100_000),
      ],
    });

    const params = makeBaseParams({
      owner: p1,
      friends: [p1],
      matchStartMs: 0,
      matchEndMs: 30_000,
      playerIdMap: new Map([['Priest', 1]]),
      enemyIdMap: new Map([['Enemy', 2]]),
    });

    const result = buildMatchTimeline(params);
    expect(result).toContain('0:10  [YOU] [CAST]   Smite (x3) → 2');
    expect(result).not.toContain('0:12  [YOU] [CAST]');
    expect(result).not.toContain('0:14  [YOU] [CAST]');
  });

  it('does NOT fold consecutive identical casts in critical windows', () => {
    const spell1 = makeSpellCastEvent('585', 10_000, 'enemy-1', 'Enemy', 'unit-1', 'Priest', 0, 'Smite');
    const spell2 = makeSpellCastEvent('585', 12_000, 'enemy-1', 'Enemy', 'unit-1', 'Priest', 0, 'Smite');

    const p1 = makeUnit('unit-1', {
      name: 'Priest',
      spec: CombatUnitSpec.Priest_Discipline,
      spellCastEvents: [spell1, spell2],
      advancedActions: [
        makeAdvancedAction(10_000, 0, 0, 100_000, 100_000),
        makeAdvancedAction(12_000, 0, 0, 100_000, 100_000),
      ],
    });

    // Make t=10 and t=12 fall in a critical window by adding a friendly death at t=18 (18_000ms)
    const params = makeBaseParams({
      owner: p1,
      friends: [p1],
      friendlyDeaths: [{ spec: 'Discipline Priest', name: 'Priest', atSeconds: 18 }],
      matchStartMs: 0,
      matchEndMs: 30_000,
      playerIdMap: new Map([['Priest', 1]]),
      enemyIdMap: new Map([['Enemy', 2]]),
    });

    const result = buildMatchTimeline(params);
    expect(result).toContain('0:10  [YOU] [CAST]   Smite → 2');
    expect(result).toContain('0:12  [YOU] [CAST]   Smite → 2');
    expect(result).not.toContain('Smite (x2)');
  });

  it('does NOT fold consecutive casts with annotations or different targets', () => {
    // Diff targets: t=10 to EnemyA, t=12 to EnemyB
    const spell1 = makeSpellCastEvent('585', 10_000, 'enemy-A', 'EnemyA', 'unit-1', 'Priest', 0, 'Smite');
    const spell2 = makeSpellCastEvent('585', 12_000, 'enemy-B', 'EnemyB', 'unit-1', 'Priest', 0, 'Smite');

    const p1 = makeUnit('unit-1', {
      name: 'Priest',
      spec: CombatUnitSpec.Priest_Discipline,
      spellCastEvents: [spell1, spell2],
      advancedActions: [
        makeAdvancedAction(10_000, 0, 0, 100_000, 100_000),
        makeAdvancedAction(12_000, 0, 0, 100_000, 100_000),
      ],
    });

    const params = makeBaseParams({
      owner: p1,
      friends: [p1],
      matchStartMs: 0,
      matchEndMs: 30_000,
      playerIdMap: new Map([['Priest', 1]]),
      enemyIdMap: new Map([
        ['EnemyA', 2],
        ['EnemyB', 3],
      ]),
    });

    const result = buildMatchTimeline(params);
    expect(result).toContain('0:10  [YOU] [CAST]   Smite → 2');
    expect(result).toContain('0:12  [YOU] [CAST]   Smite → 3');
    expect(result).not.toContain('Smite (x2)');
  });

  it('does NOT fold consecutive casts if one has annotations (e.g. totem target)', () => {
    const GUARDIAN_FLAGS = 0x00002000;
    const spell1 = makeSpellCastEvent(
      '585',
      10_000,
      'totem-1',
      'Grounding Totem',
      'unit-1',
      'Priest',
      GUARDIAN_FLAGS,
      'Smite',
    );
    const spell2 = makeSpellCastEvent('585', 12_000, 'enemy-1', 'Enemy', 'unit-1', 'Priest', 0, 'Smite');

    const p1 = makeUnit('unit-1', {
      name: 'Priest',
      spec: CombatUnitSpec.Priest_Discipline,
      spellCastEvents: [spell1, spell2],
      advancedActions: [
        makeAdvancedAction(10_000, 0, 0, 100_000, 100_000),
        makeAdvancedAction(12_000, 0, 0, 100_000, 100_000),
      ],
    });

    const params = makeBaseParams({
      owner: p1,
      friends: [p1],
      matchStartMs: 0,
      matchEndMs: 30_000,
      playerIdMap: new Map([['Priest', 1]]),
      enemyIdMap: new Map([
        ['Enemy', 2],
        ['Grounding Totem', 3],
      ]),
    });

    const result = buildMatchTimeline(params);
    expect(result).toContain('0:10  [YOU] [CAST]   Smite → 3 [absorbed: Grounding Totem]');
    expect(result).toContain('0:12  [YOU] [CAST]   Smite → 2');
    expect(result).not.toContain('Smite (x2)');
  });
});

describe('buildMatchTimeline — PvP Trinket status at teammate death (F146)', () => {
  it('flags teammate death with PvP Trinket available when never used', () => {
    const p1 = makeUnit('unit-1', {
      name: 'Priest',
      spec: CombatUnitSpec.Priest_Discipline,
      advancedActions: [makeAdvancedAction(10_000, 0, 0, 100_000, 100_000)],
    });
    const summary = {
      playerName: 'Priest',
      playerSpec: 'Discipline Priest',
      trinketType: 'Gladiator' as any,
      trinketCooldownSeconds: 120,
      ccInstances: [],
      trinketUseTimes: [],
      missedTrinketWindows: [],
      rootInstances: [],
      disarmInstances: [],
      interruptInstances: [],
      ccAvoidedInstances: [],
    };
    const params = makeBaseParams({
      friends: [p1],
      friendlyDeaths: [{ spec: 'Discipline Priest', name: 'Priest', atSeconds: 10 }],
      ccTrinketSummaries: [summary],
      matchStartMs: 0,
      matchEndMs: 30_000,
    });
    const result = buildMatchTimeline(params);
    expect(result).toContain('0:10  [DEATH]  Priest (Discipline Priest — friendly) (PvP Trinket available)');
  });

  it('flags teammate death when trinket was used but cooldown expired', () => {
    const p1 = makeUnit('unit-1', {
      name: 'Priest',
      spec: CombatUnitSpec.Priest_Discipline,
      advancedActions: [makeAdvancedAction(150_000, 0, 0, 100_000, 100_000)],
    });
    const summary = {
      playerName: 'Priest',
      playerSpec: 'Discipline Priest',
      trinketType: 'Gladiator' as any,
      trinketCooldownSeconds: 120,
      ccInstances: [],
      trinketUseTimes: [10],
      missedTrinketWindows: [],
      rootInstances: [],
      disarmInstances: [],
      interruptInstances: [],
      ccAvoidedInstances: [],
    };
    const params = makeBaseParams({
      friends: [p1],
      friendlyDeaths: [{ spec: 'Discipline Priest', name: 'Priest', atSeconds: 150 }],
      ccTrinketSummaries: [summary],
      matchStartMs: 0,
      matchEndMs: 180_000,
    });
    const result = buildMatchTimeline(params);
    expect(result).toContain('2:30  [DEATH]  Priest (Discipline Priest — friendly) (PvP Trinket available)');
  });

  it('does NOT flag teammate death when trinket is on cooldown', () => {
    const p1 = makeUnit('unit-1', {
      name: 'Priest',
      spec: CombatUnitSpec.Priest_Discipline,
      advancedActions: [makeAdvancedAction(50_000, 0, 0, 100_000, 100_000)],
    });
    const summary = {
      playerName: 'Priest',
      playerSpec: 'Discipline Priest',
      trinketType: 'Gladiator' as any,
      trinketCooldownSeconds: 120,
      ccInstances: [],
      trinketUseTimes: [10],
      missedTrinketWindows: [],
      rootInstances: [],
      disarmInstances: [],
      interruptInstances: [],
      ccAvoidedInstances: [],
    };
    const params = makeBaseParams({
      friends: [p1],
      friendlyDeaths: [{ spec: 'Discipline Priest', name: 'Priest', atSeconds: 50 }],
      ccTrinketSummaries: [summary],
      matchStartMs: 0,
      matchEndMs: 60_000,
    });
    const result = buildMatchTimeline(params);
    expect(result).toContain('0:50  [DEATH]  Priest (Discipline Priest — friendly)');
    expect(result).not.toContain('PvP Trinket available');
  });

  it('does NOT flag teammate death when trinket type is Relentless', () => {
    const p1 = makeUnit('unit-1', {
      name: 'Priest',
      spec: CombatUnitSpec.Priest_Discipline,
      advancedActions: [makeAdvancedAction(10_000, 0, 0, 100_000, 100_000)],
    });
    const summary = {
      playerName: 'Priest',
      playerSpec: 'Discipline Priest',
      trinketType: 'Relentless' as any,
      trinketCooldownSeconds: 120,
      ccInstances: [],
      trinketUseTimes: [],
      missedTrinketWindows: [],
      rootInstances: [],
      disarmInstances: [],
      interruptInstances: [],
      ccAvoidedInstances: [],
    };
    const params = makeBaseParams({
      friends: [p1],
      friendlyDeaths: [{ spec: 'Discipline Priest', name: 'Priest', atSeconds: 10 }],
      ccTrinketSummaries: [summary],
      matchStartMs: 0,
      matchEndMs: 30_000,
    });
    const result = buildMatchTimeline(params);
    expect(result).toContain('0:10  [DEATH]  Priest (Discipline Priest — friendly)');
    expect(result).not.toContain('PvP Trinket available');
  });
});

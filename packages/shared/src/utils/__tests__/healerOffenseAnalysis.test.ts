import { CombatUnitReaction, ICombatUnit, LogEvent } from '@wowarenalogs/parser';

import { IEnemyCDTimeline } from '../enemyCDs';
import { computeSlackSegments } from '../healerOffenseAnalysis';
import { makeAdvancedAction, makeSpellCastEvent, makeUnit } from './testHelpers';

const T0 = 1_000_000; // match start ms

/** advancedActions giving a unit full HP for the whole match (samples every 5s for 120s). */
function fullHpActions(): unknown[] {
  const actions: unknown[] = [];
  for (let s = 0; s <= 120; s += 5) actions.push(makeAdvancedAction(T0 + s * 1000, 0, 0, 500_000, 500_000));
  return actions;
}

function makeFriend(id: string, overrides: Parameters<typeof makeUnit>[1] = {}): ICombatUnit {
  return makeUnit(id, {
    reaction: CombatUnitReaction.Friendly,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    advancedActions: fullHpActions() as any[],
    ...overrides,
  });
}

function emptyEnemyTimeline(): IEnemyCDTimeline {
  return { players: [], alignedBurstWindows: [] };
}

const combat = { startTime: T0, endTime: T0 + 120_000 };

describe('computeSlackSegments', () => {
  it('returns one full-match slack segment when team is topped and nothing is active', () => {
    const owner = makeFriend('owner');
    const { advancedLoggingAvailable, segments } = computeSlackSegments(
      combat,
      owner,
      [owner],
      [makeUnit('enemy-1', { reaction: CombatUnitReaction.Hostile })],
      emptyEnemyTimeline(),
      [],
      [],
    );
    expect(advancedLoggingAvailable).toBe(true);
    expect(segments.length).toBe(1);
    expect(segments[0].fromSeconds).toBe(0);
    expect(segments[0].durationSeconds).toBeGreaterThanOrEqual(115);
    expect(segments[0].idle).toBe(true);
  });

  it('disables entirely when a friendly unit has no advancedActions', () => {
    const owner = makeFriend('owner');
    const mate = makeUnit('mate', { reaction: CombatUnitReaction.Friendly }); // no advancedActions
    const { advancedLoggingAvailable, segments } = computeSlackSegments(
      combat,
      owner,
      [owner, mate],
      [],
      emptyEnemyTimeline(),
      [],
      [],
    );
    expect(advancedLoggingAvailable).toBe(false);
    expect(segments).toEqual([]);
  });

  it('excludes seconds where a friendly is below 85% HP', () => {
    const owner = makeFriend('owner');
    // teammate drops to 60% HP from t=20s to t=40s
    const mateActions: unknown[] = [];
    for (let s = 0; s <= 120; s += 5) {
      const hp = s >= 20 && s < 40 ? 300_000 : 500_000;
      mateActions.push(makeAdvancedAction(T0 + s * 1000, 0, 0, 500_000, hp));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mate = makeUnit('mate', { reaction: CombatUnitReaction.Friendly, advancedActions: mateActions as any[] });
    const { segments } = computeSlackSegments(combat, owner, [owner, mate], [], emptyEnemyTimeline(), [], []);
    // no segment may overlap [20, 40)
    for (const seg of segments) {
      expect(seg.toSeconds <= 20 || seg.fromSeconds >= 40).toBe(true);
    }
    expect(segments.length).toBeGreaterThanOrEqual(2);
  });

  it('excludes seconds where an enemy offensive CD buff is active', () => {
    const owner = makeFriend('owner');
    const timeline: IEnemyCDTimeline = {
      alignedBurstWindows: [],
      players: [
        {
          playerName: 'Enemy',
          specName: 'Arms',
          offensiveCDs: [
            {
              spellId: '107574',
              spellName: 'Avatar',
              castTimeSeconds: 30,
              cooldownSeconds: 90,
              availableAgainAtSeconds: 120,
              buffEndSeconds: 50,
            },
          ],
        },
      ],
    };
    const { segments } = computeSlackSegments(combat, owner, [owner], [], timeline, [], []);
    for (const seg of segments) {
      expect(seg.toSeconds <= 30 || seg.fromSeconds >= 50).toBe(true);
    }
  });

  it('excludes seconds where the owner is CC-d and 3s after a speed-boost cast', () => {
    const owner = makeFriend('owner', {
      // Sprint-like: spells.json '2983' is type buffs_speed_boost
      spellCastEvents: [makeSpellCastEvent('2983', T0 + 60_000, 'owner', 'Owner', 'owner', 'Owner')],
    });
    const { segments } = computeSlackSegments(
      combat,
      owner,
      [owner],
      [],
      emptyEnemyTimeline(),
      [{ atSeconds: 10, durationSeconds: 6 }], // owner CC'd 10–16s
      [],
    );
    for (const seg of segments) {
      expect(seg.toSeconds <= 10 || seg.fromSeconds >= 16).toBe(true); // CC exclusion
      expect(seg.toSeconds <= 60 || seg.fromSeconds >= 63).toBe(true); // mobility exclusion
    }
  });

  it('drops segments shorter than 4s and fills owner activity counters', () => {
    // slack only in [50, 53) (3s) via HP dips elsewhere → no segment survives
    const mateActions: unknown[] = [];
    for (let s = 0; s <= 120; s += 1) {
      const hp = s >= 50 && s < 53 ? 500_000 : 300_000;
      mateActions.push(makeAdvancedAction(T0 + s * 1000, 0, 0, 500_000, hp));
    }
    const owner = makeFriend('owner');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mate = makeUnit('mate', { reaction: CombatUnitReaction.Friendly, advancedActions: mateActions as any[] });
    const { segments } = computeSlackSegments(combat, owner, [owner, mate], [], emptyEnemyTimeline(), [], []);
    expect(segments).toEqual([]);
  });

  it('counts owner damage, CC casts, purges and kicks inside a segment (idle=false)', () => {
    const enemy = makeUnit('enemy-1', { reaction: CombatUnitReaction.Hostile });
    const owner = makeFriend('owner', {
      spellCastEvents: [
        makeSpellCastEvent('118', T0 + 20_000, 'enemy-1', 'Enemy', 'owner', 'Owner'), // Polymorph: type cc
        makeSpellCastEvent('57994', T0 + 30_000, 'enemy-1', 'Enemy', 'owner', 'Owner'), // Wind Shear: type interrupts
      ],
    });
    // makeUnit hardcodes damageOut: [] — assign after construction
    (owner as unknown as { damageOut: unknown[] }).damageOut = [
      {
        logLine: { event: LogEvent.SPELL_DAMAGE, timestamp: T0 + 25_000, parameters: [] },
        timestamp: T0 + 25_000,
        effectiveAmount: 50_000,
        amount: 50_000,
        srcUnitId: 'owner',
        destUnitId: 'enemy-1',
      },
    ];
    const { segments } = computeSlackSegments(
      combat,
      owner,
      [owner],
      [enemy],
      emptyEnemyTimeline(),
      [],
      [40], // one purge at t=40s
    );
    expect(segments.length).toBe(1);
    expect(segments[0].ownerDamage).toBe(50_000);
    expect(segments[0].ownerCCCasts).toBe(1);
    expect(segments[0].ownerKickCasts).toBe(1);
    expect(segments[0].ownerPurgeCasts).toBe(1);
    expect(segments[0].idle).toBe(false);
  });
});

import { CombatUnitReaction, CombatUnitSpec, ICombatUnit, LogEvent } from '@wowarenalogs/parser';

import { specToString } from '../cooldowns';
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

// Task 2: Kill-window contribution analysis
import { computeWindowContributions } from '../healerOffenseAnalysis';
import { IOffensiveWindow } from '../offensiveWindows';

function makeWindow(fromSeconds: number, toSeconds: number): IOffensiveWindow {
  return {
    targetUnitId: 'enemy-1',
    targetName: 'Edk',
    targetSpec: 'Frost Death Knight',
    fromSeconds,
    toSeconds,
    durationSeconds: toSeconds - fromSeconds,
    friendlyDamageInWindow: 0,
    damageRatio: 1,
    capitalized: false,
    friendlyOffensives: [],
  };
}

describe('computeWindowContributions', () => {
  const enemyHealer = makeUnit('enemy-h', {
    reaction: CombatUnitReaction.Hostile,
    spec: CombatUnitSpec.Shaman_Restoration,
    name: 'Rsham',
  });
  const enemyDk = makeUnit('enemy-1', { reaction: CombatUnitReaction.Hostile, name: 'Edk' });

  it('reports ready CC with enemy healer DR, no cast, free time and team HP', () => {
    // owner cast Psychic Scream (8122, type cc, 40s CD per spellEffectData) at t=100s → it was ready at t=40s
    const owner = makeFriend('owner', {
      spellCastEvents: [makeSpellCastEvent('8122', T0 + 100_000, 'enemy-h', 'Rsham', 'owner', 'Owner')],
    });
    const result = computeWindowContributions(
      combat,
      owner,
      [owner],
      [enemyDk, enemyHealer],
      [makeWindow(40, 50)],
      [], // owner never CC'd
      [], // enemy healer has no incoming CC history → DR Full
    );
    expect(result.length).toBe(1);
    expect(result[0].enemyHealerName).toBe('Rsham');
    expect(result[0].enemyHealerSpec).toBe(specToString(CombatUnitSpec.Shaman_Restoration));
    expect(result[0].enemyHealerSpec).not.toBe(String(CombatUnitSpec.Shaman_Restoration));
    expect(result[0].ownerCCReady).toEqual([{ spellName: '8122', enemyHealerDR: 'Full' }]);
    expect(result[0].ownerCastCCInWindow).toBe(false);
    expect(result[0].ownerFreeSeconds).toBe(10);
    expect(result[0].teamMinHpPct).toBe(100);
  });

  it('flags CC as NOT ready when inside its cooldown, and detects an in-window cast', () => {
    const owner = makeFriend('owner', {
      spellCastEvents: [
        makeSpellCastEvent('8122', T0 + 35_000, 'enemy-h', 'Rsham', 'owner', 'Owner'), // cast at 35s → on CD at 40s
      ],
    });
    const result = computeWindowContributions(
      combat,
      owner,
      [owner],
      [enemyDk, enemyHealer],
      [makeWindow(40, 50)],
      [],
      [],
    );
    expect(result[0].ownerCCReady).toEqual([]); // 8122 on CD (35+40 > 40)
    expect(result[0].ownerCastCCInWindow).toBe(false);

    const result2 = computeWindowContributions(
      combat,
      owner,
      [owner],
      [enemyDk, enemyHealer],
      [makeWindow(30, 40)],
      [],
      [],
    );
    expect(result2[0].ownerCastCCInWindow).toBe(true); // cast at 35s ∈ [30, 40)
  });

  it('subtracts owner CC time from ownerFreeSeconds and reports decayed DR', () => {
    const owner = makeFriend('owner', {
      spellCastEvents: [makeSpellCastEvent('8122', T0 + 100_000, 'enemy-h', 'Rsham', 'owner', 'Owner')],
    });
    const result = computeWindowContributions(
      combat,
      owner,
      [owner],
      [enemyDk, enemyHealer],
      [makeWindow(40, 50)],
      [{ atSeconds: 42, durationSeconds: 4 }], // owner feared 42–46
      // enemy healer feared at t=38 for 6s → same 'Disorient'-category DR window is still hot at 40
      [{ atSeconds: 38, durationSeconds: 6, drInfo: { category: 'Disorient', level: 'Full', sequenceIndex: 0 } }],
    );
    expect(result[0].ownerFreeSeconds).toBe(6);
    expect(result[0].ownerCCReady[0].enemyHealerDR).toBe('50%');
  });

  it('does not double-count ownerFreeSeconds when owner CC instances overlap', () => {
    const owner = makeFriend('owner');
    const result = computeWindowContributions(
      combat,
      owner,
      [owner],
      [enemyDk, enemyHealer],
      [makeWindow(40, 50)],
      [
        { atSeconds: 42, durationSeconds: 4 }, // 42–46
        { atSeconds: 43, durationSeconds: 3 }, // 43–46, overlaps the above
      ],
      [],
    );
    // Union of CC'd seconds is still {42,43,44,45} = 4s, so ownerFreeSeconds is 6, not 10-(4+3)=3.
    expect(result[0].ownerFreeSeconds).toBe(6);
  });
});

// Task 3: Window-creation opportunity facts
import { computeWindowCreationFacts, ISlackSegment } from '../healerOffenseAnalysis';

function slackSeg(fromSeconds: number, toSeconds: number): ISlackSegment {
  return {
    fromSeconds,
    toSeconds,
    durationSeconds: toSeconds - fromSeconds,
    ownerDamage: 0,
    ownerCCCasts: 0,
    ownerPurgeCasts: 0,
    ownerKickCasts: 0,
    idle: true,
  };
}

describe('computeWindowCreationFacts', () => {
  const enemyHealerWithTrinketDown = makeUnit('enemy-h', {
    reaction: CombatUnitReaction.Hostile,
    spec: CombatUnitSpec.Shaman_Restoration,
    name: 'Rsham',
    // trinket (336126) used at t=10s; healer trinket CD 90s → on CD until 100s
    spellCastEvents: [makeSpellCastEvent('336126', T0 + 10_000, 'enemy-h', 'Rsham', 'enemy-h', 'Rsham')],
  });

  it('emits a fact when CC ready + enemy healer DR Full + trinket on CD + no kill window overlapping', () => {
    const owner = makeFriend('owner', {
      spellCastEvents: [makeSpellCastEvent('8122', T0 + 100_000, 'enemy-h', 'Rsham', 'owner', 'Owner')],
    });
    const facts = computeWindowCreationFacts(combat, owner, [enemyHealerWithTrinketDown], [slackSeg(40, 50)], [], []);
    expect(facts.length).toBe(1);
    expect(facts[0].atSeconds).toBe(40);
    expect(facts[0].ccSpellName).toBe('8122');
    expect(facts[0].enemyHealerDRLevel).toBe('Full');
    expect(facts[0].enemyHealerTrinketOnCD).toBe(true);
  });

  it('suppresses facts during an active kill window, at decayed DR, and caps at 2 by slack length', () => {
    const owner = makeFriend('owner', {
      spellCastEvents: [makeSpellCastEvent('8122', T0 + 115_000, 'enemy-h', 'Rsham', 'owner', 'Owner')],
    });
    // overlapping kill window suppresses the 40–50 segment
    const suppressed = computeWindowCreationFacts(
      combat,
      owner,
      [enemyHealerWithTrinketDown],
      [slackSeg(40, 50)],
      [makeWindow(45, 55)],
      [],
    );
    expect(suppressed).toEqual([]);

    // decayed DR suppresses (verify getDRCategory('8122') and reuse the real category string)
    const decayed = computeWindowCreationFacts(
      combat,
      owner,
      [enemyHealerWithTrinketDown],
      [slackSeg(40, 50)],
      [],
      [{ atSeconds: 38, durationSeconds: 6, drInfo: { category: 'Disorient', level: 'Full', sequenceIndex: 0 } }],
    );
    expect(decayed).toEqual([]);

    // 3 candidate segments → capped at 2, longest first
    const capped = computeWindowCreationFacts(
      combat,
      owner,
      [enemyHealerWithTrinketDown],
      [slackSeg(20, 25), slackSeg(40, 52), slackSeg(60, 68)],
      [],
      [],
    );
    expect(capped.length).toBe(2);
    expect(capped[0].atSeconds).toBe(40); // 12s slack
    expect(capped[1].atSeconds).toBe(60); // 8s slack
  });

  it('returns [] when there is no enemy healer or the owner has no observed CC', () => {
    const owner = makeFriend('owner');
    expect(computeWindowCreationFacts(combat, owner, [enemyHealerWithTrinketDown], [slackSeg(40, 50)], [], [])).toEqual(
      [],
    );
    const ownerWithCC = makeFriend('owner', {
      spellCastEvents: [makeSpellCastEvent('8122', T0 + 100_000, 'x', 'X', 'owner', 'Owner')],
    });
    expect(
      computeWindowCreationFacts(
        combat,
        ownerWithCC,
        [makeUnit('enemy-1', { reaction: CombatUnitReaction.Hostile })],
        [slackSeg(40, 50)],
        [],
        [],
      ),
    ).toEqual([]);
  });

  it('emits fact with null trinketOnCD when enemy healer has never cast trinket', () => {
    // Enemy healer with no trinket cast history (trinket state unknown)
    const enemyHealerNoTrinket = makeUnit('enemy-h', {
      reaction: CombatUnitReaction.Hostile,
      spec: CombatUnitSpec.Shaman_Restoration,
      name: 'Rsham',
      spellCastEvents: [], // no trinket cast
    });
    const owner = makeFriend('owner', {
      spellCastEvents: [makeSpellCastEvent('8122', T0 + 115_000, 'enemy-h', 'Rsham', 'owner', 'Owner')],
    });
    const facts = computeWindowCreationFacts(combat, owner, [enemyHealerNoTrinket], [slackSeg(40, 50)], [], []);
    expect(facts.length).toBe(1);
    expect(facts[0].atSeconds).toBe(40);
    expect(facts[0].enemyHealerTrinketOnCD).toBe(null);
    expect(facts[0].enemyHealerSpec).toBe(specToString(CombatUnitSpec.Shaman_Restoration));
  });
});

// Task 4: Summary entry point + context formatter
import { buildHealerOffenseSummary, formatHealerOffenseForContext } from '../healerOffenseAnalysis';

describe('buildHealerOffenseSummary + formatHealerOffenseForContext', () => {
  it('returns an empty format block when advanced logging is missing', () => {
    const owner = makeUnit('owner', { reaction: CombatUnitReaction.Friendly }); // no advancedActions
    const summary = buildHealerOffenseSummary(combat, owner, [owner], [], [], emptyEnemyTimeline(), [], [], []);
    expect(summary.advancedLoggingAvailable).toBe(false);
    expect(formatHealerOffenseForContext(summary)).toEqual([]);
  });

  it('renders header, aggregate slack line, idle segments, window and opportunity lines', () => {
    const enemyHealer = makeUnit('enemy-h', {
      reaction: CombatUnitReaction.Hostile,
      spec: CombatUnitSpec.Shaman_Restoration,
      name: 'Rsham',
      spellCastEvents: [makeSpellCastEvent('336126', T0 + 10_000, 'enemy-h', 'Rsham', 'enemy-h', 'Rsham')],
    });
    const owner = makeFriend('owner', {
      spellCastEvents: [makeSpellCastEvent('8122', T0 + 115_000, 'enemy-h', 'Rsham', 'owner', 'Owner')],
    });
    // Enemy offensive CD from 40-50s (matching kill window) creates a gap in slack segments
    // This allows segment [50, 120) to exist without overlapping the kill window
    const enemyTimeline: IEnemyCDTimeline = {
      players: [
        {
          playerName: 'Enemy DPS',
          specName: 'Arms',
          offensiveCDs: [
            {
              spellId: '107574',
              spellName: 'Avatar',
              castTimeSeconds: 40,
              cooldownSeconds: 90,
              availableAgainAtSeconds: 130,
              buffEndSeconds: 50,
            },
          ],
        },
      ],
      alignedBurstWindows: [],
    };
    const summary = buildHealerOffenseSummary(
      combat,
      owner,
      [owner],
      [enemyHealer],
      [makeWindow(40, 50)],
      enemyTimeline,
      [],
      [],
      [],
    );
    const lines = formatHealerOffenseForContext(summary);
    const text = lines.join('\n');
    expect(text).toContain('HEALER OFFENSE');
    expect(text).toContain('slack');
    expect(text).toContain('[KILL WINDOW]');
    expect(text).toContain('you cast no CC');
    expect(text).toContain('[OPPORTUNITY]');
    expect(text).toContain('opportunity, not a verdict');
    // Note trimmed 2026-07-09 (week-eval tokens.md #4): redundant guidance lives in the system
    // prompt; only the load-bearing "outranks" rule remains in the block.
    expect(text).toContain('healing under pressure always outranks offense');
  });
});

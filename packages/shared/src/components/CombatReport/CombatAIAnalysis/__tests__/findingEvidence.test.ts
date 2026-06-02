import { IPlayerCCTrinketSummary } from '../../../../utils/ccTrinketAnalysis';
import { IMissedPurgeWindow } from '../../../../utils/dispelAnalysis';
import { IAlignedBurstWindow, IEnemyPlayerTimeline } from '../../../../utils/enemyCDs';
import { deriveEvidence } from '../findingEvidence';
import { MatchAnalysisData } from '../matchAnalysisData';

function burst(fromSeconds: number, dangerScore: number): IAlignedBurstWindow {
  return {
    fromSeconds,
    toSeconds: fromSeconds + 8,
    activeCDs: [{ playerName: 'Astrobiology', spellName: 'Combustion', spellId: '190319' }],
    dangerScore,
    dangerLabel: 'Critical',
    dampeningPct: 0.1,
    damageInWindow: 560000,
    damageRatio: 2,
    healerCCed: false,
  };
}

function enemyTimeline(): IEnemyPlayerTimeline {
  return {
    playerName: 'Astrobiology',
    specName: 'Fire Mage',
    offensiveCDs: [
      {
        spellId: '190319',
        spellName: 'Combustion',
        castTimeSeconds: 20,
        cooldownSeconds: 120,
        availableAgainAtSeconds: 140,
        buffEndSeconds: 30,
      },
    ],
  };
}

function missedPurge(timeSeconds: number): IMissedPurgeWindow {
  return {
    timeSeconds,
    durationSeconds: 5,
    enemyName: 'Astrobiology',
    enemySpec: 'Fire Mage',
    spellName: 'Alter Time',
    spellId: '342245',
    priority: 'Critical',
    purgeWasOnCD: false,
    teamUnderPressure: true,
  };
}

function ccSummary(): IPlayerCCTrinketSummary {
  return {
    playerName: 'Masons',
    playerSpec: 'Holy Paladin',
    trinketType: 'Gladiator',
    trinketCooldownSeconds: 120,
    ccInstances: [
      {
        atSeconds: 112,
        durationSeconds: 4.5,
        spellId: '853',
        spellName: 'Hammer of Justice',
        sourceName: 'Masons',
        sourceSpec: 'Holy Paladin',
        damageTakenDuring: 38000,
        trinketState: 'available_unused',
        drInfo: null,
        distanceYards: null,
        losBlocked: null,
      },
    ],
    trinketUseTimes: [],
    missedTrinketWindows: [],
  } as unknown as IPlayerCCTrinketSummary;
}

function makeData(overrides: Partial<MatchAnalysisData> = {}): MatchAnalysisData {
  return {
    owner: {} as MatchAnalysisData['owner'],
    ownerSpec: 'Beast Mastery Hunter',
    ownerName: 'Zigris',
    ownerIsHealer: false,
    ownerCanPurge: false,
    bracket: 'Rated Solo Shuffle',
    zone: 'Mugambala',
    result: 'Win',
    durationSeconds: 120,
    friends: [
      {
        name: 'Zigris',
        spec: 'Beast Mastery Hunter',
        cls: 'hunter',
        isOwner: true,
        rate: 0,
        rateType: 'DPS',
        baseline: 0,
      },
    ],
    enemies: [
      { name: 'Astrobiology', spec: 'Fire Mage', cls: 'mage', isOwner: false, rate: 0, rateType: 'DPS', baseline: 0 },
      { name: 'Masons', spec: 'Holy Paladin', cls: 'paladin', isOwner: false, rate: 0, rateType: 'HPS', baseline: 0 },
    ],
    friendlyDeaths: [],
    enemyDeaths: [{ spec: 'Fire Mage', name: 'Astrobiology', cls: 'mage', atSeconds: 120, side: 'enemy' }],
    burstWindows: [burst(20, 9.8), burst(110, 5.3)],
    ownerCDs: [
      {
        spellId: '19574',
        spellName: 'Bestial Wrath',
        tag: 'Offensive',
        cooldownSeconds: 90,
        maxChargesDetected: 1,
        casts: [{ timeSeconds: 119 }],
        availableWindows: [],
        neverUsed: false,
      },
    ],
    enemyCDs: [enemyTimeline()],
    missedPurges: [missedPurge(111)],
    ccTrinketSummaries: [ccSummary()],
    criticalMoments: [],
    ...overrides,
  };
}

describe('deriveEvidence', () => {
  it('returns only events within the window around the anchor', () => {
    const ev = deriveEvidence(112, makeData(), { beforeSeconds: 8, afterSeconds: 8 });
    // anchor 112, window [104, 120]
    const times = ev.keyMoments.map((m) => m.atSeconds);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(104);
    expect(Math.max(...times)).toBeLessThanOrEqual(120);
    // burst at 20 and combustion cast at 20 are outside the window
    expect(ev.keyMoments.some((m) => m.label.includes('Combustion'))).toBe(false);
  });

  it('includes cc, purge, kill, owner-cd and burst kinds when in range', () => {
    const ev = deriveEvidence(112, makeData(), { beforeSeconds: 8, afterSeconds: 10 });
    const kinds = new Set(ev.keyMoments.map((m) => m.kind));
    expect(kinds.has('cc')).toBe(true);
    expect(kinds.has('purge')).toBe(true);
    expect(kinds.has('kill')).toBe(true);
    expect(kinds.has('owner-cd')).toBe(true);
    expect(kinds.has('enemy-burst')).toBe(true);
  });

  it('sorts key moments chronologically', () => {
    const ev = deriveEvidence(112, makeData(), { beforeSeconds: 12, afterSeconds: 12 });
    const times = ev.keyMoments.map((m) => m.atSeconds);
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted);
  });

  it('tags moments with the actor class for glyph rendering', () => {
    const ev = deriveEvidence(112, makeData(), { beforeSeconds: 8, afterSeconds: 8 });
    const cc = ev.keyMoments.find((m) => m.kind === 'cc');
    expect(cc?.cls).toBe('paladin');
    const purge = ev.keyMoments.find((m) => m.kind === 'purge');
    expect(purge?.cls).toBe('mage');
  });

  it('reports a window centred on the anchor', () => {
    const ev = deriveEvidence(50, makeData(), { beforeSeconds: 6, afterSeconds: 4 });
    expect(ev.windowStart).toBe(44);
    expect(ev.windowEnd).toBe(54);
  });

  it('clamps the window to the match bounds', () => {
    const ev = deriveEvidence(2, makeData({ durationSeconds: 100 }), { beforeSeconds: 8, afterSeconds: 8 });
    expect(ev.windowStart).toBe(0);
  });
});

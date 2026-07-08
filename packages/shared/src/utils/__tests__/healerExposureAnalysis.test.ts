/* eslint-disable @typescript-eslint/no-explicit-any */
import { CombatUnitSpec, LogEvent } from '@wowarenalogs/parser';

import {
  analyzeHealerExposureAtBurst,
  buildHealerCCReceivedEvents,
  formatHealerCCReceivedForContext,
  formatHealerExposureForContext,
} from '../healerExposureAnalysis';
import { makeAdvancedAction, makeAuraEvent, makeSpellCastEvent, makeUnit } from './testHelpers';

const MATCH_START = 1_000_000;

describe('healerExposureAnalysis — exposure calculation', () => {
  it('returns empty when no burst windows provided', () => {
    const res = analyzeHealerExposureAtBurst(
      [],
      [],
      makeUnit('h'),
      { trinketUseTimes: [], ccInstances: [] } as any,
      [],
      '1505',
      MATCH_START,
    );
    expect(res).toHaveLength(0);
  });

  it('labels Safe when threats are beyond 40 yards (B26)', () => {
    const healer = makeUnit('h', {
      advancedActions: [makeAdvancedAction(MATCH_START, 0, 0)], // at (0,0)
    });
    (healer.advancedActions[0] as any).advancedActorId = 'h';
    const enemy = makeUnit('e', {
      spec: CombatUnitSpec.Mage_Frost,
      advancedActions: [makeAdvancedAction(MATCH_START, 50, 0)], // at (50,0) -> 50 yards
    });
    (enemy.advancedActions[0] as any).advancedActorId = 'e';
    const windows = [{ fromSeconds: 0, dangerLabel: 'High' }] as any;

    const res = analyzeHealerExposureAtBurst(
      windows,
      [enemy],
      healer,
      { trinketUseTimes: [], ccInstances: [] } as any,
      [],
      '1505',
      MATCH_START,
    );
    expect(res).toHaveLength(0); // No threats within range
  });

  it('skips when healer position is missing (B45)', () => {
    const healer = makeUnit('h', { advancedActions: [] });
    const windows = [{ fromSeconds: 0 }] as any;
    const res = analyzeHealerExposureAtBurst(
      windows,
      [],
      healer,
      { trinketUseTimes: [], ccInstances: [] } as any,
      [],
      '1505',
      MATCH_START,
    );
    expect(res).toHaveLength(0);
  });

  it('skips when enemy position is missing (B46)', () => {
    const healer = makeUnit('h', { advancedActions: [makeAdvancedAction(MATCH_START, 0, 0)] });
    (healer.advancedActions[0] as any).advancedActorId = 'h';
    const enemy = makeUnit('e', { advancedActions: [] });
    const windows = [{ fromSeconds: 0 }] as any;
    const res = analyzeHealerExposureAtBurst(
      windows,
      [enemy],
      healer,
      { trinketUseTimes: [], ccInstances: [] } as any,
      [],
      '1505',
      MATCH_START,
    );
    expect(res).toHaveLength(0);
  });

  it('labels Critical when healer has no trinket and Full DR threat is in LoS', () => {
    const healer = makeUnit('h', {
      advancedActions: [makeAdvancedAction(MATCH_START, 0, 0)],
    });
    (healer.advancedActions[0] as any).advancedActorId = 'h';
    const enemy = makeUnit('e', {
      name: 'Mage',
      spec: CombatUnitSpec.Mage_Frost,
      advancedActions: [makeAdvancedAction(MATCH_START, 10, 0)],
    });
    (enemy.advancedActions[0] as any).advancedActorId = 'e';
    const windows = [{ fromSeconds: 0, dangerLabel: 'High' }] as any;
    const healerCCSummary: any = {
      trinketType: 'Gladiator',
      trinketUseTimes: [0], // Used at t=0
      trinketCooldownSeconds: 120,
      ccInstances: [],
    };

    const res = analyzeHealerExposureAtBurst(windows, [enemy], healer, healerCCSummary, [], '1505', MATCH_START);
    expect(res[0].exposureLabel).toBe('Critical');
    expect(res[0].trinketState).toBe('on_cooldown');
  });

  it('labels Exposed with Full DR threat formatting (B47)', () => {
    const healer = makeUnit('h', { advancedActions: [makeAdvancedAction(MATCH_START, 0, 0)] });
    (healer.advancedActions[0] as any).advancedActorId = 'h';
    const enemy = makeUnit('e', {
      name: 'Mage',
      spec: CombatUnitSpec.Mage_Frost,
      advancedActions: [makeAdvancedAction(MATCH_START, 10, 0)],
    });
    (enemy.advancedActions[0] as any).advancedActorId = 'e';
    const windows = [{ fromSeconds: 0, dangerLabel: 'High' }] as any;
    const healerCCSummary: any = {
      trinketType: 'Gladiator',
      trinketUseTimes: [], // Trinket available
      trinketCooldownSeconds: 120,
      ccInstances: [],
    };
    const res = analyzeHealerExposureAtBurst(windows, [enemy], healer, healerCCSummary, [], '1505', MATCH_START);
    expect(res[0].exposureLabel).toBe('Exposed');

    const lines = formatHealerExposureForContext(res);
    expect(lines.join('\n')).toContain('trinket is the only answer');
  });

  it('handles passive trinkets (Relentless/Adaptation)', () => {
    const healer = makeUnit('h', { advancedActions: [makeAdvancedAction(MATCH_START, 0, 0)] });
    (healer.advancedActions[0] as any).advancedActorId = 'h';
    const enemy = makeUnit('e', {
      spec: CombatUnitSpec.Mage_Frost,
      advancedActions: [makeAdvancedAction(MATCH_START, 10, 0)],
    });
    (enemy.advancedActions[0] as any).advancedActorId = 'e';
    const windows = [{ fromSeconds: 0 }] as any;
    const summary: any = { trinketType: 'Relentless', ccInstances: [] };

    const res = analyzeHealerExposureAtBurst(windows, [enemy], healer, summary, [], '1505', MATCH_START);
    expect(res[0].trinketState).toBe('passive');
  });

  it('labels Pressured when only 50% DR threats in LoS and trinket available', () => {
    const healer = makeUnit('h', { advancedActions: [makeAdvancedAction(MATCH_START, 0, 0)] });
    (healer.advancedActions[0] as any).advancedActorId = 'h';
    const enemy = makeUnit('e', {
      name: 'Mage',
      spec: CombatUnitSpec.Mage_Frost,
      advancedActions: [makeAdvancedAction(MATCH_START, 10, 0)],
    });
    (enemy.advancedActions[0] as any).advancedActorId = 'e';
    const windows = [{ fromSeconds: 0 }] as any;
    const healerCCSummary: any = {
      trinketType: 'Gladiator',
      trinketUseTimes: [],
      trinketCooldownSeconds: 120,
      ccInstances: [
        { atSeconds: -20, durationSeconds: 4, spellId: '118', drInfo: { category: 'Incapacitate' } }, // Recently Poly'd
      ],
    };

    const res = analyzeHealerExposureAtBurst(windows, [enemy], healer, healerCCSummary, [], '1505', MATCH_START);
    expect(res[0].exposureLabel).toBe('Pressured');
  });

  it('skips enemies who are currently in CC (B44)', () => {
    const healer = makeUnit('h', { advancedActions: [makeAdvancedAction(MATCH_START, 0, 0)] });
    (healer.advancedActions[0] as any).advancedActorId = 'h';
    const enemy = makeUnit('e', {
      spec: CombatUnitSpec.Mage_Frost,
      advancedActions: [makeAdvancedAction(MATCH_START, 10, 0)],
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '853', MATCH_START - 2000, 'h', 'e'), // HoJ applied
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '853', MATCH_START - 1000, 'h', 'e'), // HoJ removed - enemy now free
      ],
    });
    (enemy.advancedActions[0] as any).advancedActorId = 'e';
    const windows = [{ fromSeconds: 0 }] as any;
    const res = analyzeHealerExposureAtBurst(
      windows,
      [enemy],
      healer,
      { trinketUseTimes: [], ccInstances: [] } as any,
      [],
      '1505',
      MATCH_START,
    );
    expect(res).toHaveLength(1); // Enemy is now free and threatens
  });

  it('uses observed CC history from other teammates (B49)', () => {
    const healer = makeUnit('h', { advancedActions: [makeAdvancedAction(MATCH_START, 0, 0)] });
    (healer.advancedActions[0] as any).advancedActorId = 'h';
    const enemy = makeUnit('e', {
      name: 'E1',
      spec: CombatUnitSpec.Warrior_Arms,
      advancedActions: [makeAdvancedAction(MATCH_START, 10, 0)],
    });
    (enemy.advancedActions[0] as any).advancedActorId = 'e';
    const windows = [{ fromSeconds: 0 }] as any;

    // Observed CC: Mage (enemy) cast Polymorph on a teammate
    const friendCCSummary: any = {
      ccInstances: [
        { sourceName: 'E1', spellId: '118', spellName: 'Polymorph' }, // Incapacitate category
      ],
    };

    const res = analyzeHealerExposureAtBurst(
      windows,
      [enemy],
      healer,
      { trinketUseTimes: [], ccInstances: [] } as any,
      [friendCCSummary],
      '1505',
      MATCH_START,
    );
    expect(res[0].threats[0].ccSpellName).toBe('Polymorph');
    expect(res[0].threats[0].ccCategory).toBe('Incapacitate');
  });

  it('handles null LoS result by assuming unblocked (B50)', () => {
    const healer = makeUnit('h', { advancedActions: [makeAdvancedAction(MATCH_START, 0, 0)] });
    (healer.advancedActions[0] as any).advancedActorId = 'h';
    const enemy = makeUnit('e', {
      spec: CombatUnitSpec.Mage_Frost,
      advancedActions: [makeAdvancedAction(MATCH_START, 10, 0)],
    });
    (enemy.advancedActions[0] as any).advancedActorId = 'e';
    const windows = [{ fromSeconds: 0 }] as any;
    // zone '999' returns null from hasLineOfSight
    const res = analyzeHealerExposureAtBurst(
      windows,
      [enemy],
      healer,
      { trinketUseTimes: [], ccInstances: [] } as any,
      [],
      '999',
      MATCH_START,
    );
    expect(res[0].threats[0].losBlocked).toBe(false);
  });
});

describe('healerExposureAnalysis — CC avoidance', () => {
  it('buildHealerCCReceivedEvents detects avoidance tools used/idle', () => {
    const healer = makeUnit('h', {
      spec: CombatUnitSpec.Priest_Discipline,
      spellCastEvents: [
        makeSpellCastEvent('586', MATCH_START + 10_000, 'h', 'Self', 'h', 'Priest'), // Fade success at 10s
      ],
    });
    const friend = makeUnit('f', {
      advancedActions: [
        makeAdvancedAction(MATCH_START + 50_000, 0, 0, 100, 50), // Friend at 50% HP
      ],
    });
    (friend.advancedActions[0] as any).advancedActorId = 'f';
    const ccSummary = {
      ccInstances: [{ atSeconds: 50, durationSeconds: 6, spellName: 'Fear', drInfo: { category: 'Disorient' } }],
    };

    const res = buildHealerCCReceivedEvents({ startTime: MATCH_START } as any, healer, [friend], ccSummary as any);
    expect(res).toHaveLength(1);
    expect(res[0].avoidanceToolsAvailable).toHaveLength(1);
    expect(res[0].avoidanceToolsAvailable[0].spellName).toBe('Fade');
    expect(res[0].avoidanceToolsAvailable[0].idleForSeconds).toBe(10); // 50s - (10s + 30s CD) = 10s
  });

  it('skips events where no teammate is at low HP', () => {
    const healer = makeUnit('h', { spec: CombatUnitSpec.Priest_Discipline });
    const friend = makeUnit('f', { advancedActions: [makeAdvancedAction(MATCH_START, 0, 0, 100, 100)] });
    (friend.advancedActions[0] as any).advancedActorId = 'f';
    const ccSummary = { ccInstances: [{ atSeconds: 10, durationSeconds: 6, spellName: 'Fear' }] };
    const res = buildHealerCCReceivedEvents({ startTime: MATCH_START } as any, healer, [friend], ccSummary as any);
    expect(res).toHaveLength(0);
  });

  it('formats correctly when no avoidance tools available (B48)', () => {
    const ev: any = {
      atSeconds: 10,
      ccSpellName: 'Fear',
      durationSeconds: 6,
      avoidanceToolsAvailable: [],
    };
    const res = formatHealerCCReceivedForContext([ev]);
    expect(res).toContain('no avoidance tools available');
  });
});

describe('healerExposureAnalysis — pillar proximity (F15 P2)', () => {
  it('carries nearestPillarYards when the zone geometry is mapped', () => {
    // Healer 1.5yd from the edge of Nagrand's north pillar (r=4 @-2044.5,6623.5)
    const healer = makeUnit('h', { advancedActions: [makeAdvancedAction(MATCH_START, -2050, 6623.5)] });
    (healer.advancedActions[0] as any).advancedActorId = 'h';
    const enemy = makeUnit('e', {
      name: 'Mage',
      spec: CombatUnitSpec.Mage_Frost,
      advancedActions: [makeAdvancedAction(MATCH_START, -2050, 6600)],
    });
    (enemy.advancedActions[0] as any).advancedActorId = 'e';
    const windows = [{ fromSeconds: 0, dangerLabel: 'High' }] as any;
    const healerCCSummary: any = {
      trinketType: 'Gladiator',
      trinketUseTimes: [],
      trinketCooldownSeconds: 120,
      ccInstances: [],
    };

    const res = analyzeHealerExposureAtBurst(windows, [enemy], healer, healerCCSummary, [], '1505', MATCH_START);
    expect(res).toHaveLength(1);
    expect(res[0].nearestPillarYards).toBeCloseTo(1.5, 1);
  });

  it('formatter renders the pillar hint on Critical/Exposed entries when a pillar is nearby', () => {
    const base: any = {
      atSeconds: 10,
      burstDangerLabel: 'High',
      trinketState: 'available',
      trinketAvailableAtSeconds: null,
      exposureLabel: 'Exposed',
      threats: [
        {
          enemySpec: 'Frost Mage',
          enemyName: 'M1',
          ccSpellName: 'Polymorph',
          ccCategory: 'Incapacitate',
          healerDRLevel: 'Full',
          losBlocked: false,
        },
      ],
    };
    const near = { ...base, nearestPillarYards: 6.4 };
    const far = { ...base, atSeconds: 20, nearestPillarYards: 48 };
    const unmapped = { ...base, atSeconds: 30, nearestPillarYards: null };

    const text = formatHealerExposureForContext([near, far, unmapped]).join('\n');
    expect(text).toContain('nearest pillar ~6.4yd');
    expect(text).not.toContain('~48yd');
    expect((text.match(/nearest pillar/g) ?? []).length).toBe(1);
  });
});

describe('healerExposureAnalysis — formatting', () => {
  it('formatHealerExposureForContext produces detailed breakdown', () => {
    const exposure: any = {
      atSeconds: 10,
      burstDangerLabel: 'High',
      trinketState: 'on_cooldown',
      trinketAvailableAtSeconds: 40,
      exposureLabel: 'Critical',
      threats: [
        {
          enemySpec: 'Frost Mage',
          enemyName: 'M1',
          ccSpellName: 'Polymorph',
          ccCategory: 'Incapacitate',
          healerDRLevel: 'Full',
          losBlocked: false,
        },
        {
          enemySpec: 'Arms Warrior',
          enemyName: 'W1',
          ccSpellName: 'Intimidating Shout',
          ccCategory: 'Disorient',
          healerDRLevel: 'Full',
          losBlocked: true,
        },
      ],
    };
    const lines = formatHealerExposureForContext([exposure]);
    expect(lines.join('\n')).toContain('⚠ CRITICAL');
    expect(lines.join('\n')).toContain('trinket on CD (back 0:40)');
    expect(lines.join('\n')).toContain('IN LoS: Frost Mage (M1)');
    expect(lines.join('\n')).toContain('Pillar-blocked: Arms Warrior (W1)');
  });

  it('formatHealerCCReceivedForContext produces brief summary', () => {
    const ev: any = {
      atSeconds: 10,
      ccSpellName: 'Fear',
      durationSeconds: 6,
      avoidanceToolsAvailable: [{ spellName: 'Fade', idleForSeconds: 5 }],
    };
    const res = formatHealerCCReceivedForContext([ev]);
    expect(res).toContain('Fear (6s)');
    expect(res).toContain('Fade available 5s prior');
  });
});

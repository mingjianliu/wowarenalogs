import {
  AtomicArenaCombat,
  CombatResult,
  CombatUnitClass,
  CombatUnitReaction,
  CombatUnitSpec,
  ICombatUnit,
} from '@wowarenalogs/parser';

import { spellEffectData } from '../../data/spellEffectData';
import { bucketFirstDeath, extractFirstDeathFeatures, FOCUS_SHARE_THRESHOLD, IFirstDeathFeatures } from '../firstDeath';
import { makeUnit } from './testHelpers';

const T0 = 1_000_000;
const T_END = T0 + 120_000;

function makeCombat(units: ICombatUnit[]): AtomicArenaCombat {
  return {
    startTime: T0,
    endTime: T_END,
    playerId: units[0]?.id,
    result: CombatResult.Lose,
    units: Object.fromEntries(units.map((u) => [u.id, u])),
    startInfo: { bracket: '3v3', zoneId: 0 },
  } as unknown as AtomicArenaCombat;
}

/** Minimal SPELL_CAST_SUCCESS stub (CombatAction shape) — mirrors matchupIntel.test.ts's castSuccess. */
function castSuccess(spellId: string, atMs: number, srcId: string) {
  return {
    spellId,
    srcUnitId: srcId,
    logLine: { event: 'SPELL_CAST_SUCCESS', timestamp: atMs, parameters: [] },
  };
}

const baseFeatures: IFirstDeathFeatures = {
  victimName: 'v',
  victimSpec: 'Arms Warrior',
  victimIsFriendly: true,
  victimIsOwner: false,
  atSeconds: 60,
  healerCCLockedSeconds: 0,
  healerCCLocked: false,
  enemyBurstActive: false,
  victimDefensivesUnused: [],
  victimUsedDefensiveInWindow: true,
  healerMaxCastGapSeconds: 1,
  healerGcdIdle: false,
  healerManaPct: 80,
  victimFocusShare: 0.4,
  victimFocused: false,
  victimSwappedTo: false,
};

describe('extractFirstDeathFeatures', () => {
  it('returns null when nobody died', () => {
    const healer = makeUnit('h', {
      reaction: CombatUnitReaction.Friendly,
      class: CombatUnitClass.Priest,
      spec: CombatUnitSpec.Priest_Holy,
    });
    const foe = makeUnit('f', {
      reaction: CombatUnitReaction.Hostile,
      class: CombatUnitClass.Warrior,
      spec: CombatUnitSpec.Warrior_Arms,
    });
    const combat = makeCombat([healer, foe]);
    expect(extractFirstDeathFeatures(combat, [healer], [foe], healer)).toBeNull();
  });

  it('identifies the earliest death and measures healer CC lock inside the window', () => {
    const healer = makeUnit('h', {
      reaction: CombatUnitReaction.Friendly,
      class: CombatUnitClass.Priest,
      spec: CombatUnitSpec.Priest_Holy,
      auraEvents: [
        // Polymorph 50s→56s: 6s of CC, entirely inside the 45s–60s window before the death at 60s
        {
          spellId: '118',
          srcUnitId: 'f',
          logLine: { event: 'SPELL_AURA_APPLIED', timestamp: T0 + 50_000, parameters: [] },
        },
        {
          spellId: '118',
          srcUnitId: 'f',
          logLine: { event: 'SPELL_AURA_REMOVED', timestamp: T0 + 56_000, parameters: [] },
        },
      ],
    });
    const mate = makeUnit('m', {
      reaction: CombatUnitReaction.Friendly,
      class: CombatUnitClass.Warrior,
      spec: CombatUnitSpec.Warrior_Arms,
      deathRecords: [{ timestamp: T0 + 60_000, event: 'UNIT_DIED', parameters: [] }],
    });
    const foe = makeUnit('f', {
      reaction: CombatUnitReaction.Hostile,
      class: CombatUnitClass.Mage,
      spec: CombatUnitSpec.Mage_Fire,
    });
    const combat = makeCombat([healer, mate, foe]);

    const features = extractFirstDeathFeatures(combat, [healer, mate], [foe], healer);

    expect(features).not.toBeNull();
    expect(features?.atSeconds).toBe(60);
    expect(features?.victimName).toBe(mate.name);
    expect(features?.victimIsFriendly).toBe(true);
    expect(features?.healerCCLockedSeconds).toBeCloseTo(6, 1);
    expect(features?.healerCCLocked).toBe(true);
  });

  it('enemyBurstActive: true when an enemy CD burst window overlaps the pre-death window', () => {
    // Guard: the test is meaningless if Combustion left the dataset — fail loudly, never vacuously.
    expect(spellEffectData['190319']).toBeDefined();

    const healer = makeUnit('h', {
      reaction: CombatUnitReaction.Friendly,
      class: CombatUnitClass.Priest,
      spec: CombatUnitSpec.Priest_Holy,
    });
    const mate = makeUnit('m', {
      reaction: CombatUnitReaction.Friendly,
      class: CombatUnitClass.Warrior,
      spec: CombatUnitSpec.Warrior_Arms,
      deathRecords: [{ timestamp: T0 + 42_000, event: 'UNIT_DIED', parameters: [] }],
    });
    const foe = makeUnit('f', {
      reaction: CombatUnitReaction.Hostile,
      class: CombatUnitClass.Mage,
      spec: CombatUnitSpec.Mage_Fire,
      // Combustion at 30s: cooldown 120s / duration 10s -> solo burst window [30s, 40s],
      // which overlaps the 15s pre-death window [27s, 42s].
      spellCastEvents: [castSuccess('190319', T0 + 30_000, 'f')],
    });
    const combat = makeCombat([healer, mate, foe]);

    const features = extractFirstDeathFeatures(combat, [healer, mate], [foe], healer);

    expect(features).not.toBeNull();
    expect(features?.atSeconds).toBe(42);
    expect(features?.enemyBurstActive).toBe(true);
  });

  it('victimFocusShare / victimFocused: majority of in-window team damage landed on the victim', () => {
    const healer = makeUnit('h', {
      reaction: CombatUnitReaction.Friendly,
      class: CombatUnitClass.Priest,
      spec: CombatUnitSpec.Priest_Holy,
    });
    const victim = makeUnit('v', {
      reaction: CombatUnitReaction.Friendly,
      class: CombatUnitClass.Warrior,
      spec: CombatUnitSpec.Warrior_Arms,
      damageIn: [
        { effectiveAmount: 5000, logLine: { timestamp: T0 + 50_000, event: 'SPELL_DAMAGE', parameters: [] } },
        { effectiveAmount: 3000, logLine: { timestamp: T0 + 55_000, event: 'SPELL_DAMAGE', parameters: [] } },
      ],
      deathRecords: [{ timestamp: T0 + 60_000, event: 'UNIT_DIED', parameters: [] }],
    });
    const teammate = makeUnit('t', {
      reaction: CombatUnitReaction.Friendly,
      class: CombatUnitClass.Priest,
      spec: CombatUnitSpec.Priest_Discipline,
      damageIn: [{ effectiveAmount: 2000, logLine: { timestamp: T0 + 46_000, event: 'SPELL_DAMAGE', parameters: [] } }],
    });
    const foe = makeUnit('f', {
      reaction: CombatUnitReaction.Hostile,
      class: CombatUnitClass.Warrior,
      spec: CombatUnitSpec.Warrior_Arms,
    });
    const combat = makeCombat([healer, victim, teammate, foe]);

    // Team damage inside the 15s window [45s, 60s]: victim 8000, teammate 2000 -> share 0.8
    const features = extractFirstDeathFeatures(combat, [healer, victim, teammate], [foe], healer);

    expect(features).not.toBeNull();
    expect(features?.victimFocusShare).not.toBeNull();
    expect(features?.victimFocusShare as number).toBeGreaterThan(FOCUS_SHARE_THRESHOLD);
    expect(features?.victimFocused).toBe(true);
  });

  it('victimSwappedTo: damage majority shifts from a teammate to the victim across the window halves', () => {
    const healer = makeUnit('h', {
      reaction: CombatUnitReaction.Friendly,
      class: CombatUnitClass.Priest,
      spec: CombatUnitSpec.Priest_Holy,
    });
    const victim = makeUnit('v', {
      reaction: CombatUnitReaction.Friendly,
      class: CombatUnitClass.Warrior,
      spec: CombatUnitSpec.Warrior_Arms,
      // All damage lands in the second half [52.5s, 60s] of the window
      damageIn: [{ effectiveAmount: 6000, logLine: { timestamp: T0 + 55_000, event: 'SPELL_DAMAGE', parameters: [] } }],
      deathRecords: [{ timestamp: T0 + 60_000, event: 'UNIT_DIED', parameters: [] }],
    });
    const teammate = makeUnit('t', {
      reaction: CombatUnitReaction.Friendly,
      class: CombatUnitClass.Priest,
      spec: CombatUnitSpec.Priest_Discipline,
      // All damage lands in the first half [45s, 52.5s] of the window
      damageIn: [{ effectiveAmount: 5000, logLine: { timestamp: T0 + 46_000, event: 'SPELL_DAMAGE', parameters: [] } }],
    });
    const foe = makeUnit('f', {
      reaction: CombatUnitReaction.Hostile,
      class: CombatUnitClass.Warrior,
      spec: CombatUnitSpec.Warrior_Arms,
    });
    const combat = makeCombat([healer, victim, teammate, foe]);

    const features = extractFirstDeathFeatures(combat, [healer, victim, teammate], [foe], healer);

    expect(features).not.toBeNull();
    expect(features?.victimSwappedTo).toBe(true);
  });

  it('healerGcdIdle: true when the healer casts nothing while the victim sits below the idle HP threshold', () => {
    const healer = makeUnit('h', {
      reaction: CombatUnitReaction.Friendly,
      class: CombatUnitClass.Priest,
      spec: CombatUnitSpec.Priest_Holy,
      // No spellCastEvents -> the entire 15s pre-death window is one uninterrupted gap.
    });
    const victim = makeUnit('v', {
      reaction: CombatUnitReaction.Friendly,
      class: CombatUnitClass.Warrior,
      spec: CombatUnitSpec.Warrior_Arms,
      advancedActions: [
        {
          logLine: { event: 'SPELL_DAMAGE', timestamp: T0 + 45_000, parameters: [] },
          advancedActorId: 'v',
          advancedActorMaxHp: 100_000,
          advancedActorCurrentHp: 40_000, // 40% — below IDLE_HP_THRESHOLD_PCT (60)
        },
      ],
      deathRecords: [{ timestamp: T0 + 60_000, event: 'UNIT_DIED', parameters: [] }],
    });
    const foe = makeUnit('f', {
      reaction: CombatUnitReaction.Hostile,
      class: CombatUnitClass.Warrior,
      spec: CombatUnitSpec.Warrior_Arms,
    });
    const combat = makeCombat([healer, victim, foe]);

    const features = extractFirstDeathFeatures(combat, [healer, victim], [foe], healer);

    expect(features).not.toBeNull();
    expect(features?.healerMaxCastGapSeconds).toBeCloseTo(15, 1);
    expect(features?.healerGcdIdle).toBe(true);
  });
});

describe('bucketFirstDeath — deterministic decision list, first match wins', () => {
  it('A: healer CC-locked', () => {
    expect(
      bucketFirstDeath({ ...baseFeatures, healerCCLocked: true, victimDefensivesUnused: ['Die by the Sword'] }),
    ).toBe('A_HEALER_CC_LOCKED');
  });
  it('B: defensives held into a burst', () => {
    expect(
      bucketFirstDeath({
        ...baseFeatures,
        enemyBurstActive: true,
        victimDefensivesUnused: ['Die by the Sword'],
        victimUsedDefensiveInWindow: false,
      }),
    ).toBe('B_DEFENSIVES_HELD');
  });
  it('C: coordinated focus with defensives spent', () => {
    expect(bucketFirstDeath({ ...baseFeatures, enemyBurstActive: true, victimFocused: true })).toBe(
      'C_COORDINATED_FOCUS',
    );
  });
  it('D: healer idle', () => {
    expect(bucketFirstDeath({ ...baseFeatures, healerGcdIdle: true })).toBe('D_HEALER_IDLE');
  });
  it('UNCLASSIFIED when nothing matches', () => {
    expect(bucketFirstDeath(baseFeatures)).toBe('UNCLASSIFIED');
  });
  it('priority: A wins even when the B condition is simultaneously true (first match wins)', () => {
    expect(
      bucketFirstDeath({
        ...baseFeatures,
        healerCCLocked: true,
        enemyBurstActive: true,
        victimDefensivesUnused: ['Die by the Sword'],
        victimUsedDefensiveInWindow: false,
      }),
    ).toBe('A_HEALER_CC_LOCKED');
  });
});

import {
  AtomicArenaCombat,
  CombatResult,
  CombatUnitClass,
  CombatUnitReaction,
  CombatUnitSpec,
  ICombatUnit,
} from '@wowarenalogs/parser';

import { bucketFirstDeath, extractFirstDeathFeatures, IFirstDeathFeatures } from '../firstDeath';
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
});

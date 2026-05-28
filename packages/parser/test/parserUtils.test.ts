/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  CombatUnitAffiliation,
  CombatUnitClass,
  CombatUnitPowerType,
  CombatUnitReaction,
  CombatUnitSpec,
  CombatUnitType,
} from '../src/types';
import {
  buildMMRHelpers,
  buildQueryHelpers,
  computeCanonicalHash,
  getBurstDps,
  getClassColor,
  getEffectiveCombatDuration,
  getEffectiveDps,
  getEffectiveHps,
  getPowerColor,
  getUnitAffiliation,
  getUnitReaction,
  getUnitType,
  nullthrows,
  parseQuotedName,
} from '../src/utils';

describe('parser utils', () => {
  it('nullthrows handles null/undefined (B87)', () => {
    expect(nullthrows('val')).toBe('val');
    expect(() => nullthrows(null)).toThrow();
    expect(() => nullthrows(undefined)).toThrow();
  });

  it('parseQuotedName removes quotes', () => {
    expect(parseQuotedName('"Player-Name"')).toBe('Player-Name');
  });

  it('computeCanonicalHash produces a hash', () => {
    expect(computeCanonicalHash(['line1', 'line2'])).toHaveLength(32);
  });

  it('getUnitType correctly masks flags (B88)', () => {
    expect(getUnitType(0x00000400)).toBe(CombatUnitType.Player);
    expect(getUnitType(0x00000800)).toBe(CombatUnitType.NPC);
    expect(getUnitType(0x00001000)).toBe(CombatUnitType.Pet);
    expect(getUnitType(0x00002000)).toBe(CombatUnitType.Guardian);
    expect(getUnitType(0x00004000)).toBe(CombatUnitType.Object);
    expect(getUnitType(0)).toBe(CombatUnitType.None);
  });

  it('getUnitReaction correctly masks flags (B89)', () => {
    expect(getUnitReaction(0x00000040)).toBe(CombatUnitReaction.Hostile);
    expect(getUnitReaction(0x00000010)).toBe(CombatUnitReaction.Friendly);
    expect(getUnitReaction(0)).toBe(CombatUnitReaction.Neutral);
  });

  it('getUnitAffiliation correctly masks flags (B90)', () => {
    expect(getUnitAffiliation(0x00000001)).toBe(CombatUnitAffiliation.Mine);
    expect(getUnitAffiliation(0x00000002)).toBe(CombatUnitAffiliation.Party);
    expect(getUnitAffiliation(0x00000004)).toBe(CombatUnitAffiliation.Raid);
    expect(getUnitAffiliation(0x00000008)).toBe(CombatUnitAffiliation.Outsider);
    expect(getUnitAffiliation(0)).toBe(CombatUnitAffiliation.None);
  });

  it('getPowerColor returns hex or transparent (B91)', () => {
    expect(getPowerColor(CombatUnitPowerType.Mana)).toBe('#0000FF');
    expect(getPowerColor(CombatUnitPowerType.Rage)).toBe('#FF0000');
    expect(getPowerColor(CombatUnitPowerType.Energy)).toBe('#FFFF00');
    expect(getPowerColor(CombatUnitPowerType.RunicPower)).toBe('#00D1FF');
    expect(getPowerColor(999 as any)).toBe('transparent');
  });

  it('getClassColor returns hex', () => {
    expect(getClassColor(CombatUnitClass.Mage)).toBe('#40C7EB');
    expect(getClassColor(999 as any)).toBe('#607D8B');
  });

  it('buildMMRHelpers handles ArenaMatch and ShuffleRound (B92)', () => {
    const arena: any = {
      dataType: 'ArenaMatch',
      endInfo: { team0MMR: 2000, team1MMR: 2100 },
    };
    const res = buildMMRHelpers(arena);
    expect(res.matchAverageMMR).toBe(2050);
  });

  it('buildQueryHelpers constructs analytics strings (B93)', () => {
    const units: any = {
      '1': {
        id: '1',
        type: CombatUnitType.Player,
        spec: CombatUnitSpec.Warrior_Arms,
        info: { teamId: '0' },
        class: CombatUnitClass.Warrior,
      },
      '2': {
        id: '2',
        type: CombatUnitType.Player,
        spec: CombatUnitSpec.Paladin_Retribution,
        info: { teamId: '0' },
        class: CombatUnitClass.Paladin,
      },
      '3': {
        id: '3',
        type: CombatUnitType.Player,
        spec: CombatUnitSpec.Druid_Restoration,
        info: { teamId: '0' },
        class: CombatUnitClass.Druid,
      },
      '4': {
        id: '4',
        type: CombatUnitType.Player,
        spec: CombatUnitSpec.Mage_Frost,
        info: { teamId: '1' },
        class: CombatUnitClass.Mage,
      },
      '5': {
        id: '5',
        type: CombatUnitType.Player,
        spec: CombatUnitSpec.Priest_Holy,
        info: { teamId: '1' },
        class: CombatUnitClass.Priest,
      },
      '6': {
        id: '6',
        type: CombatUnitType.Player,
        spec: CombatUnitSpec.Rogue_Assassination,
        info: { teamId: '1' },
        class: CombatUnitClass.Rogue,
      },
    };

    // Team 1 wins
    const com: any = { units, winningTeamId: '1' };
    const res = buildQueryHelpers(com, true);
    expect(res.singleSidedSpecsWinners).toContain(CombatUnitSpec.Mage_Frost);
    expect(res.doubleSidedSpecsWLHS).toContain(`${CombatUnitSpec.Mage_Frost}x${CombatUnitSpec.Warrior_Arms}`);

    // Team 0 wins
    const com2: any = { units, winningTeamId: '0' };
    const res2 = buildQueryHelpers(com2, true);
    expect(res2.singleSidedSpecsWinners).toContain(CombatUnitSpec.Warrior_Arms);
  });

  it('getEffectiveCombatDuration calculates based on damage events (B94)', () => {
    const com: any = {
      startTime: 1000,
      endTime: 10000,
      events: [
        { logLine: { event: 'SPELL_DAMAGE', timestamp: 2000 } },
        { logLine: { event: 'SPELL_DAMAGE', timestamp: 5000 } },
      ],
    };
    expect(getEffectiveCombatDuration(com)).toBe(3);
  });

  it('getEffectiveDps and getEffectiveHps', () => {
    const units: any = [
      {
        damageOut: [{ effectiveAmount: -100000 }],
        healOut: [{ effectiveAmount: 50000 }],
        absorbsOut: [{ effectiveAmount: 25000 }],
      },
    ];
    expect(getEffectiveDps(units, 2)).toBe(50000);
    expect(getEffectiveHps(units, 2)).toBe(37500);
  });

  it('getBurstDps calculates peak window with multiple events (B119)', () => {
    const units: any = [
      {
        damageOut: [
          { timestamp: 1000, effectiveAmount: -100000 },
          { timestamp: 2000, effectiveAmount: -100000 },
          { timestamp: 5000, effectiveAmount: -300000 }, // Peak starts here
          { timestamp: 6000, effectiveAmount: -300000 },
          { timestamp: 10000, effectiveAmount: -100000 },
        ],
      },
    ];
    // peak 3s window is [5000, 8000] -> contains 5000 and 6000 events.
    // Total = 600k. Over 3s = 200k.
    expect(getBurstDps(units)).toBe(200000);
  });
});

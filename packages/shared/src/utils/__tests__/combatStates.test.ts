/* eslint-disable @typescript-eslint/no-explicit-any */

// packages/shared/src/utils/__tests__/combatStates.test.ts
import {
  AtomicArenaCombat,
  CombatUnitClass,
  CombatUnitReaction,
  CombatUnitSpec,
  CombatUnitType,
  ICombatUnit,
  LogEvent,
} from '@wowarenalogs/parser';

import { extractShapeshiftIntervals, extractSpiritOfRedemptionIntervals, extractStasisEvents } from '../combatStates';

describe('combatStates', () => {
  const mockCombat = {
    startTime: 0,
    endTime: 10000,
  } as AtomicArenaCombat;

  const mockUnit: ICombatUnit = {
    id: 'Player-1',
    name: 'TestDruid',
    class: CombatUnitClass.Druid,
    spec: CombatUnitSpec.Druid_Restoration,
    reaction: CombatUnitReaction.Friendly,
    type: CombatUnitType.Player,
    isWellFormed: true,
    ownerId: 'Player-1',
    affiliation: 1,
    damageIn: [],
    damageOut: [],
    healIn: [],
    healOut: [],
    absorbsIn: [],
    absorbsOut: [],
    absorbsDamaged: [],
    supportDamageIn: [],
    supportDamageOut: [],
    supportHealIn: [],
    supportHealOut: [],
    actionIn: [],
    actionOut: [],
    deathRecords: [],
    consciousDeathRecords: [],
    advancedActions: [],
    auraEvents: [
      {
        logLine: { event: LogEvent.SPELL_AURA_APPLIED, timestamp: 1000 },
        spellId: '5487',
        spellName: 'Bear Form (Shapeshift)',
      } as any,
      {
        logLine: { event: LogEvent.SPELL_AURA_REMOVED, timestamp: 3000 },
        spellId: '5487',
        spellName: 'Bear Form (Shapeshift)',
      } as any,
      {
        logLine: { event: LogEvent.SPELL_AURA_APPLIED, timestamp: 4000 },
        spellId: '768',
        spellName: 'Cat Form (Shapeshift)',
      } as any,
      {
        logLine: { event: LogEvent.SPELL_AURA_REMOVED, timestamp: 8000 },
        spellId: '768',
        spellName: 'Cat Form (Shapeshift)',
      } as any,
    ],
    spellCastEvents: [
      {
        logLine: { event: LogEvent.SPELL_AURA_APPLIED, timestamp: 2000 },
        spellId: '370537',
        spellName: 'Stasis',
      } as any,
      {
        logLine: { event: LogEvent.SPELL_CAST_SUCCESS, timestamp: 2500 },
        spellId: '366155',
        spellName: 'Reversion',
      } as any,
      {
        logLine: { event: LogEvent.SPELL_CAST_SUCCESS, timestamp: 3500 },
        spellId: '355936',
        spellName: 'Dream Breath',
      } as any,
      {
        logLine: { event: LogEvent.SPELL_AURA_REMOVED, timestamp: 5000 },
        spellId: '370537',
        spellName: 'Stasis',
      } as any,
    ],
  };

  it('extractShapeshiftIntervals extracts form intervals', () => {
    const intervals = extractShapeshiftIntervals(mockUnit, mockCombat);
    expect(intervals).toHaveLength(2);
    expect(intervals[0]).toEqual({ form: 'Bear', startSeconds: 1, endSeconds: 3 });
    expect(intervals[1]).toEqual({ form: 'Cat', startSeconds: 4, endSeconds: 8 });
  });

  it('extractSpiritOfRedemptionIntervals extracts ghost form intervals', () => {
    const ghostUnit: ICombatUnit = {
      ...mockUnit,
      auraEvents: [
        {
          logLine: { event: LogEvent.SPELL_AURA_APPLIED, timestamp: 2000 },
          spellId: '27827',
          spellName: 'Spirit of Redemption',
        } as any,
        {
          logLine: { event: LogEvent.SPELL_AURA_REMOVED, timestamp: 5000 },
          spellId: '27827',
          spellName: 'Spirit of Redemption',
        } as any,
        {
          logLine: { event: LogEvent.SPELL_AURA_APPLIED, timestamp: 7000 },
          spellId: '215982',
          spellName: 'Spirit of Redemption',
        } as any,
      ],
    };
    const intervals = extractSpiritOfRedemptionIntervals(ghostUnit, mockCombat);
    expect(intervals).toHaveLength(2);
    expect(intervals[0]).toEqual({ startSeconds: 2, endSeconds: 5 });
    expect(intervals[1]).toEqual({ startSeconds: 7, endSeconds: 10 }); // capped at combat.endTime
  });

  it('extractStasisEvents extracts buffered spells', () => {
    const stasisEvents = extractStasisEvents(mockUnit, mockCombat);
    expect(stasisEvents).toHaveLength(1);
    expect(stasisEvents[0].startSeconds).toBe(2);
    expect(stasisEvents[0].releaseSeconds).toBe(5);
    expect(stasisEvents[0].spells).toEqual(['Reversion', 'Dream Breath']);
  });

  it('extractShapeshiftIntervals handles direct Bear -> Cat shifting at the exact same timestamp', () => {
    const shiftUnit: ICombatUnit = {
      ...mockUnit,
      auraEvents: [
        {
          logLine: { event: LogEvent.SPELL_AURA_APPLIED, timestamp: 1000 },
          spellId: '5487',
          spellName: 'Bear Form (Shapeshift)',
        } as any,
        {
          logLine: { event: LogEvent.SPELL_AURA_APPLIED, timestamp: 2000 },
          spellId: '768',
          spellName: 'Cat Form (Shapeshift)',
        } as any,
        {
          logLine: { event: LogEvent.SPELL_AURA_REMOVED, timestamp: 2000 },
          spellId: '5487',
          spellName: 'Bear Form (Shapeshift)',
        } as any,
        {
          logLine: { event: LogEvent.SPELL_AURA_REMOVED, timestamp: 3000 },
          spellId: '768',
          spellName: 'Cat Form (Shapeshift)',
        } as any,
      ],
    };
    const intervals = extractShapeshiftIntervals(shiftUnit, mockCombat);
    expect(intervals).toHaveLength(2);
    expect(intervals[0]).toEqual({ form: 'Bear', startSeconds: 1, endSeconds: 2 });
    expect(intervals[1]).toEqual({ form: 'Cat', startSeconds: 2, endSeconds: 3 });
  });

  it('extractStasisEvents filters utility spells and handles simultaneous events properly', () => {
    const evokerUnit: ICombatUnit = {
      ...mockUnit,
      auraEvents: [
        {
          logLine: { event: LogEvent.SPELL_AURA_APPLIED, timestamp: 2000 },
          spellId: '370537',
          spellName: 'Stasis',
        } as any,
        {
          logLine: { event: LogEvent.SPELL_AURA_REMOVED, timestamp: 5000 },
          spellId: '370537',
          spellName: 'Stasis',
        } as any,
      ],
      spellCastEvents: [
        {
          logLine: { event: LogEvent.SPELL_CAST_SUCCESS, timestamp: 2500 },
          spellId: '366155',
          spellName: 'Reversion',
        } as any,
        {
          logLine: { event: LogEvent.SPELL_CAST_SUCCESS, timestamp: 3000 },
          spellId: '358267',
          spellName: 'Hover',
        } as any,
        {
          logLine: { event: LogEvent.SPELL_CAST_SUCCESS, timestamp: 5000 }, // same ms as stasis removal
          spellId: '355936',
          spellName: 'Dream Breath',
        } as any,
      ],
    };
    const stasisEvents = extractStasisEvents(evokerUnit, mockCombat);
    expect(stasisEvents).toHaveLength(1);
    expect(stasisEvents[0].startSeconds).toBe(2);
    expect(stasisEvents[0].releaseSeconds).toBe(5);
    expect(stasisEvents[0].spells).toEqual(['Reversion', 'Dream Breath']);
  });

  it('extractStasisEvents records storedCount from dose removals when a stored spell name is not resolvable', () => {
    // A stored spell outside the heal allow-list (e.g. an offensively-stored
    // Fire Breath) cannot be named, but the dose removals prove the release was
    // NOT empty. storedCount must reflect that so the timeline never renders a
    // misleading empty "[STASIS RELEASE] → ".
    const evokerUnit: ICombatUnit = {
      ...mockUnit,
      auraEvents: [
        {
          logLine: { event: LogEvent.SPELL_AURA_APPLIED, timestamp: 2000 },
          spellId: '370537',
          spellName: 'Stasis',
        } as any,
        {
          logLine: { event: LogEvent.SPELL_AURA_REMOVED_DOSE, timestamp: 3000 },
          spellId: '370537',
          spellName: 'Stasis',
        } as any,
        {
          logLine: { event: LogEvent.SPELL_AURA_REMOVED_DOSE, timestamp: 4000 },
          spellId: '370537',
          spellName: 'Stasis',
        } as any,
        {
          logLine: { event: LogEvent.SPELL_AURA_REMOVED, timestamp: 5000 },
          spellId: '370537',
          spellName: 'Stasis',
        } as any,
      ],
      spellCastEvents: [
        {
          logLine: { event: LogEvent.SPELL_CAST_SUCCESS, timestamp: 2500 },
          spellId: '357208', // Fire Breath — not in the heal allow-list
          spellName: 'Fire Breath',
        } as any,
      ],
    };
    const stasisEvents = extractStasisEvents(evokerUnit, mockCombat);
    expect(stasisEvents).toHaveLength(1);
    expect(stasisEvents[0].spells).toEqual([]); // name not resolvable from the heal list
    expect(stasisEvents[0].storedCount).toBe(3); // 2 dose removals + final removal
  });
});

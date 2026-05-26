/* eslint-disable @typescript-eslint/no-explicit-any */
import { CombatHpUpdateAction, CombatUnitReaction, CombatUnitSpec, LogEvent } from '@wowarenalogs/parser';

import { buildOffensiveWasteSummary, formatOffensiveWasteForContext } from '../offensiveWasteAnalysis';
import { makeAuraEvent, makeUnit } from './testHelpers';

const MATCH_START = 1_000_000;
const MATCH_END = 1_300_000;

function makeCombat() {
  return { startTime: MATCH_START, endTime: MATCH_END } as any;
}

const enemyId = 'enemy-1';

function makeDamageCast(spellId: string, spellName: string, timestamp: number, srcUnitId: string, destUnitId: string) {
  return {
    logLine: { event: LogEvent.SPELL_CAST_SUCCESS, timestamp, parameters: [] },
    spellId,
    spellName,
    srcUnitId,
    destUnitId,
    timestamp,
  };
}

function withDamageOut(unit: any, damages: { spellId: string; effectiveAmount: number }[]) {
  unit.damageOut = damages.map((d) => {
    // Create a mock that passes `instanceof CombatHpUpdateAction`
    const action = Object.create(CombatHpUpdateAction.prototype);
    Object.assign(action, {
      spellId: d.spellId,
      effectiveAmount: d.effectiveAmount,
      logLine: { event: LogEvent.SPELL_DAMAGE, timestamp: MATCH_START + 1000, parameters: [] },
    });
    return action;
  });
  return unit;
}

describe('buildOffensiveWasteSummary', () => {
  it('returns empty when no immunity windows exist', () => {
    const friend = makeUnit('f1', { spec: CombatUnitSpec.Warrior_Arms });
    const enemy = makeUnit(enemyId, { reaction: CombatUnitReaction.Hostile });
    const result = buildOffensiveWasteSummary(makeCombat() as any, [friend], [enemy]);
    expect(result.events).toHaveLength(0);
  });

  it('does NOT flag a single cast into immunity (below threshold of 2)', () => {
    const enemy = makeUnit(enemyId, {
      reaction: CombatUnitReaction.Hostile,
      spec: CombatUnitSpec.Paladin_Retribution,
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '642', MATCH_START + 30_000, enemyId, enemyId, 'BUFF'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '642', MATCH_START + 38_000, enemyId, enemyId, 'BUFF'),
      ],
    });
    const cast = makeDamageCast('1', 'Spell', MATCH_START + 32_000, 'f1', enemyId);
    const friend = withDamageOut(makeUnit('f1', { spec: CombatUnitSpec.Warrior_Arms }), [
      { spellId: '1', effectiveAmount: 100_000 },
    ]);
    friend.spellCastEvents = [cast];
    const result = buildOffensiveWasteSummary(makeCombat() as any, [friend], [enemy]);
    expect(result.events).toHaveLength(0);
  });

  it('flags ≥2 high-value casts into an immunity window', () => {
    const enemy = makeUnit(enemyId, {
      reaction: CombatUnitReaction.Hostile,
      spec: CombatUnitSpec.Paladin_Retribution,
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '642', MATCH_START + 30_000, enemyId, enemyId, 'BUFF'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '642', MATCH_START + 38_000, enemyId, enemyId, 'BUFF'),
      ],
    });
    const cast1 = makeDamageCast('1', 'Spell A', MATCH_START + 32_000, 'f1', enemyId);
    const cast2 = makeDamageCast('2', 'Spell B', MATCH_START + 34_000, 'f1', enemyId);
    const friend = withDamageOut(makeUnit('f1', { spec: CombatUnitSpec.Warrior_Arms }), [
      { spellId: '1', effectiveAmount: 100_000 },
      { spellId: '2', effectiveAmount: 100_000 },
    ]);
    friend.spellCastEvents = [cast1, cast2];
    const result = buildOffensiveWasteSummary(makeCombat() as any, [friend], [enemy]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].wasteCasts).toHaveLength(2);
  });

  it('flags high-value CC/utility casts into immunity even if they do zero damage (B28)', () => {
    const enemy = makeUnit(enemyId, {
      reaction: CombatUnitReaction.Hostile,
      spec: CombatUnitSpec.Paladin_Retribution,
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '642', MATCH_START + 30_000, enemyId, enemyId, 'BUFF'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '642', MATCH_START + 38_000, enemyId, enemyId, 'BUFF'),
      ],
    });
    const cast1 = makeDamageCast('853', 'Hammer of Justice', MATCH_START + 32_000, 'f1', enemyId);
    (cast1 as any).effectiveAmount = 0;
    const cast2 = makeDamageCast('323673', 'Mindgames', MATCH_START + 34_000, 'f1', enemyId);
    (cast2 as any).effectiveAmount = 0;

    const friend = withDamageOut(makeUnit('f1', { spec: CombatUnitSpec.Paladin_Holy }), []);
    friend.spellCastEvents = [cast1, cast2];
    const result = buildOffensiveWasteSummary(makeCombat() as any, [friend], [enemy]);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].wasteCasts).toHaveLength(2);
  });

  it('filters out low-value/passive procs from waste counts', () => {
    const enemy = makeUnit(enemyId, {
      reaction: CombatUnitReaction.Hostile,
      spec: CombatUnitSpec.Warrior_Arms,
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '642', MATCH_START + 30_000, enemyId, enemyId, 'BUFF'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '642', MATCH_START + 38_000, enemyId, enemyId, 'BUFF'),
      ],
    });
    const bigHit = makeDamageCast('1', 'Big Hit', MATCH_START + 32_000, 'f1', enemyId);
    (bigHit as any).effectiveAmount = 100_000;
    const tinyHit = makeDamageCast('2', 'Tiny Proc', MATCH_START + 34_000, 'f1', enemyId);
    (tinyHit as any).effectiveAmount = 1_000;

    const friend = withDamageOut(makeUnit('f1', { spec: CombatUnitSpec.Warrior_Arms }), [
      { spellId: '1', effectiveAmount: 100_000 },
      { spellId: '2', effectiveAmount: 1_000 },
    ]);
    friend.spellCastEvents = [bigHit, tinyHit];

    const result = buildOffensiveWasteSummary(makeCombat() as any, [friend], [enemy]);
    expect(result.events).toHaveLength(0);
  });
});

describe('formatOffensiveWasteForContext', () => {
  it('formats correctly with events', () => {
    const summary: any = {
      events: [
        {
          casterName: 'C1',
          casterSpec: 'Arms Warrior',
          targetName: 'T1',
          defenseName: 'Shield',
          defenseWindowSeconds: [10, 20],
          wasteCasts: [{ spellName: 'Mortal Strike' }, { spellName: 'Execute' }],
        },
      ],
    };
    const res = formatOffensiveWasteForContext(summary);
    expect(res).toContain('0:10');
    expect(res).toContain('Mortal Strike + Execute');
    expect(res).toContain("T1's Shield");
  });

  it('returns empty for no events', () => {
    expect(formatOffensiveWasteForContext({ events: [] })).toBe('');
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import { CombatUnitSpec, LogEvent } from '@wowarenalogs/parser';

import { buildDeathOutcomeSummary, formatDeathOutcomeForContext } from '../deathOutcomeAnalysis';
import { makeAdvancedAction, makeAuraEvent, makeSpellCastEvent, makeUnit } from './testHelpers';

const MATCH_START = 1_000_000;
const MATCH_END = 1_300_000;

function makeCombat() {
  return { startTime: MATCH_START, endTime: MATCH_END, startInfo: { zoneId: '1505' } };
}

function makeDeadUnit(id: string, deathTimestampMs: number, overrides: any = {}) {
  const u = makeUnit(id, overrides) as any;
  u.deathRecords = [{ timestamp: deathTimestampMs, event: LogEvent.UNIT_DIED, parameters: [] }];
  return u;
}

function makeCCSummary(playerName: string, instances: any[] = []): any {
  return { playerName, ccInstances: instances };
}

describe('buildDeathOutcomeSummary — immunity checks', () => {
  it('returns empty events when no friendly deaths occurred', () => {
    const result = buildDeathOutcomeSummary(makeCombat() as any, [], []);
    expect(result.events).toHaveLength(0);
  });

  it('flags Divine Shield available at death when never used', () => {
    const dead = makeDeadUnit('p1', MATCH_START + 10_000, { spec: CombatUnitSpec.Paladin_Retribution });
    const result = buildDeathOutcomeSummary(makeCombat() as any, [dead], [makeCCSummary('p1')]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].availableImmunities).toHaveLength(1);
    expect(result.events[0].availableImmunities[0].spellName).toBe('Divine Shield');
  });

  it('does NOT flag Divine Shield when it was used recently (still on CD)', () => {
    const dead = makeDeadUnit('p1', MATCH_START + 40_000, {
      spec: CombatUnitSpec.Paladin_Retribution,
      spellCastEvents: [makeSpellCastEvent('642', MATCH_START + 10_000, 'p1')],
    });
    const result = buildDeathOutcomeSummary(makeCombat() as any, [dead], [makeCCSummary('p1')]);
    expect(result.events[0]?.availableImmunities ?? []).toHaveLength(0);
  });

  it('flags Ice Block available when Cold Snap reset the cooldown (B30)', () => {
    const dead = makeDeadUnit('p1', MATCH_START + 40_000, {
      spec: CombatUnitSpec.Mage_Frost,
      spellCastEvents: [
        // Ice Block cast at t=10s (CD=240s)
        makeSpellCastEvent('45438', MATCH_START + 10_000, 'p1', 'Self', 'p1', 'Mage'),
        // Cold Snap cast at t=20s (Resets Ice Block)
        makeSpellCastEvent('235219', MATCH_START + 20_000, 'p1', 'Self', 'p1', 'Mage'),
      ],
    });
    const result = buildDeathOutcomeSummary(makeCombat() as any, [dead], [makeCCSummary('p1')]);
    expect(result.events[0].availableImmunities).toHaveLength(1);
    expect(result.events[0].availableImmunities[0].spellName).toBe('Ice Block');
  });

  it('correctly handles multiple lockout intervals via binary search (B29)', () => {
    const dead = makeUnit('p1', {
      spec: CombatUnitSpec.Mage_Frost,
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '41425', MATCH_START + 10_000, 'p1', 'p1', 'DEBUFF'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '41425', MATCH_START + 20_000, 'p1', 'p1', 'DEBUFF'),
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '41425', MATCH_START + 40_000, 'p1', 'p1', 'DEBUFF'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '41425', MATCH_START + 50_000, 'p1', 'p1', 'DEBUFF'),
      ],
    }) as any;
    // Three deaths: 15s (locked), 30s (free), 45s (locked)
    dead.deathRecords = [
      { timestamp: MATCH_START + 15_000, event: LogEvent.UNIT_DIED, parameters: [] },
      { timestamp: MATCH_START + 30_000, event: LogEvent.UNIT_DIED, parameters: [] },
      { timestamp: MATCH_START + 45_000, event: LogEvent.UNIT_DIED, parameters: [] },
    ];

    const result = buildDeathOutcomeSummary(makeCombat() as any, [dead], [makeCCSummary('p1')]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].atSeconds).toBe(30);
  });
});

describe('buildDeathOutcomeSummary — external defensive checks', () => {
  it('flags missed Ironbark when Druid was free and had it available', () => {
    const warrior = makeDeadUnit('w1', MATCH_START + 90_000, { spec: CombatUnitSpec.Warrior_Arms, name: 'Warrior' });
    const druid = makeUnit('d1', { spec: CombatUnitSpec.Druid_Restoration, name: 'Druid' });
    const result = buildDeathOutcomeSummary(
      makeCombat() as any,
      [warrior, druid],
      [makeCCSummary('Warrior'), makeCCSummary('Druid')],
    );
    expect(result.events[0].missedExternals).toHaveLength(1);
    expect(result.events[0].missedExternals[0].spellName).toBe('Ironbark');
  });

  it('skips Ironbark when Druid was too far away (>40 yards) at death time (B27)', () => {
    const warrior = makeDeadUnit('w1', MATCH_START + 90_000, {
      spec: CombatUnitSpec.Warrior_Arms,
      name: 'Warrior',
      advancedActions: [makeAdvancedAction(MATCH_START + 90_000, 0, 0)],
    });
    const druid = makeUnit('d1', {
      spec: CombatUnitSpec.Druid_Restoration,
      name: 'Druid',
      advancedActions: [makeAdvancedAction(MATCH_START + 90_000, 50, 0)],
    });
    const result = buildDeathOutcomeSummary(
      makeCombat() as any,
      [warrior, druid],
      [makeCCSummary('Warrior'), makeCCSummary('Druid')],
    );
    expect(result.events[0]?.missedExternals ?? []).toHaveLength(0);
  });

  it('flags missed external when teammate cast the spell this match (B113)', () => {
    // Cast at MATCH_START - 500s (so it's available at t=90s)
    const warrior = makeDeadUnit('w1', MATCH_START + 90_000, { spec: CombatUnitSpec.Warrior_Arms, name: 'Warrior' });
    const spriest = makeUnit('p1', {
      spec: CombatUnitSpec.Priest_Shadow,
      name: 'Priest',
      spellCastEvents: [makeSpellCastEvent('47788', MATCH_START - 500_000, 'w1', 'Warrior', 'p1', 'Priest')], // GS
    });
    const result = buildDeathOutcomeSummary(
      makeCombat() as any,
      [warrior, spriest],
      [makeCCSummary('Warrior'), makeCCSummary('Priest')],
    );
    expect(result.events[0].missedExternals).toHaveLength(1);
    expect(result.events[0].missedExternals[0].spellName).toBe('Guardian Spirit');
  });
});

describe('formatDeathOutcomeForContext', () => {
  it('formats multiple events correctly', () => {
    const summary: any = {
      events: [
        {
          deadPlayer: 'P1',
          deadPlayerSpec: 'Arms Warrior',
          atSeconds: 100,
          availableImmunities: [{ spellName: 'Shield', wasInCC: true }],
          missedExternals: [{ casterName: 'C1', spellName: 'Bark', casterWasInCC: false }],
        },
      ],
    };
    const res = formatDeathOutcomeForContext(summary);
    expect(res).toContain('1:40');
    expect(res).toContain('had Shield available, was in CC');
    expect(res).toContain('C1 had Bark available, caster was free');
  });

  it('returns empty for no events', () => {
    expect(formatDeathOutcomeForContext({ events: [] })).toBe('');
  });
});

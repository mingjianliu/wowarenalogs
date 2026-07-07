import {
  AtomicArenaCombat,
  CombatResult,
  CombatUnitClass,
  CombatUnitReaction,
  CombatUnitSpec,
  ICombatUnit,
} from '@wowarenalogs/parser';

import { spellEffectData } from '../../data/spellEffectData';
import { reconstructEnemyCDTimeline } from '../enemyCDs';
import { buildMatchupIntel } from '../matchupIntel';
import { makeUnit } from './testHelpers';

const T0 = 1_000_000;
const T_END = T0 + 120_000; // 2 min match

function makeCombat(units: ICombatUnit[], overrides: Record<string, unknown> = {}): AtomicArenaCombat {
  return {
    startTime: T0,
    endTime: T_END,
    playerId: units[0]?.id,
    result: CombatResult.Win,
    units: Object.fromEntries(units.map((u) => [u.id, u])),
    startInfo: { bracket: '3v3', zoneId: 0 },
    ...overrides,
  } as unknown as AtomicArenaCombat;
}

function castSuccess(spellId: string, atMs: number, srcId: string) {
  return {
    spellId,
    srcUnitId: srcId,
    logLine: { event: 'SPELL_CAST_SUCCESS', timestamp: atMs, parameters: [] },
  };
}

describe('buildMatchupIntel', () => {
  it('returns hasBurstWindows=false and empty sections for a match with no enemy CD casts', () => {
    const me = makeUnit('me', {
      reaction: CombatUnitReaction.Friendly,
      class: CombatUnitClass.Paladin,
      spec: CombatUnitSpec.Paladin_Holy,
    });
    const foe = makeUnit('foe', {
      reaction: CombatUnitReaction.Hostile,
      class: CombatUnitClass.Warrior,
      spec: CombatUnitSpec.Warrior_Arms,
    });
    const combat = makeCombat([me, foe]);

    const card = buildMatchupIntel(combat, [me], [foe]);

    expect(card.hasBurstWindows).toBe(false);
    expect(card.killWindows).toEqual([]);
    expect(card.enemyCDInventory).toEqual([]);
    expect(card.enemyComp).toEqual(['Arms Warrior']);
    expect(card.isWin).toBe(true);
  });

  it('mirrors reconstructEnemyCDTimeline windows and attaches hold status per window', () => {
    // Guard: the test is meaningless if Combustion left the dataset — fail loudly, never vacuously.
    expect(spellEffectData['190319']).toBeDefined();

    const me = makeUnit('me', {
      reaction: CombatUnitReaction.Friendly,
      class: CombatUnitClass.Paladin,
      spec: CombatUnitSpec.Paladin_Holy,
    });
    const mage = makeUnit('mage', {
      reaction: CombatUnitReaction.Hostile,
      class: CombatUnitClass.Mage,
      spec: CombatUnitSpec.Mage_Fire,
      spellCastEvents: [castSuccess('190319', T0 + 30_000, 'mage')], // Combustion at 30s
    });
    const combat = makeCombat([me, mage]);

    const card = buildMatchupIntel(combat, [me], [mage]);
    const timeline = reconstructEnemyCDTimeline([mage], combat, me, [me]);

    expect(card.killWindows.length).toBe(timeline.alignedBurstWindows.length);
    expect(card.enemyCDInventory.length).toBe(timeline.players.length);
    for (const w of card.killWindows) {
      // every hold entry reports availability at window start and use-in-window
      for (const h of w.holds) {
        expect(typeof h.availableAtWindowStart).toBe('boolean');
        expect(typeof h.castInWindow).toBe('boolean');
        expect(h.spellName.length).toBeGreaterThan(0);
      }
    }
  });

  it('collects enemy CC applied to the friendly healer with kill-window flag', () => {
    const healer = makeUnit('healer', {
      reaction: CombatUnitReaction.Friendly,
      class: CombatUnitClass.Priest,
      spec: CombatUnitSpec.Priest_Holy,
      auraEvents: [
        {
          spellId: '118', // Polymorph — in ccSpellIds
          srcUnitId: 'mage',
          logLine: { event: 'SPELL_AURA_APPLIED', timestamp: T0 + 40_000, parameters: [] },
        },
      ],
    });
    const mage = makeUnit('mage', {
      reaction: CombatUnitReaction.Hostile,
      class: CombatUnitClass.Mage,
      spec: CombatUnitSpec.Mage_Fire,
    });
    const combat = makeCombat([healer, mage]);

    const card = buildMatchupIntel(combat, [healer], [mage]);

    expect(card.ccOnHealer.length).toBe(1);
    expect(card.ccOnHealer[0].atSeconds).toBe(40);
    expect(card.ccOnHealer[0].spellId).toBe('118');
  });
});

import { AtomicArenaCombat, CombatUnitClass, CombatUnitReaction, CombatUnitSpec } from '@wowarenalogs/parser';

import { makeUnit } from '../../../../utils/__tests__/testHelpers';
import { buildMatchContext } from '../buildMatchContext';

describe('buildMatchContext — owner override', () => {
  const T0 = 1_000_000;
  const T_END = 1_120_000; // 2 min

  function makeCombatFull(friendA: ReturnType<typeof makeUnit>, friendB: ReturnType<typeof makeUnit>) {
    const enemy = makeUnit('enemy-1', {
      reaction: CombatUnitReaction.Hostile,
      class: CombatUnitClass.Warrior,
      spec: CombatUnitSpec.Warrior_Arms,
    });
    return {
      startTime: T0,
      endTime: T_END,
      playerId: friendA.id,
      playerTeamId: 'team-1',
      units: {
        [friendA.id]: friendA,
        [friendB.id]: friendB,
        [enemy.id]: enemy,
      },
      startInfo: { bracket: '2v2', zoneId: 0 },
    } as unknown as AtomicArenaCombat;
  }

  it('defaults to the log owner (combat.playerId) when no owner override is provided', () => {
    const friendA = makeUnit('player-1', { class: CombatUnitClass.Paladin, spec: CombatUnitSpec.Paladin_Holy });
    const friendB = makeUnit('player-2', { class: CombatUnitClass.Mage, spec: CombatUnitSpec.Mage_Frost });
    const combat = makeCombatFull(friendA, friendB);
    const friends = [friendA, friendB];
    const enemies = [combat.units['enemy-1']];

    const output = buildMatchContext(combat, friends, enemies);

    expect(output).toContain('Spec: Holy Paladin');
    expect(output).not.toContain('Spec: Frost Mage');
  });

  it('reflects the overridden owner when options.owner is provided, without changing production (no-owner) behavior', () => {
    const friendA = makeUnit('player-1', { class: CombatUnitClass.Paladin, spec: CombatUnitSpec.Paladin_Holy });
    const friendB = makeUnit('player-2', { class: CombatUnitClass.Mage, spec: CombatUnitSpec.Mage_Frost });
    const combat = makeCombatFull(friendA, friendB);
    const friends = [friendA, friendB];
    const enemies = [combat.units['enemy-1']];

    const defaultOutput = buildMatchContext(combat, friends, enemies);
    const overriddenOutput = buildMatchContext(combat, friends, enemies, { owner: friendB });

    expect(overriddenOutput).toContain('Spec: Frost Mage');
    expect(overriddenOutput).not.toContain('Spec: Holy Paladin');
    // The default (no override) path must be unaffected by the override's existence.
    expect(defaultOutput).toContain('Spec: Holy Paladin');
  });
});

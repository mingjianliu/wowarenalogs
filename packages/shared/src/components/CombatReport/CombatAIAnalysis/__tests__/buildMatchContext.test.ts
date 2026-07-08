import { AtomicArenaCombat, CombatUnitClass, CombatUnitReaction, CombatUnitSpec } from '@wowarenalogs/parser';

import { makeAdvancedAction, makeUnit } from '../../../../utils/__tests__/testHelpers';
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

describe('buildMatchContext — healer_offense block renders in BOTH prompt paths', () => {
  const T0 = 1_000_000;
  const T_END = 1_120_000; // 2 min

  /** advancedActions giving a unit full HP for the whole match (samples every 5s). */
  function fullHpActions(): unknown[] {
    const actions: unknown[] = [];
    for (let s = 0; s <= 120; s += 5) actions.push(makeAdvancedAction(T0 + s * 1000, 0, 0, 500_000, 500_000));
    return actions;
  }

  function makeCombatWithAdvanced() {
    const healerOwner = makeUnit('player-1', {
      class: CombatUnitClass.Paladin,
      spec: CombatUnitSpec.Paladin_Holy,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      advancedActions: fullHpActions() as any[],
    });
    const mate = makeUnit('player-2', {
      class: CombatUnitClass.Mage,
      spec: CombatUnitSpec.Mage_Frost,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      advancedActions: fullHpActions() as any[],
    });
    const enemy = makeUnit('enemy-1', {
      reaction: CombatUnitReaction.Hostile,
      class: CombatUnitClass.Warrior,
      spec: CombatUnitSpec.Warrior_Arms,
    });
    const combat = {
      startTime: T0,
      endTime: T_END,
      playerId: healerOwner.id,
      playerTeamId: 'team-1',
      units: { [healerOwner.id]: healerOwner, [mate.id]: mate, [enemy.id]: enemy },
      startInfo: { bracket: '2v2', zoneId: 0 },
    } as unknown as AtomicArenaCombat;
    return { combat, friends: [healerOwner, mate], enemies: [enemy] };
  }

  it('renders <healer_offense> in the timeline path (harness) — regression for the 2026-07-07 A/B where both arms were byte-identical', () => {
    const { combat, friends, enemies } = makeCombatWithAdvanced();
    const output = buildMatchContext(combat, friends, enemies, { useTimelinePrompt: true });
    expect(output).toContain('<healer_offense>');
    expect(output).toContain('</healer_offense>');
    expect(output).toContain('HEALER OFFENSE');
  });

  it('renders <healer_offense> in the critical-moments path (prod)', () => {
    const { combat, friends, enemies } = makeCombatWithAdvanced();
    const output = buildMatchContext(combat, friends, enemies);
    expect(output).toContain('<healer_offense>');
  });

  it('omits the block entirely when advanced logging is absent', () => {
    const healerOwner = makeUnit('player-1', { class: CombatUnitClass.Paladin, spec: CombatUnitSpec.Paladin_Holy });
    const enemy = makeUnit('enemy-1', {
      reaction: CombatUnitReaction.Hostile,
      class: CombatUnitClass.Warrior,
      spec: CombatUnitSpec.Warrior_Arms,
    });
    const combat = {
      startTime: T0,
      endTime: T_END,
      playerId: healerOwner.id,
      playerTeamId: 'team-1',
      units: { [healerOwner.id]: healerOwner, [enemy.id]: enemy },
      startInfo: { bracket: '2v2', zoneId: 0 },
    } as unknown as AtomicArenaCombat;
    const output = buildMatchContext(combat, [healerOwner], [enemy], { useTimelinePrompt: true });
    expect(output).not.toContain('<healer_offense>');
  });
});

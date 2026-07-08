import { AtomicArenaCombat, CombatUnitClass, CombatUnitReaction, CombatUnitSpec } from '@wowarenalogs/parser';

import { makeAdvancedAction, makeSpellCastEvent, makeUnit } from '../../../../utils/__tests__/testHelpers';
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

describe('buildMatchContext — arena map name', () => {
  const T0 = 1_000_000;
  const T_END = 1_120_000; // 2 min

  function makeCombatWithZone(zoneId: string | number) {
    const friendA = makeUnit('player-1', { class: CombatUnitClass.Paladin, spec: CombatUnitSpec.Paladin_Holy });
    const enemy = makeUnit('enemy-1', {
      reaction: CombatUnitReaction.Hostile,
      class: CombatUnitClass.Warrior,
      spec: CombatUnitSpec.Warrior_Arms,
    });
    const combat = {
      startTime: T0,
      endTime: T_END,
      playerId: friendA.id,
      playerTeamId: 'team-1',
      units: { [friendA.id]: friendA, [enemy.id]: enemy },
      startInfo: { bracket: '2v2', zoneId },
    } as unknown as AtomicArenaCombat;
    return { combat, friends: [friendA], enemies: [enemy] };
  }

  it('includes the arena name in the critical-moments path header when the zone is known', () => {
    const { combat, friends, enemies } = makeCombatWithZone('1505');
    const output = buildMatchContext(combat, friends, enemies);
    expect(output).toContain('Map: Nagrand Arena');
  });

  it('includes the arena name in the timeline path header when the zone is known', () => {
    const { combat, friends, enemies } = makeCombatWithZone('1505');
    const output = buildMatchContext(combat, friends, enemies, { useTimelinePrompt: true });
    expect(output).toContain('Map: Nagrand Arena');
  });

  it('resolves numeric zone ids against zoneMetadata string keys', () => {
    const { combat, friends, enemies } = makeCombatWithZone(1505);
    const output = buildMatchContext(combat, friends, enemies);
    expect(output).toContain('Map: Nagrand Arena');
  });

  it('omits the Map field entirely for unknown zones', () => {
    const { combat, friends, enemies } = makeCombatWithZone('999999');
    const output = buildMatchContext(combat, friends, enemies);
    expect(output).not.toContain('Map:');
  });
});

describe('buildMatchContext — healer exposure in both prompt paths', () => {
  const T0 = 1_000_000;
  const T_END = 1_120_000; // 2 min

  /** Dense (5s-interval) static position track — position analysis rejects
   *  interpolation across long snapshot gaps as fabricated. */
  function denseTrack(x: number, y: number) {
    const actions = [];
    for (let t = 5_000; t <= 115_000; t += 5_000) actions.push(makeAdvancedAction(T0 + t, x, y));
    return actions;
  }

  function makeExposureScenario() {
    // Healer owner at (0,0) with position data covering the burst window
    const healer = makeUnit('h1', {
      name: 'Healer',
      class: CombatUnitClass.Priest,
      spec: CombatUnitSpec.Priest_Holy,
      advancedActions: denseTrack(0, 0),
    });
    healer.advancedActions.forEach((a) => ((a as unknown as Record<string, unknown>).advancedActorId = 'h1'));

    // Two enemies popping offensive CDs within the same window → aligned burst
    const e1 = makeUnit('e1', {
      name: 'EnemyPala',
      reaction: CombatUnitReaction.Hostile,
      class: CombatUnitClass.Paladin,
      spec: CombatUnitSpec.Paladin_Retribution,
      spellCastEvents: [makeSpellCastEvent('31884', T0 + 10_000, 'e1', 'Self', 'e1', 'EnemyPala', 0, 'Avenging Wrath')],
      advancedActions: denseTrack(10, 0),
    });
    e1.advancedActions.forEach((a) => ((a as unknown as Record<string, unknown>).advancedActorId = 'e1'));
    const e2 = makeUnit('e2', {
      name: 'EnemyMage',
      reaction: CombatUnitReaction.Hostile,
      class: CombatUnitClass.Mage,
      spec: CombatUnitSpec.Mage_Fire,
      spellCastEvents: [makeSpellCastEvent('190319', T0 + 12_000, 'e2', 'Self', 'e2', 'EnemyMage', 0, 'Combustion')],
      advancedActions: denseTrack(12, 0),
    });
    e2.advancedActions.forEach((a) => ((a as unknown as Record<string, unknown>).advancedActorId = 'e2'));

    const combat = {
      startTime: T0,
      endTime: T_END,
      playerId: healer.id,
      playerTeamId: 'team-1',
      units: { [healer.id]: healer, [e1.id]: e1, [e2.id]: e2 },
      startInfo: { bracket: '3v3', zoneId: '1505' },
      hasAdvancedLogging: true,
    } as unknown as AtomicArenaCombat;

    return { combat, friends: [healer], enemies: [e1, e2] };
  }

  it('critical-moments path includes the healer exposure section (existing behavior)', () => {
    const { combat, friends, enemies } = makeExposureScenario();
    const output = buildMatchContext(combat, friends, enemies);
    expect(output).toContain('HEALER EXPOSURE DURING ENEMY BURST WINDOWS');
  });

  it('timeline path includes the same healer exposure section', () => {
    const { combat, friends, enemies } = makeExposureScenario();
    const output = buildMatchContext(combat, friends, enemies, { useTimelinePrompt: true });
    expect(output).toContain('HEALER EXPOSURE DURING ENEMY BURST WINDOWS');
  });

  it('critical-moments path includes the POSITIONING section when position events exist', () => {
    // Healer sits at 10yd from an enemy through the whole burst window → STAYED_IN
    const { combat, friends, enemies } = makeExposureScenario();
    const output = buildMatchContext(combat, friends, enemies);
    expect(output).toContain('POSITIONING');
    expect(output).toContain('STAYED IN');
  });

  it('timeline path includes the POSITIONING section when position events exist', () => {
    const { combat, friends, enemies } = makeExposureScenario();
    const output = buildMatchContext(combat, friends, enemies, { useTimelinePrompt: true });
    expect(output).toContain('POSITIONING');
    expect(output).toContain('STAYED IN');
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

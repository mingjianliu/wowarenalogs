/* eslint-disable @typescript-eslint/no-explicit-any */
import { CombatUnitClass, CombatUnitSpec } from '@wowarenalogs/parser';

import { computeOwnerPositionEvents, formatPositionEventsForContext, IPositionEvent } from '../positionAnalysis';
import { makeAdvancedAction, makeUnit } from './testHelpers';

const T0 = 1_000_000;

function makeCombat(durationMs = 120_000) {
  return { startTime: T0, endTime: T0 + durationMs } as any;
}

/** Unit with a static position held across the whole match, snapshotted densely
 *  (every 5s) the way an in-combat unit would be. */
function makeStaticUnit(id: string, x: number, y: number, overrides: any = {}) {
  const actions = [];
  for (let t = 0; t <= 120_000; t += 5_000) actions.push(makeAdvancedAction(T0 + t, x, y));
  const unit = makeUnit(id, {
    advancedActions: actions,
    ...overrides,
  });
  unit.advancedActions.forEach((a) => ((a as any).advancedActorId = id));
  return unit;
}

function makeBurstWindow(
  fromSeconds: number,
  toSeconds: number,
  dangerLabel = 'High',
  mostPressuredTargetName?: string,
): any {
  return {
    fromSeconds,
    toSeconds,
    activeCDs: [{ playerName: 'Enemy', spellName: 'Avenging Wrath', spellId: '31884' }],
    threatScore: 5,
    threatLabel: dangerLabel,
    dangerScore: 5,
    dangerLabel,
    dampeningPct: 0,
    damageInWindow: 500_000,
    damageRatio: 1,
    mostPressuredTarget: mostPressuredTargetName
      ? { unitName: mostPressuredTargetName, startHpPct: 100, midHpPct: 60, endHpPct: 40 }
      : undefined,
  };
}

describe('computeOwnerPositionEvents — burst-window engagement', () => {
  it('emits STAYED_IN when the owner stays in melee range through an enemy burst window', () => {
    const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Priest_Holy, class: CombatUnitClass.Priest });
    const enemy = makeStaticUnit('e1', 5, 0, { spec: CombatUnitSpec.Warrior_Arms });

    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [enemy] as any,
      combat: makeCombat(),
      burstWindows: [makeBurstWindow(10, 20)],
      ownerCooldowns: [],
      isHealer: true,
      ownerIsMelee: false,
    });

    const stayedIn = events.filter((e) => e.type === 'STAYED_IN');
    expect(stayedIn).toHaveLength(1);
    expect(stayedIn[0].atSeconds).toBe(10);
    expect(stayedIn[0].startDistanceYards).toBeCloseTo(5, 0);
  });

  it('emits KITED when the owner opens ≥10yd of distance during the burst window', () => {
    const owner = makeUnit('o1', {
      spec: CombatUnitSpec.Priest_Holy,
      class: CombatUnitClass.Priest,
      advancedActions: [
        makeAdvancedAction(T0, 0, 0),
        makeAdvancedAction(T0 + 10_000, 0, 0), // at window start: 5yd from enemy
        makeAdvancedAction(T0 + 20_000, -25, 0), // by window end: 30yd away
        makeAdvancedAction(T0 + 120_000, -25, 0),
      ],
    });
    owner.advancedActions.forEach((a) => ((a as any).advancedActorId = 'o1'));
    const enemy = makeStaticUnit('e1', 5, 0, { spec: CombatUnitSpec.Warrior_Arms });

    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [enemy] as any,
      combat: makeCombat(),
      burstWindows: [makeBurstWindow(10, 20)],
      ownerCooldowns: [],
      isHealer: true,
      ownerIsMelee: false,
    });

    const kited = events.filter((e) => e.type === 'KITED');
    expect(kited).toHaveLength(1);
    expect(kited[0].endDistanceYards).toBeGreaterThan(kited[0].startDistanceYards as number);
    expect(events.filter((e) => e.type === 'STAYED_IN')).toHaveLength(0);
  });

  it('skips the window when the owner was CC-locked for most of it (cannot kite)', () => {
    const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Priest_Holy, class: CombatUnitClass.Priest });
    const enemy = makeStaticUnit('e1', 5, 0, { spec: CombatUnitSpec.Warrior_Arms });

    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [enemy] as any,
      combat: makeCombat(),
      burstWindows: [makeBurstWindow(10, 20)],
      ownerCooldowns: [],
      ownerCCSummary: { ccInstances: [{ atSeconds: 10, durationSeconds: 8 }] } as any,
      isHealer: true,
      ownerIsMelee: false,
    });

    expect(events).toHaveLength(0);
  });

  it('annotates STAYED_IN with defensive availability when defensive CDs are tracked', () => {
    const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Priest_Holy, class: CombatUnitClass.Priest });
    const enemy = makeStaticUnit('e1', 5, 0, { spec: CombatUnitSpec.Warrior_Arms });

    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [enemy] as any,
      combat: makeCombat(),
      burstWindows: [makeBurstWindow(10, 20)],
      ownerCooldowns: [
        {
          spellName: 'Desperate Prayer',
          tag: 'Defensive',
          availableWindows: [{ fromSeconds: 0, toSeconds: 60, durationSeconds: 60 }],
          casts: [],
          neverUsed: false,
        } as any,
      ],
      isHealer: true,
      ownerIsMelee: false,
    });

    expect(events[0].type).toBe('STAYED_IN');
    expect(events[0].ownerDefensiveAvailable).toBe(true);
  });
});

describe('computeOwnerPositionEvents — missed push', () => {
  const offensiveCD = {
    spellName: 'Avatar',
    tag: 'Offensive',
    availableWindows: [{ fromSeconds: 20, toSeconds: 80, durationSeconds: 60 }],
    casts: [],
    neverUsed: false,
  } as any;

  it('emits MISSED_PUSH for a melee DPS parked >20yd from all enemies with offensive CDs available', () => {
    const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Warrior_Arms, class: CombatUnitClass.Warrior });
    const enemy = makeStaticUnit('e1', 30, 0, { spec: CombatUnitSpec.Mage_Fire });

    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [enemy] as any,
      combat: makeCombat(),
      burstWindows: [],
      ownerCooldowns: [offensiveCD],
      isHealer: false,
      ownerIsMelee: true,
    });

    const missed = events.filter((e) => e.type === 'MISSED_PUSH');
    expect(missed.length).toBeGreaterThanOrEqual(1);
    expect(missed[0].atSeconds).toBeGreaterThanOrEqual(20);
  });

  it('does not emit MISSED_PUSH for a ranged DPS at 30yd (normal ranged position)', () => {
    const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Mage_Fire, class: CombatUnitClass.Mage });
    const enemy = makeStaticUnit('e1', 30, 0, { spec: CombatUnitSpec.Warrior_Arms });

    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [enemy] as any,
      combat: makeCombat(),
      burstWindows: [],
      ownerCooldowns: [offensiveCD],
      isHealer: false,
      ownerIsMelee: false,
    });

    expect(events.filter((e) => e.type === 'MISSED_PUSH')).toHaveLength(0);
  });

  it('never emits MISSED_PUSH for healers', () => {
    const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Priest_Holy, class: CombatUnitClass.Priest });
    const enemy = makeStaticUnit('e1', 40, 0, { spec: CombatUnitSpec.Warrior_Arms });

    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [enemy] as any,
      combat: makeCombat(),
      burstWindows: [],
      ownerCooldowns: [offensiveCD],
      isHealer: true,
      ownerIsMelee: false,
    });

    expect(events.filter((e) => e.type === 'MISSED_PUSH')).toHaveLength(0);
  });
});

describe('computeOwnerPositionEvents — offensive CD range validation', () => {
  it('emits CD_OUT_OF_RANGE when a major offensive CD is cast >15yd from every enemy and stays out of range', () => {
    const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Warrior_Arms, class: CombatUnitClass.Warrior });
    const enemy = makeStaticUnit('e1', 25, 0, { spec: CombatUnitSpec.Mage_Fire });

    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [enemy] as any,
      combat: makeCombat(),
      burstWindows: [],
      ownerCooldowns: [
        {
          spellName: 'Avatar',
          tag: 'Offensive',
          availableWindows: [],
          casts: [{ timeSeconds: 30 }],
          neverUsed: false,
        } as any,
      ],
      isHealer: false,
      ownerIsMelee: true,
    });

    const outOfRange = events.filter((e) => e.type === 'CD_OUT_OF_RANGE');
    expect(outOfRange).toHaveLength(1);
    expect(outOfRange[0].spellName).toBe('Avatar');
    expect(outOfRange[0].atSeconds).toBe(30);
  });

  it('does not flag an offensive CD cast in range', () => {
    const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Warrior_Arms, class: CombatUnitClass.Warrior });
    const enemy = makeStaticUnit('e1', 5, 0, { spec: CombatUnitSpec.Mage_Fire });

    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [enemy] as any,
      combat: makeCombat(),
      burstWindows: [],
      ownerCooldowns: [
        {
          spellName: 'Avatar',
          tag: 'Offensive',
          availableWindows: [],
          casts: [{ timeSeconds: 30 }],
          neverUsed: false,
        } as any,
      ],
      isHealer: false,
      ownerIsMelee: true,
    });

    expect(events.filter((e) => e.type === 'CD_OUT_OF_RANGE')).toHaveLength(0);
  });
});

describe('computeOwnerPositionEvents — review fixes (agy 2026-07-07)', () => {
  it('ignores dead enemies — no STAYED_IN against a corpse', () => {
    const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Priest_Holy, class: CombatUnitClass.Priest });
    // Enemy died at 5s right next to the owner; corpse position freezes at (5,0)
    const deadEnemy = makeStaticUnit('e1', 5, 0, { spec: CombatUnitSpec.Warrior_Arms });
    (deadEnemy as any).deathRecords = [{ timestamp: T0 + 5_000 }];
    // The only living enemy bursts from far away — owner is correctly disengaged
    const aliveEnemy = makeStaticUnit('e2', 40, 0, { spec: CombatUnitSpec.Mage_Fire });

    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [deadEnemy, aliveEnemy] as any,
      combat: makeCombat(),
      burstWindows: [makeBurstWindow(10, 20)],
      ownerCooldowns: [],
      isHealer: true,
      ownerIsMelee: false,
    });

    expect(events.filter((e) => e.type === 'STAYED_IN')).toHaveLength(0);
  });

  it('does not flag MISSED_PUSH for a ranged DPS at 42yd (within kiting/max-range play)', () => {
    const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Mage_Fire, class: CombatUnitClass.Mage });
    const enemy = makeStaticUnit('e1', 42, 0, { spec: CombatUnitSpec.Warrior_Arms });

    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [enemy] as any,
      combat: makeCombat(),
      burstWindows: [],
      ownerCooldowns: [
        {
          spellName: 'Combustion',
          tag: 'Offensive',
          availableWindows: [{ fromSeconds: 0, toSeconds: 120, durationSeconds: 120 }],
          casts: [],
          neverUsed: false,
        } as any,
      ],
      isHealer: false,
      ownerIsMelee: false,
    });

    expect(events.filter((e) => e.type === 'MISSED_PUSH')).toHaveLength(0);
  });

  it('detects hit-and-run kiting via per-second sampling (out to 40yd mid-window, back at the end)', () => {
    const owner = makeUnit('o1', {
      spec: CombatUnitSpec.Priest_Holy,
      class: CombatUnitClass.Priest,
      advancedActions: [
        makeAdvancedAction(T0, 0, 0),
        makeAdvancedAction(T0 + 10_000, 0, 0), // window start: 5yd
        makeAdvancedAction(T0 + 14_000, -35, 0), // mid-window: 40yd away
        makeAdvancedAction(T0 + 19_000, -35, 0), // held distance through the burst
        makeAdvancedAction(T0 + 20_000, 0, 0), // re-engaged at window end
        makeAdvancedAction(T0 + 120_000, 0, 0),
      ],
    });
    owner.advancedActions.forEach((a) => ((a as any).advancedActorId = 'o1'));
    const enemy = makeStaticUnit('e1', 5, 0, { spec: CombatUnitSpec.Warrior_Arms });

    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [enemy] as any,
      combat: makeCombat(),
      burstWindows: [makeBurstWindow(10, 20)],
      ownerCooldowns: [],
      isHealer: true,
      ownerIsMelee: false,
    });

    expect(events.filter((e) => e.type === 'STAYED_IN')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'KITED')).toHaveLength(1);
  });

  it('merges overlapping CC intervals instead of summing them', () => {
    const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Priest_Holy, class: CombatUnitClass.Priest });
    const enemy = makeStaticUnit('e1', 5, 0, { spec: CombatUnitSpec.Warrior_Arms });

    // Simultaneous 3s stun + 3s silence = 3s of real CC lockout, not 6s.
    // 3s < half of the 10s window → the window must still be evaluated.
    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [enemy] as any,
      combat: makeCombat(),
      burstWindows: [makeBurstWindow(10, 20)],
      ownerCooldowns: [],
      ownerCCSummary: {
        ccInstances: [
          { atSeconds: 10, durationSeconds: 3 },
          { atSeconds: 10, durationSeconds: 3 },
        ],
      } as any,
      isHealer: true,
      ownerIsMelee: false,
    });

    expect(events.filter((e) => e.type === 'STAYED_IN')).toHaveLength(1);
  });
});

describe('computeOwnerPositionEvents — sparse position data (gap-aware)', () => {
  it('skips burst-window evaluation when the owner has a long snapshot gap over the window', () => {
    // Owner idle: only two snapshots 60s apart — interpolated positions are fabricated
    const owner = makeUnit('o1', {
      spec: CombatUnitSpec.Priest_Holy,
      class: CombatUnitClass.Priest,
      advancedActions: [makeAdvancedAction(T0, 0, 0), makeAdvancedAction(T0 + 60_000, 0, 0)],
    });
    owner.advancedActions.forEach((a) => ((a as any).advancedActorId = 'o1'));
    const enemy = makeStaticUnit('e1', 5, 0, { spec: CombatUnitSpec.Warrior_Arms });

    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [enemy] as any,
      combat: makeCombat(),
      burstWindows: [makeBurstWindow(10, 20)],
      ownerCooldowns: [],
      isHealer: true,
      ownerIsMelee: false,
    });

    expect(events).toHaveLength(0);
  });

  it('does not emit MISSED_PUSH from interpolated positions across a long enemy snapshot gap', () => {
    const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Warrior_Arms, class: CombatUnitClass.Warrior });
    // Enemy has only two snapshots 120s apart — everything between is fabricated
    const enemy = makeUnit('e1', {
      spec: CombatUnitSpec.Mage_Fire,
      advancedActions: [makeAdvancedAction(T0, 30, 0), makeAdvancedAction(T0 + 120_000, 30, 0)],
    });
    enemy.advancedActions.forEach((a) => ((a as any).advancedActorId = 'e1'));

    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [enemy] as any,
      combat: makeCombat(),
      burstWindows: [],
      ownerCooldowns: [
        {
          spellName: 'Avatar',
          tag: 'Offensive',
          availableWindows: [{ fromSeconds: 20, toSeconds: 80, durationSeconds: 60 }],
          casts: [],
          neverUsed: false,
        } as any,
      ],
      isHealer: false,
      ownerIsMelee: true,
    });

    expect(events.filter((e) => e.type === 'MISSED_PUSH')).toHaveLength(0);
  });

  it('does not emit MISSED_PUSH while any living enemy position is unknown (stealthed enemy could be anywhere)', () => {
    const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Warrior_Arms, class: CombatUnitClass.Warrior });
    const farEnemy = makeStaticUnit('e1', 30, 0, { spec: CombatUnitSpec.Mage_Fire });
    // Stealthed rogue: alive but zero position snapshots
    const stealthedEnemy = makeUnit('e2', { spec: CombatUnitSpec.Rogue_Subtlety, advancedActions: [] });

    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [farEnemy, stealthedEnemy] as any,
      combat: makeCombat(),
      burstWindows: [],
      ownerCooldowns: [
        {
          spellName: 'Avatar',
          tag: 'Offensive',
          availableWindows: [{ fromSeconds: 20, toSeconds: 80, durationSeconds: 60 }],
          casts: [],
          neverUsed: false,
        } as any,
      ],
      isHealer: false,
      ownerIsMelee: true,
    });

    expect(events.filter((e) => e.type === 'MISSED_PUSH')).toHaveLength(0);
  });
});

describe('computeOwnerPositionEvents — STAYED_IN burst-target semantics', () => {
  const stayedInParams = (owner: any, enemy: any, targetName?: string, opts: any = {}) => ({
    owner,
    enemies: [enemy],
    combat: makeCombat(),
    burstWindows: [makeBurstWindow(10, 20, 'High', targetName)],
    ownerCooldowns: [],
    isHealer: false,
    ownerIsMelee: true,
    ...opts,
  });

  it('suppresses STAYED_IN for a melee DPS when the burst targets a teammate (staying in is normal offense)', () => {
    const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Warrior_Arms, class: CombatUnitClass.Warrior });
    const enemy = makeStaticUnit('e1', 5, 0, { spec: CombatUnitSpec.Mage_Fire });

    const events = computeOwnerPositionEvents(stayedInParams(owner, enemy, 'Teammate') as any);

    expect(events.filter((e) => e.type === 'STAYED_IN')).toHaveLength(0);
  });

  it('emits STAYED_IN with burstTargetsOwner=true when the melee owner is the burst target', () => {
    const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Warrior_Arms, class: CombatUnitClass.Warrior });
    const enemy = makeStaticUnit('e1', 5, 0, { spec: CombatUnitSpec.Mage_Fire });

    const events = computeOwnerPositionEvents(stayedInParams(owner, enemy, 'o1') as any);

    const stayedIn = events.filter((e) => e.type === 'STAYED_IN');
    expect(stayedIn).toHaveLength(1);
    expect(stayedIn[0].burstTargetsOwner).toBe(true);
  });

  it('keeps STAYED_IN for a healer even when the burst targets a teammate, annotated with the target', () => {
    const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Priest_Holy, class: CombatUnitClass.Priest });
    const enemy = makeStaticUnit('e1', 5, 0, { spec: CombatUnitSpec.Warrior_Arms });

    const events = computeOwnerPositionEvents(
      stayedInParams(owner, enemy, 'Teammate', { isHealer: true, ownerIsMelee: false }) as any,
    );

    const stayedIn = events.filter((e) => e.type === 'STAYED_IN');
    expect(stayedIn).toHaveLength(1);
    expect(stayedIn[0].burstTargetsOwner).toBe(false);
    expect(stayedIn[0].burstTargetName).toBe('Teammate');
  });
});

describe('computeOwnerPositionEvents — missing data', () => {
  it('returns no events when the owner has no advanced position data', () => {
    const owner = makeUnit('o1', { advancedActions: [], spec: CombatUnitSpec.Priest_Holy });
    const enemy = makeStaticUnit('e1', 5, 0, { spec: CombatUnitSpec.Warrior_Arms });

    const events = computeOwnerPositionEvents({
      owner: owner as any,
      enemies: [enemy] as any,
      combat: makeCombat(),
      burstWindows: [makeBurstWindow(10, 20)],
      ownerCooldowns: [],
      isHealer: true,
      ownerIsMelee: false,
    });

    expect(events).toHaveLength(0);
  });
});

describe('formatPositionEventsForContext', () => {
  it('returns empty for no events', () => {
    expect(formatPositionEventsForContext([])).toEqual([]);
  });

  it('renders each event type under its own heading', () => {
    const events: IPositionEvent[] = [
      {
        type: 'STAYED_IN',
        atSeconds: 105,
        toSeconds: 115,
        startDistanceYards: 4,
        endDistanceYards: 6,
        nearestEnemyName: 'EnemyWarrior',
        dangerLabel: 'Critical',
        ownerDefensiveAvailable: false,
        burstTargetsOwner: true,
      },
      {
        type: 'STAYED_IN',
        atSeconds: 130,
        toSeconds: 140,
        startDistanceYards: 7,
        endDistanceYards: 7,
        nearestEnemyName: 'EnemyWarrior',
        dangerLabel: 'High',
        burstTargetsOwner: false,
        burstTargetName: 'FriendlyMage',
      },
      {
        type: 'KITED',
        atSeconds: 190,
        toSeconds: 200,
        startDistanceYards: 6,
        endDistanceYards: 28,
        nearestEnemyName: 'EnemyWarrior',
        dangerLabel: 'High',
      },
      {
        type: 'MISSED_PUSH',
        atSeconds: 150,
        toSeconds: 165,
        startDistanceYards: 35,
      },
      {
        type: 'CD_OUT_OF_RANGE',
        atSeconds: 75,
        startDistanceYards: 22,
        spellName: 'Avatar',
      },
    ];

    const text = formatPositionEventsForContext(events).join('\n');

    expect(text).toContain('POSITIONING');
    expect(text).toContain('STAYED IN');
    expect(text).toContain('1:45');
    expect(text).toContain('you were the burst target');
    expect(text).toContain('burst targeted FriendlyMage');
    expect(text).toContain('KITED');
    expect(text).toContain('6→28yd');
    expect(text).toContain('MISSED PUSH');
    expect(text).toContain('OFFENSIVE CD OUT OF RANGE');
    expect(text).toContain('Avatar');
  });
});

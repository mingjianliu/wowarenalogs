# Healer Offense Analysis (V1, slack-gated) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic "healer offensive contribution" analysis (slack detection, kill-window CC/damage contribution, purge/kill-window alignment, window-creation opportunities) that emits fact lines into the AI match context, gated so offensive findings only fire at zero defensive cost.

**Architecture:** One new util `packages/shared/src/utils/healerOffenseAnalysis.ts` consumes existing analysis outputs (`IOffensiveWindow[]`, `IEnemyCDTimeline`, `ICCInstance[]`) and emits `IHealerOffenseSummary` + a `<healer_offense>` context block. One field is added to `dispelAnalysis.ts` (`IMissedPurgeWindow.duringKillWindow`). `buildMatchContext.ts` wires it behind a feature flag. Both system prompts gain a short slack-gated rubric section.

**Tech Stack:** TypeScript, tsdx/jest tests (`packages/shared`), existing parser types from `@wowarenalogs/parser`.

**Spec:** `docs/superpowers/specs/2026-07-07-healer-offense-analysis-design.md`

## Global Constraints

- Work in worktree `.worktrees/offense-analysis` (branch `offense-analysis`). All paths below are relative to the worktree root.
- Facts, not verdicts: no output line may assert the player erred; lines carry state + what happened only.
- If any friendly unit has `advancedActions.length === 0`, the entire summary is disabled (`advancedLoggingAvailable: false`, all arrays empty). No degraded guessing.
- Slack thresholds (from spec, verbatim): team HP ≥ 85; min segment 4s; idle-priority segment ≥ 6s; mobility exclusion 3s; max 2 window-creation facts per match.
- No parser (`packages/parser`) changes. No new hardcoded spell lists — use `spells.json` types (`cc`, `interrupts`, `buffs_speed_boost`) and `spellEffectData` cooldowns.
- Run tests with `npx tsdx test <pattern>` from `packages/shared/` (see project memory: ts-jest compile errors can silently disable suites — always confirm the suite ran).
- Commit after every task; pre-commit hook runs lint+typecheck workspace-wide.

---

### Task 1: Slack segment detection

**Files:**

- Create: `packages/shared/src/utils/healerOffenseAnalysis.ts`
- Create: `packages/shared/src/utils/__tests__/healerOffenseAnalysis.test.ts`

**Interfaces:**

- Consumes: `IEnemyCDTimeline` (`./enemyCDs`), `getHpPercentAtTime(unit, atSeconds, matchStartMs): number | null` (`./killWindowTargetSelection`), `ccSpellIds: Set<string>` (`../data/spellTags`), `spells.json` types.
- Produces (used by Tasks 2–4):
  - `ISlackSegment { fromSeconds, toSeconds, durationSeconds, ownerDamage, ownerCCCasts, ownerPurgeCasts, ownerKickCasts, idle }`
  - `computeSlackSegments(combat, owner, friends, enemies, enemyCDTimeline, ownerCCInstances, ownerPurgeTimesSeconds): { advancedLoggingAvailable: boolean; segments: ISlackSegment[] }`
  - Constants `SLACK_TEAM_HP_THRESHOLD = 85`, `MIN_SLACK_SECONDS = 4`, `IDLE_PRIORITY_SECONDS = 6`, `MOBILITY_EXCLUSION_SECONDS = 3`, `MAX_WINDOW_CREATION_FACTS = 2`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/utils/__tests__/healerOffenseAnalysis.test.ts
import { CombatUnitReaction, ICombatUnit, LogEvent } from '@wowarenalogs/parser';

import { IEnemyCDTimeline } from '../enemyCDs';
import { computeSlackSegments } from '../healerOffenseAnalysis';
import { makeAdvancedAction, makeAuraEvent, makeSpellCastEvent, makeUnit } from './testHelpers';

const T0 = 1_000_000; // match start ms

/** advancedActions giving a unit full HP for the whole match (samples every 5s for 120s). */
function fullHpActions(): unknown[] {
  const actions: unknown[] = [];
  for (let s = 0; s <= 120; s += 5) actions.push(makeAdvancedAction(T0 + s * 1000, 0, 0, 500_000, 500_000));
  return actions;
}

function makeFriend(id: string, overrides: Parameters<typeof makeUnit>[1] = {}): ICombatUnit {
  return makeUnit(id, { reaction: CombatUnitReaction.Friendly, advancedActions: fullHpActions(), ...overrides });
}

function emptyEnemyTimeline(): IEnemyCDTimeline {
  return { players: [], alignedBurstWindows: [] };
}

const combat = { startTime: T0, endTime: T0 + 120_000 };

describe('computeSlackSegments', () => {
  it('returns one full-match slack segment when team is topped and nothing is active', () => {
    const owner = makeFriend('owner');
    const { advancedLoggingAvailable, segments } = computeSlackSegments(
      combat,
      owner,
      [owner],
      [makeUnit('enemy-1', { reaction: CombatUnitReaction.Hostile })],
      emptyEnemyTimeline(),
      [],
      [],
    );
    expect(advancedLoggingAvailable).toBe(true);
    expect(segments.length).toBe(1);
    expect(segments[0].fromSeconds).toBe(0);
    expect(segments[0].durationSeconds).toBeGreaterThanOrEqual(115);
    expect(segments[0].idle).toBe(true);
  });

  it('disables entirely when a friendly unit has no advancedActions', () => {
    const owner = makeFriend('owner');
    const mate = makeUnit('mate', { reaction: CombatUnitReaction.Friendly }); // no advancedActions
    const { advancedLoggingAvailable, segments } = computeSlackSegments(
      combat,
      owner,
      [owner, mate],
      [],
      emptyEnemyTimeline(),
      [],
      [],
    );
    expect(advancedLoggingAvailable).toBe(false);
    expect(segments).toEqual([]);
  });

  it('excludes seconds where a friendly is below 85% HP', () => {
    const owner = makeFriend('owner');
    // teammate drops to 60% HP from t=20s to t=40s
    const mateActions: unknown[] = [];
    for (let s = 0; s <= 120; s += 5) {
      const hp = s >= 20 && s < 40 ? 300_000 : 500_000;
      mateActions.push(makeAdvancedAction(T0 + s * 1000, 0, 0, 500_000, hp));
    }
    const mate = makeUnit('mate', { reaction: CombatUnitReaction.Friendly, advancedActions: mateActions });
    const { segments } = computeSlackSegments(combat, owner, [owner, mate], [], emptyEnemyTimeline(), [], []);
    // no segment may overlap [20, 40)
    for (const seg of segments) {
      expect(seg.toSeconds <= 20 || seg.fromSeconds >= 40).toBe(true);
    }
    expect(segments.length).toBeGreaterThanOrEqual(2);
  });

  it('excludes seconds where an enemy offensive CD buff is active', () => {
    const owner = makeFriend('owner');
    const timeline: IEnemyCDTimeline = {
      alignedBurstWindows: [],
      players: [
        {
          playerName: 'Enemy',
          specName: 'Arms',
          offensiveCDs: [
            {
              spellId: '107574',
              spellName: 'Avatar',
              castTimeSeconds: 30,
              cooldownSeconds: 90,
              availableAgainAtSeconds: 120,
              buffEndSeconds: 50,
            },
          ],
        },
      ],
    };
    const { segments } = computeSlackSegments(combat, owner, [owner], [], timeline, [], []);
    for (const seg of segments) {
      expect(seg.toSeconds <= 30 || seg.fromSeconds >= 50).toBe(true);
    }
  });

  it('excludes seconds where the owner is CC-d and 3s after a speed-boost cast', () => {
    const owner = makeFriend('owner', {
      // Sprint-like: spells.json '2983' is type buffs_speed_boost
      spellCastEvents: [makeSpellCastEvent('2983', T0 + 60_000, 'owner', 'Owner', 'owner', 'Owner')],
    });
    const { segments } = computeSlackSegments(
      combat,
      owner,
      [owner],
      [],
      emptyEnemyTimeline(),
      [{ atSeconds: 10, durationSeconds: 6 }], // owner CC'd 10–16s
      [],
    );
    for (const seg of segments) {
      expect(seg.toSeconds <= 10 || seg.fromSeconds >= 16).toBe(true); // CC exclusion
      expect(seg.toSeconds <= 60 || seg.fromSeconds >= 63).toBe(true); // mobility exclusion
    }
  });

  it('drops segments shorter than 4s and fills owner activity counters', () => {
    // slack only in [50, 53) (3s) via HP dips elsewhere → no segment survives
    const mateActions: unknown[] = [];
    for (let s = 0; s <= 120; s += 1) {
      const hp = s >= 50 && s < 53 ? 500_000 : 300_000;
      mateActions.push(makeAdvancedAction(T0 + s * 1000, 0, 0, 500_000, hp));
    }
    const owner = makeFriend('owner');
    const mate = makeUnit('mate', { reaction: CombatUnitReaction.Friendly, advancedActions: mateActions });
    const { segments } = computeSlackSegments(combat, owner, [owner, mate], [], emptyEnemyTimeline(), [], []);
    expect(segments).toEqual([]);
  });

  it('counts owner damage, CC casts, purges and kicks inside a segment (idle=false)', () => {
    const enemy = makeUnit('enemy-1', { reaction: CombatUnitReaction.Hostile });
    const owner = makeFriend('owner', {
      spellCastEvents: [
        makeSpellCastEvent('118', T0 + 20_000, 'enemy-1', 'Enemy', 'owner', 'Owner'), // Polymorph: type cc
        makeSpellCastEvent('57994', T0 + 30_000, 'enemy-1', 'Enemy', 'owner', 'Owner'), // Wind Shear: type interrupts
      ],
    });
    // makeUnit hardcodes damageOut: [] — assign after construction
    (owner as unknown as { damageOut: unknown[] }).damageOut = [
      {
        logLine: { event: LogEvent.SPELL_DAMAGE, timestamp: T0 + 25_000, parameters: [] },
        timestamp: T0 + 25_000,
        effectiveAmount: 50_000,
        amount: 50_000,
        srcUnitId: 'owner',
        destUnitId: 'enemy-1',
      },
    ];
    const { segments } = computeSlackSegments(
      combat,
      owner,
      [owner],
      [enemy],
      emptyEnemyTimeline(),
      [],
      [40], // one purge at t=40s
    );
    expect(segments.length).toBe(1);
    expect(segments[0].ownerDamage).toBe(50_000);
    expect(segments[0].ownerCCCasts).toBe(1);
    expect(segments[0].ownerKickCasts).toBe(1);
    expect(segments[0].ownerPurgeCasts).toBe(1);
    expect(segments[0].idle).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && npx tsdx test healerOffenseAnalysis`
Expected: FAIL — `Cannot find module '../healerOffenseAnalysis'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/utils/healerOffenseAnalysis.ts
import { ICombatUnit, LogEvent } from '@wowarenalogs/parser';

import { ccSpellIds } from '../data/spellTags';
import spellsData from '../data/spells.json';
import { IEnemyCDTimeline } from './enemyCDs';
import { getHpPercentAtTime } from './killWindowTargetSelection';

type SpellEntry = { type: string };
const SPELLS = spellsData as Record<string, SpellEntry>;

/** Local feature flags, mirroring DISPEL_FEATURE_FLAGS pattern. */
export const HEALER_OFFENSE_FLAGS = {
  V1_SLACK_GATED: true,
};

export const SLACK_TEAM_HP_THRESHOLD = 85;
export const MIN_SLACK_SECONDS = 4;
export const IDLE_PRIORITY_SECONDS = 6;
export const MOBILITY_EXCLUSION_SECONDS = 3;
export const MAX_WINDOW_CREATION_FACTS = 2;

export interface ISlackSegment {
  fromSeconds: number;
  toSeconds: number;
  durationSeconds: number;
  /** Effective damage the owner dealt to enemies inside the segment. */
  ownerDamage: number;
  ownerCCCasts: number;
  ownerPurgeCasts: number;
  ownerKickCasts: number;
  /** True when the owner produced zero offensive output of any kind. */
  idle: boolean;
}

type CCInterval = ReadonlyArray<{ atSeconds: number; durationSeconds: number }>;

function isEnemyCDActiveAt(timeline: IEnemyCDTimeline, t: number): boolean {
  return timeline.players.some((p) => p.offensiveCDs.some((cd) => cd.castTimeSeconds <= t && t < cd.buffEndSeconds));
}

function isOwnerCCdAt(ownerCC: CCInterval, t: number): boolean {
  return ownerCC.some((cc) => cc.atSeconds <= t && t < cc.atSeconds + cc.durationSeconds);
}

function ownerMobilityCastTimes(owner: ICombatUnit, matchStartMs: number): number[] {
  return owner.spellCastEvents
    .filter(
      (e) =>
        e.logLine.event === LogEvent.SPELL_CAST_SUCCESS && e.spellId && SPELLS[e.spellId]?.type === 'buffs_speed_boost',
    )
    .map((e) => (e.logLine.timestamp - matchStartMs) / 1000);
}

export function computeSlackSegments(
  combat: { startTime: number; endTime: number },
  owner: ICombatUnit,
  friends: ICombatUnit[],
  enemies: ICombatUnit[],
  enemyCDTimeline: IEnemyCDTimeline,
  ownerCCInstances: CCInterval,
  ownerPurgeTimesSeconds: ReadonlyArray<number>,
): { advancedLoggingAvailable: boolean; segments: ISlackSegment[] } {
  const matchStartMs = combat.startTime;
  const durationSeconds = Math.floor((combat.endTime - combat.startTime) / 1000);

  const advancedLoggingAvailable = friends.every((f) => f.advancedActions.length > 0);
  if (!advancedLoggingAvailable) return { advancedLoggingAvailable: false, segments: [] };

  const mobilityTimes = ownerMobilityCastTimes(owner, matchStartMs);

  const isSlackSecond = (t: number): boolean => {
    for (const f of friends) {
      const hp = getHpPercentAtTime(f, t, matchStartMs);
      if (hp === null || hp < SLACK_TEAM_HP_THRESHOLD) return false;
    }
    if (isEnemyCDActiveAt(enemyCDTimeline, t)) return false;
    if (isOwnerCCdAt(ownerCCInstances, t)) return false;
    if (mobilityTimes.some((m) => t >= m && t < m + MOBILITY_EXCLUSION_SECONDS)) return false;
    return true;
  };

  // 1s-resolution sweep, merge consecutive slack seconds into segments
  const raw: Array<{ fromSeconds: number; toSeconds: number }> = [];
  let segStart: number | null = null;
  for (let t = 0; t <= durationSeconds; t++) {
    if (isSlackSecond(t)) {
      if (segStart === null) segStart = t;
    } else if (segStart !== null) {
      raw.push({ fromSeconds: segStart, toSeconds: t });
      segStart = null;
    }
  }
  if (segStart !== null) raw.push({ fromSeconds: segStart, toSeconds: durationSeconds });

  const enemyIds = new Set(enemies.map((e) => e.id));

  const segments: ISlackSegment[] = raw
    .filter((s) => s.toSeconds - s.fromSeconds >= MIN_SLACK_SECONDS)
    .map((s) => {
      const inSeg = (ms: number) => {
        const t = (ms - matchStartMs) / 1000;
        return t >= s.fromSeconds && t < s.toSeconds;
      };
      const ownerDamage = owner.damageOut
        .filter((d) => inSeg(d.logLine.timestamp) && enemyIds.has(d.destUnitId))
        .reduce((sum, d) => sum + Math.max(0, d.effectiveAmount), 0);
      const casts = owner.spellCastEvents.filter(
        (e) => e.logLine.event === LogEvent.SPELL_CAST_SUCCESS && inSeg(e.logLine.timestamp) && e.spellId,
      );
      const ownerCCCasts = casts.filter((e) => ccSpellIds.has(e.spellId as string)).length;
      const ownerKickCasts = casts.filter((e) => SPELLS[e.spellId as string]?.type === 'interrupts').length;
      const ownerPurgeCasts = ownerPurgeTimesSeconds.filter((t) => t >= s.fromSeconds && t < s.toSeconds).length;

      const idle = ownerDamage === 0 && ownerCCCasts === 0 && ownerKickCasts === 0 && ownerPurgeCasts === 0;
      return {
        fromSeconds: s.fromSeconds,
        toSeconds: s.toSeconds,
        durationSeconds: s.toSeconds - s.fromSeconds,
        ownerDamage,
        ownerCCCasts,
        ownerPurgeCasts,
        ownerKickCasts,
        idle,
      };
    });

  return { advancedLoggingAvailable: true, segments };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/shared && npx tsdx test healerOffenseAnalysis`
Expected: PASS, 6 tests. Confirm the suite actually ran (6 passed, not 0).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/utils/healerOffenseAnalysis.ts packages/shared/src/utils/__tests__/healerOffenseAnalysis.test.ts
git commit -m "feat(shared): healer offense — slack segment detection"
```

---

### Task 2: Kill-window contribution analysis (signal 1)

**Files:**

- Modify: `packages/shared/src/utils/healerOffenseAnalysis.ts`
- Modify: `packages/shared/src/utils/__tests__/healerOffenseAnalysis.test.ts`

**Interfaces:**

- Consumes: `IOffensiveWindow` (`./offensiveWindows`: `{ targetUnitId, targetName, targetSpec, fromSeconds, toSeconds, durationSeconds, friendlyDamageInWindow, damageRatio, capitalized, friendlyOffensives }`), `getDRLevelAtTime(ccInstances, category, atSeconds): DRLevel` + `getDRCategory(spellId)` (`./drAnalysis`), `ICCInstance` (`./ccTrinketAnalysis`: has `atSeconds`, `durationSeconds`, `drInfo`), `spellEffectData` (`../data/spellEffectData`: `cooldownSeconds?`), `isHealerSpec` (`./cooldowns`).
- Produces (used by Task 4):
  - `IWindowContribution { fromSeconds, toSeconds, targetName, targetSpec, enemyHealerName, enemyHealerSpec, ownerCCReady: Array<{ spellName, enemyHealerDR }>, ownerCastCCInWindow, ownerDamageInWindow, ownerFreeSeconds, teamMinHpPct }`
  - `computeWindowContributions(combat, owner, friends, enemies, offensiveWindows, ownerCCInstances, enemyHealerCCInstances): IWindowContribution[]`
  - Internal helpers `collectOwnerCCSpells(owner, matchStartMs)` and `isCCReadyAt(spell, atSeconds)` (also used by Task 3).

- [ ] **Step 1: Write the failing tests** (append to the existing describe file)

```ts
// append to healerOffenseAnalysis.test.ts
import { computeWindowContributions } from '../healerOffenseAnalysis';
import { IOffensiveWindow } from '../offensiveWindows';
import { CombatUnitSpec } from '@wowarenalogs/parser';

function makeWindow(fromSeconds: number, toSeconds: number): IOffensiveWindow {
  return {
    targetUnitId: 'enemy-1',
    targetName: 'Edk',
    targetSpec: 'Frost Death Knight',
    fromSeconds,
    toSeconds,
    durationSeconds: toSeconds - fromSeconds,
    friendlyDamageInWindow: 0,
    damageRatio: 1,
    capitalized: false,
    friendlyOffensives: [],
  };
}

describe('computeWindowContributions', () => {
  const enemyHealer = makeUnit('enemy-h', {
    reaction: CombatUnitReaction.Hostile,
    spec: CombatUnitSpec.Shaman_Restoration,
    name: 'Rsham',
  });
  const enemyDk = makeUnit('enemy-1', { reaction: CombatUnitReaction.Hostile, name: 'Edk' });

  it('reports ready CC with enemy healer DR, no cast, free time and team HP', () => {
    // owner cast Psychic Scream (8122, type cc, 30s CD per spellEffectData) at t=100s → it was ready at t=40s
    const owner = makeFriend('owner', {
      spellCastEvents: [makeSpellCastEvent('8122', T0 + 100_000, 'enemy-h', 'Rsham', 'owner', 'Owner')],
    });
    const result = computeWindowContributions(
      combat,
      owner,
      [owner],
      [enemyDk, enemyHealer],
      [makeWindow(40, 50)],
      [], // owner never CC'd
      [], // enemy healer has no incoming CC history → DR Full
    );
    expect(result.length).toBe(1);
    expect(result[0].enemyHealerName).toBe('Rsham');
    expect(result[0].ownerCCReady).toEqual([{ spellName: '8122', enemyHealerDR: 'Full' }]);
    expect(result[0].ownerCastCCInWindow).toBe(false);
    expect(result[0].ownerFreeSeconds).toBe(10);
    expect(result[0].teamMinHpPct).toBe(100);
  });

  it('flags CC as NOT ready when inside its cooldown, and detects an in-window cast', () => {
    const owner = makeFriend('owner', {
      spellCastEvents: [
        makeSpellCastEvent('8122', T0 + 35_000, 'enemy-h', 'Rsham', 'owner', 'Owner'), // cast at 35s → on CD at 40s
      ],
    });
    const result = computeWindowContributions(
      combat,
      owner,
      [owner],
      [enemyDk, enemyHealer],
      [makeWindow(40, 50)],
      [],
      [],
    );
    expect(result[0].ownerCCReady).toEqual([]); // 8122 on CD (35+30 > 40)
    expect(result[0].ownerCastCCInWindow).toBe(false);

    const result2 = computeWindowContributions(
      combat,
      owner,
      [owner],
      [enemyDk, enemyHealer],
      [makeWindow(30, 40)],
      [],
      [],
    );
    expect(result2[0].ownerCastCCInWindow).toBe(true); // cast at 35s ∈ [30, 40)
  });

  it('subtracts owner CC time from ownerFreeSeconds and reports decayed DR', () => {
    const owner = makeFriend('owner', {
      spellCastEvents: [makeSpellCastEvent('8122', T0 + 100_000, 'enemy-h', 'Rsham', 'owner', 'Owner')],
    });
    const result = computeWindowContributions(
      combat,
      owner,
      [owner],
      [enemyDk, enemyHealer],
      [makeWindow(40, 50)],
      [{ atSeconds: 42, durationSeconds: 4 }], // owner feared 42–46
      // enemy healer feared at t=38 for 6s → same 'fear'-category DR window is still hot at 40
      [{ atSeconds: 38, durationSeconds: 6, drInfo: { category: 'fear', level: 'Full', sequenceIndex: 0 } }],
    );
    expect(result[0].ownerFreeSeconds).toBe(6);
    expect(result[0].ownerCCReady[0].enemyHealerDR).toBe('50%');
  });
});
```

Note on fixture data — verify BOTH before finalizing the tests (one `node -e` check against the real data files):

1. `getDRCategory('8122')` must equal the category string stored in the fixture `drInfo.category`; if it returns e.g. `'disorient'`, use that string in both places. The test must use the real category name, not a guess.
2. `spellEffectData['8122'].cooldownSeconds` must exist and be ≥ 5 (the "on CD" test depends on it; the code treats missing/0 CD as always-ready). If 8122 lacks cooldown data, pick another healer CC spell id that has both a DR category and `cooldownSeconds` in `spellEffectData`, and use it consistently across Tasks 2–4 tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && npx tsdx test healerOffenseAnalysis`
Expected: FAIL — `computeWindowContributions is not a function` (Task 1 tests still pass).

- [ ] **Step 3: Write the implementation** (append to `healerOffenseAnalysis.ts`)

```ts
import { spellEffectData } from '../data/spellEffectData';
import { isHealerSpec } from './cooldowns';
import { DRLevel, getDRCategory, getDRLevelAtTime, IDRInfo } from './drAnalysis';
import { IOffensiveWindow } from './offensiveWindows';

export interface IWindowContribution {
  fromSeconds: number;
  toSeconds: number;
  targetName: string;
  targetSpec: string;
  enemyHealerName: string | null;
  enemyHealerSpec: string | null;
  /** Owner CC spells off cooldown at window start (cast-history replay). Empty when the owner cast no CC all match. */
  ownerCCReady: Array<{ spellName: string; enemyHealerDR: DRLevel | null }>;
  ownerCastCCInWindow: boolean;
  ownerDamageInWindow: number;
  /** Seconds of the window the owner was NOT in CC. */
  ownerFreeSeconds: number;
  /** Lowest friendly HP% during the window; null without advanced logging. */
  teamMinHpPct: number | null;
}

interface IOwnerCCSpell {
  spellId: string;
  spellName: string;
  cooldownSeconds: number;
  castTimesSeconds: number[];
}

/** Owner CC spells observed at least once in cast history (honest availability: never-cast spells are unknowable). */
function collectOwnerCCSpells(owner: ICombatUnit, matchStartMs: number): IOwnerCCSpell[] {
  const bySpell = new Map<string, IOwnerCCSpell>();
  for (const e of owner.spellCastEvents) {
    if (e.logLine.event !== LogEvent.SPELL_CAST_SUCCESS || !e.spellId) continue;
    if (!ccSpellIds.has(e.spellId)) continue;
    const entry = bySpell.get(e.spellId) ?? {
      spellId: e.spellId,
      spellName: e.spellName ?? e.spellId,
      cooldownSeconds: spellEffectData[e.spellId]?.cooldownSeconds ?? 0,
      castTimesSeconds: [],
    };
    entry.castTimesSeconds.push((e.logLine.timestamp - matchStartMs) / 1000);
    bySpell.set(e.spellId, entry);
  }
  return [...bySpell.values()].map((s) => ({ ...s, castTimesSeconds: s.castTimesSeconds.sort((a, b) => a - b) }));
}

function isCCReadyAt(spell: IOwnerCCSpell, atSeconds: number): boolean {
  if (spell.cooldownSeconds <= 0) return true; // spammable CC (no CD data) is always ready
  let lastBefore: number | undefined;
  for (const t of spell.castTimesSeconds) {
    if (t < atSeconds) lastBefore = t;
    else break;
  }
  return lastBefore === undefined || lastBefore + spell.cooldownSeconds <= atSeconds;
}

type CCWithDR = ReadonlyArray<{ atSeconds: number; durationSeconds: number; drInfo: IDRInfo | null }>;

export function computeWindowContributions(
  combat: { startTime: number; endTime: number },
  owner: ICombatUnit,
  friends: ICombatUnit[],
  enemies: ICombatUnit[],
  offensiveWindows: IOffensiveWindow[],
  ownerCCInstances: CCInterval,
  enemyHealerCCInstances: CCWithDR,
): IWindowContribution[] {
  const matchStartMs = combat.startTime;
  const enemyHealer = enemies.find((e) => isHealerSpec(e.spec)) ?? null;
  const ccSpells = collectOwnerCCSpells(owner, matchStartMs);
  const enemyIds = new Set(enemies.map((e) => e.id));

  return offensiveWindows.map((w) => {
    const ownerCCReady = ccSpells
      .filter((s) => isCCReadyAt(s, w.fromSeconds))
      .map((s) => ({
        spellName: s.spellName,
        enemyHealerDR: enemyHealer
          ? getDRLevelAtTime(enemyHealerCCInstances, getDRCategory(s.spellId), w.fromSeconds)
          : null,
      }));

    const ownerCastCCInWindow = owner.spellCastEvents.some((e) => {
      if (e.logLine.event !== LogEvent.SPELL_CAST_SUCCESS || !e.spellId || !ccSpellIds.has(e.spellId)) return false;
      const t = (e.logLine.timestamp - matchStartMs) / 1000;
      return t >= w.fromSeconds && t < w.toSeconds;
    });

    const ownerDamageInWindow = owner.damageOut
      .filter((d) => {
        const t = (d.logLine.timestamp - matchStartMs) / 1000;
        return t >= w.fromSeconds && t < w.toSeconds && enemyIds.has(d.destUnitId);
      })
      .reduce((sum, d) => sum + Math.max(0, d.effectiveAmount), 0);

    let ccdSeconds = 0;
    for (const cc of ownerCCInstances) {
      const from = Math.max(w.fromSeconds, cc.atSeconds);
      const to = Math.min(w.toSeconds, cc.atSeconds + cc.durationSeconds);
      if (to > from) ccdSeconds += to - from;
    }
    const ownerFreeSeconds = Math.max(0, w.durationSeconds - ccdSeconds);

    let teamMinHpPct: number | null = null;
    for (const f of friends) {
      for (let t = Math.ceil(w.fromSeconds); t <= Math.floor(w.toSeconds); t++) {
        const hp = getHpPercentAtTime(f, t, matchStartMs);
        if (hp !== null && (teamMinHpPct === null || hp < teamMinHpPct)) teamMinHpPct = hp;
      }
    }

    return {
      fromSeconds: w.fromSeconds,
      toSeconds: w.toSeconds,
      targetName: w.targetName,
      targetSpec: w.targetSpec,
      enemyHealerName: enemyHealer?.name ?? null,
      enemyHealerSpec: enemyHealer ? String(enemyHealer.spec) : null,
      ownerCCReady,
      ownerCastCCInWindow,
      ownerDamageInWindow,
      ownerFreeSeconds,
      teamMinHpPct,
    };
  });
}
```

Note: `makeSpellCastEvent` fixtures set `spellName` = spellId by default, which is why the test asserts `spellName: '8122'`. Production events carry real names.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/shared && npx tsdx test healerOffenseAnalysis`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/utils/healerOffenseAnalysis.ts packages/shared/src/utils/__tests__/healerOffenseAnalysis.test.ts
git commit -m "feat(shared): healer offense — kill-window CC/damage contribution"
```

---

### Task 3: Window-creation opportunities (signal 4)

**Files:**

- Modify: `packages/shared/src/utils/killWindowTargetSelection.ts:205` (add `export` to `getTrinketStateAtTime`)
- Modify: `packages/shared/src/utils/healerOffenseAnalysis.ts`
- Modify: `packages/shared/src/utils/__tests__/healerOffenseAnalysis.test.ts`

**Interfaces:**

- Consumes: `getTrinketStateAtTime(enemy, windowStartSeconds, matchStartMs, isHealer): boolean | null` (newly exported; existing behavior unchanged), `ISlackSegment` (Task 1), `collectOwnerCCSpells`/`isCCReadyAt` (Task 2), `IOffensiveWindow`.
- Produces (used by Task 4):
  - `IWindowCreationFact { atSeconds, slackDurationSeconds, ccSpellName, enemyHealerName, enemyHealerSpec, enemyHealerDRLevel: 'Full', enemyHealerTrinketOnCD: boolean | null }`
  - `computeWindowCreationFacts(combat, owner, enemies, slackSegments, offensiveWindows, enemyHealerCCInstances): IWindowCreationFact[]` — capped at `MAX_WINDOW_CREATION_FACTS`, longest slack first.

- [ ] **Step 1: Export the trinket helper**

In `killWindowTargetSelection.ts`, change `function getTrinketStateAtTime(` to `export function getTrinketStateAtTime(`. No other edits.

- [ ] **Step 2: Write the failing tests** (append)

```ts
import { computeWindowCreationFacts, ISlackSegment } from '../healerOffenseAnalysis';

function slackSeg(fromSeconds: number, toSeconds: number): ISlackSegment {
  return {
    fromSeconds,
    toSeconds,
    durationSeconds: toSeconds - fromSeconds,
    ownerDamage: 0,
    ownerCCCasts: 0,
    ownerPurgeCasts: 0,
    ownerKickCasts: 0,
    idle: true,
  };
}

describe('computeWindowCreationFacts', () => {
  const enemyHealerWithTrinketDown = makeUnit('enemy-h', {
    reaction: CombatUnitReaction.Hostile,
    spec: CombatUnitSpec.Shaman_Restoration,
    name: 'Rsham',
    // trinket (336126) used at t=10s; healer trinket CD 90s → on CD until 100s
    spellCastEvents: [makeSpellCastEvent('336126', T0 + 10_000, 'enemy-h', 'Rsham', 'enemy-h', 'Rsham')],
  });

  it('emits a fact when CC ready + enemy healer DR Full + trinket on CD + no kill window overlapping', () => {
    const owner = makeFriend('owner', {
      spellCastEvents: [makeSpellCastEvent('8122', T0 + 100_000, 'enemy-h', 'Rsham', 'owner', 'Owner')],
    });
    const facts = computeWindowCreationFacts(combat, owner, [enemyHealerWithTrinketDown], [slackSeg(40, 50)], [], []);
    expect(facts.length).toBe(1);
    expect(facts[0].atSeconds).toBe(40);
    expect(facts[0].ccSpellName).toBe('8122');
    expect(facts[0].enemyHealerDRLevel).toBe('Full');
    expect(facts[0].enemyHealerTrinketOnCD).toBe(true);
  });

  it('suppresses facts during an active kill window, at decayed DR, and caps at 2 by slack length', () => {
    const owner = makeFriend('owner', {
      spellCastEvents: [makeSpellCastEvent('8122', T0 + 115_000, 'enemy-h', 'Rsham', 'owner', 'Owner')],
    });
    // overlapping kill window suppresses the 40–50 segment
    const suppressed = computeWindowCreationFacts(
      combat,
      owner,
      [enemyHealerWithTrinketDown],
      [slackSeg(40, 50)],
      [makeWindow(45, 55)],
      [],
    );
    expect(suppressed).toEqual([]);

    // decayed DR suppresses (verify getDRCategory('8122') and reuse the real category string)
    const decayed = computeWindowCreationFacts(
      combat,
      owner,
      [enemyHealerWithTrinketDown],
      [slackSeg(40, 50)],
      [],
      [{ atSeconds: 38, durationSeconds: 6, drInfo: { category: 'fear', level: 'Full', sequenceIndex: 0 } }],
    );
    expect(decayed).toEqual([]);

    // 3 candidate segments → capped at 2, longest first
    const capped = computeWindowCreationFacts(
      combat,
      owner,
      [enemyHealerWithTrinketDown],
      [slackSeg(20, 25), slackSeg(40, 52), slackSeg(60, 68)],
      [],
      [],
    );
    expect(capped.length).toBe(2);
    expect(capped[0].atSeconds).toBe(40); // 12s slack
    expect(capped[1].atSeconds).toBe(60); // 8s slack
  });

  it('returns [] when there is no enemy healer or the owner has no observed CC', () => {
    const owner = makeFriend('owner');
    expect(computeWindowCreationFacts(combat, owner, [enemyHealerWithTrinketDown], [slackSeg(40, 50)], [], [])).toEqual(
      [],
    );
    const ownerWithCC = makeFriend('owner', {
      spellCastEvents: [makeSpellCastEvent('8122', T0 + 100_000, 'x', 'X', 'owner', 'Owner')],
    });
    expect(
      computeWindowCreationFacts(
        combat,
        ownerWithCC,
        [makeUnit('enemy-1', { reaction: CombatUnitReaction.Hostile })],
        [slackSeg(40, 50)],
        [],
        [],
      ),
    ).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/shared && npx tsdx test healerOffenseAnalysis`
Expected: FAIL — `computeWindowCreationFacts is not a function`.

- [ ] **Step 4: Write the implementation** (append)

```ts
import { getHpPercentAtTime, getTrinketStateAtTime } from './killWindowTargetSelection'; // merge into existing import

export interface IWindowCreationFact {
  atSeconds: number;
  slackDurationSeconds: number;
  ccSpellName: string;
  enemyHealerName: string;
  enemyHealerSpec: string;
  /** Always 'Full' by construction — facts are only emitted at full DR. */
  enemyHealerDRLevel: DRLevel;
  /** true = trinket known on CD; null = trinket never observed (state unknown). */
  enemyHealerTrinketOnCD: boolean | null;
}

export function computeWindowCreationFacts(
  combat: { startTime: number; endTime: number },
  owner: ICombatUnit,
  enemies: ICombatUnit[],
  slackSegments: ISlackSegment[],
  offensiveWindows: IOffensiveWindow[],
  enemyHealerCCInstances: CCWithDR,
): IWindowCreationFact[] {
  const matchStartMs = combat.startTime;
  const enemyHealer = enemies.find((e) => isHealerSpec(e.spec));
  if (!enemyHealer) return [];
  const ccSpells = collectOwnerCCSpells(owner, matchStartMs);
  if (ccSpells.length === 0) return [];

  const overlapsKillWindow = (seg: ISlackSegment) =>
    offensiveWindows.some((w) => w.fromSeconds < seg.toSeconds && seg.fromSeconds < w.toSeconds);

  const facts: IWindowCreationFact[] = [];
  for (const seg of slackSegments) {
    if (overlapsKillWindow(seg)) continue;

    const readyAtFullDR = ccSpells.find(
      (s) =>
        isCCReadyAt(s, seg.fromSeconds) &&
        getDRLevelAtTime(enemyHealerCCInstances, getDRCategory(s.spellId), seg.fromSeconds) === 'Full',
    );
    if (!readyAtFullDR) continue;

    const trinketAvailable = getTrinketStateAtTime(enemyHealer, seg.fromSeconds, matchStartMs, true);
    // trinketAvailable === true → healer can break the opener; not a clean opportunity
    if (trinketAvailable === true) continue;

    facts.push({
      atSeconds: seg.fromSeconds,
      slackDurationSeconds: seg.durationSeconds,
      ccSpellName: readyAtFullDR.spellName,
      enemyHealerName: enemyHealer.name,
      enemyHealerSpec: String(enemyHealer.spec),
      enemyHealerDRLevel: 'Full',
      enemyHealerTrinketOnCD: trinketAvailable === null ? null : true,
    });
  }

  return facts.sort((a, b) => b.slackDurationSeconds - a.slackDurationSeconds).slice(0, MAX_WINDOW_CREATION_FACTS);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/shared && npx tsdx test healerOffenseAnalysis`
Expected: PASS, 12 tests.
Also run: `npx tsdx test killWindowTargetSelection` — Expected: PASS (export change is behavior-neutral).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/utils/healerOffenseAnalysis.ts packages/shared/src/utils/__tests__/healerOffenseAnalysis.test.ts packages/shared/src/utils/killWindowTargetSelection.ts
git commit -m "feat(shared): healer offense — window-creation opportunity facts"
```

---

### Task 4: Summary entry point + context formatter

**Files:**

- Modify: `packages/shared/src/utils/healerOffenseAnalysis.ts`
- Modify: `packages/shared/src/utils/__tests__/healerOffenseAnalysis.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 1–3; `fmtTime(seconds): string` (`./cooldowns`); `IEnemyCDTimeline`; `ICCInstance` (`./ccTrinketAnalysis`).
- Produces (used by Task 6):
  - `IHealerOffenseSummary { advancedLoggingAvailable, slackSegments, windowContributions, windowCreationFacts }`
  - `buildHealerOffenseSummary(combat, owner, friends, enemies, offensiveWindows, enemyCDTimeline, ownerCCInstances, enemyHealerCCInstances, ownerPurgeTimesSeconds): IHealerOffenseSummary`
  - `formatHealerOffenseForContext(summary): string[]` — empty array when disabled or nothing to report.

- [ ] **Step 1: Write the failing tests** (append)

```ts
import { buildHealerOffenseSummary, formatHealerOffenseForContext } from '../healerOffenseAnalysis';

describe('buildHealerOffenseSummary + formatHealerOffenseForContext', () => {
  it('returns an empty format block when advanced logging is missing', () => {
    const owner = makeUnit('owner', { reaction: CombatUnitReaction.Friendly }); // no advancedActions
    const summary = buildHealerOffenseSummary(combat, owner, [owner], [], [], emptyEnemyTimeline(), [], [], []);
    expect(summary.advancedLoggingAvailable).toBe(false);
    expect(formatHealerOffenseForContext(summary)).toEqual([]);
  });

  it('renders header, aggregate slack line, idle segments, window and opportunity lines', () => {
    const enemyHealer = makeUnit('enemy-h', {
      reaction: CombatUnitReaction.Hostile,
      spec: CombatUnitSpec.Shaman_Restoration,
      name: 'Rsham',
      spellCastEvents: [makeSpellCastEvent('336126', T0 + 10_000, 'enemy-h', 'Rsham', 'enemy-h', 'Rsham')],
    });
    const owner = makeFriend('owner', {
      spellCastEvents: [makeSpellCastEvent('8122', T0 + 115_000, 'enemy-h', 'Rsham', 'owner', 'Owner')],
    });
    const summary = buildHealerOffenseSummary(
      combat,
      owner,
      [owner],
      [enemyHealer],
      [makeWindow(40, 50)],
      emptyEnemyTimeline(),
      [],
      [],
      [],
    );
    const lines = formatHealerOffenseForContext(summary);
    const text = lines.join('\n');
    expect(text).toContain('HEALER OFFENSE');
    expect(text).toContain('slack');
    expect(text).toContain('[KILL WINDOW]');
    expect(text).toContain('you cast no CC');
    expect(text).toContain('[OPPORTUNITY]');
    expect(text).toContain('opportunity, not a verdict');
    expect(text).toContain('facts, not conclusions');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && npx tsdx test healerOffenseAnalysis`
Expected: FAIL — `buildHealerOffenseSummary is not a function`.

- [ ] **Step 3: Write the implementation** (append)

```ts
import { fmtTime } from './cooldowns'; // merge into existing ./cooldowns import

export interface IHealerOffenseSummary {
  advancedLoggingAvailable: boolean;
  slackSegments: ISlackSegment[];
  windowContributions: IWindowContribution[];
  windowCreationFacts: IWindowCreationFact[];
}

export function buildHealerOffenseSummary(
  combat: { startTime: number; endTime: number },
  owner: ICombatUnit,
  friends: ICombatUnit[],
  enemies: ICombatUnit[],
  offensiveWindows: IOffensiveWindow[],
  enemyCDTimeline: IEnemyCDTimeline,
  ownerCCInstances: CCInterval,
  enemyHealerCCInstances: CCWithDR,
  ownerPurgeTimesSeconds: ReadonlyArray<number>,
): IHealerOffenseSummary {
  const { advancedLoggingAvailable, segments } = computeSlackSegments(
    combat,
    owner,
    friends,
    enemies,
    enemyCDTimeline,
    ownerCCInstances,
    ownerPurgeTimesSeconds,
  );
  if (!advancedLoggingAvailable) {
    return { advancedLoggingAvailable: false, slackSegments: [], windowContributions: [], windowCreationFacts: [] };
  }
  return {
    advancedLoggingAvailable: true,
    slackSegments: segments,
    windowContributions: computeWindowContributions(
      combat,
      owner,
      friends,
      enemies,
      offensiveWindows,
      ownerCCInstances,
      enemyHealerCCInstances,
    ),
    windowCreationFacts: computeWindowCreationFacts(
      combat,
      owner,
      enemies,
      segments,
      offensiveWindows,
      enemyHealerCCInstances,
    ),
  };
}

export function formatHealerOffenseForContext(summary: IHealerOffenseSummary): string[] {
  if (!summary.advancedLoggingAvailable) return [];
  const { slackSegments, windowContributions, windowCreationFacts } = summary;
  if (slackSegments.length === 0 && windowContributions.length === 0 && windowCreationFacts.length === 0) return [];

  const lines: string[] = [];
  lines.push('HEALER OFFENSE (slack-gated facts — team ≥85% HP, no enemy offensive CDs active, you un-CC-d):');

  const totalSlack = slackSegments.reduce((s, seg) => s + seg.durationSeconds, 0);
  const idleSegs = slackSegments.filter((s) => s.idle && s.durationSeconds >= IDLE_PRIORITY_SECONDS);
  const idleSlack = slackSegments.filter((s) => s.idle).reduce((s, seg) => s + seg.durationSeconds, 0);
  if (slackSegments.length > 0) {
    lines.push(
      `  Slack time: ${totalSlack}s across ${slackSegments.length} segment(s); ${idleSlack}s with zero offensive output.`,
    );
    for (const seg of idleSegs) {
      lines.push(
        `  [SLACK] ${fmtTime(seg.fromSeconds)}–${fmtTime(seg.toSeconds)} (${seg.durationSeconds}s): no damage, no CC, no purge, no kick.`,
      );
    }
  }

  for (const w of windowContributions) {
    const ready =
      w.ownerCCReady.length > 0
        ? `your CC ready: ${w.ownerCCReady
            .map((c) => `${c.spellName}${c.enemyHealerDR ? ` (enemy healer DR: ${c.enemyHealerDR})` : ''}`)
            .join(', ')}`
        : 'no owner CC observed this match';
    const cast = w.ownerCastCCInWindow ? 'you cast CC in this window' : 'you cast no CC';
    const dmg = `your damage ${(w.ownerDamageInWindow / 1000).toFixed(0)}k`;
    const free = `free ${Math.round(w.ownerFreeSeconds)}s of ${Math.round(w.toSeconds - w.fromSeconds)}s`;
    const teamHp = w.teamMinHpPct !== null ? `, team min HP ${Math.round(w.teamMinHpPct)}%` : '';
    lines.push(
      `  [KILL WINDOW] ${fmtTime(w.fromSeconds)}–${fmtTime(w.toSeconds)} on ${w.targetSpec} (${w.targetName}): ${ready}; ${cast}; ${dmg}; ${free}${teamHp}.`,
    );
  }

  for (const f of windowCreationFacts) {
    const trinket = f.enemyHealerTrinketOnCD === true ? 'trinket on CD' : 'trinket state unknown (never observed)';
    lines.push(
      `  [OPPORTUNITY] ${fmtTime(f.atSeconds)} (slack ${f.slackDurationSeconds}s): ${f.ccSpellName} ready; enemy healer ${f.enemyHealerName} DR Full, ${trinket} (opportunity, not a verdict).`,
    );
  }

  lines.push(
    '  Note: these lines are facts, not conclusions — cross-check the timeline (drinking, kiting, repositioning are valid uses of slack); healing under pressure always outranks offense.',
  );
  return lines;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/shared && npx tsdx test healerOffenseAnalysis`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/utils/healerOffenseAnalysis.ts packages/shared/src/utils/__tests__/healerOffenseAnalysis.test.ts
git commit -m "feat(shared): healer offense — summary entry point + context formatter"
```

---

### Task 5: Purge / kill-window alignment (signal 3)

**Files:**

- Modify: `packages/shared/src/utils/dispelAnalysis.ts` (interface at :421, formatter at :1052)
- Modify: `packages/shared/src/utils/__tests__/dispelAnalysis.test.ts`

**Interfaces:**

- Consumes: `IMissedPurgeWindow` (existing fields incl. `timeSeconds`, `priority`), `IOffensiveWindow`.
- Produces (used by Task 6):
  - `IMissedPurgeWindow.duringKillWindow?: boolean` (optional for back-compat with existing fixtures)
  - `annotateMissedPurgesWithKillWindows(missedPurgeWindows: IMissedPurgeWindow[], offensiveWindows: Array<{ fromSeconds: number; toSeconds: number }>): void` (in-place annotation)
  - `formatDispelContextForAI` escalation: a missed purge with `duringKillWindow === true` is always listed (regardless of priority) with suffix `— DURING FRIENDLY KILL WINDOW`.

- [ ] **Step 1: Write the failing tests** (append to `dispelAnalysis.test.ts`, matching its existing fixture style — read the file's existing `IMissedPurgeWindow` fixtures first and reuse their shape)

```ts
import { annotateMissedPurgesWithKillWindows, formatDispelContextForAI, IMissedPurgeWindow } from '../dispelAnalysis';

function makeMissedPurge(timeSeconds: number, priority: 'Critical' | 'High' | 'Medium' | 'Low'): IMissedPurgeWindow {
  return {
    timeSeconds,
    durationSeconds: 8,
    enemyName: 'Rsham',
    enemySpec: 'Restoration Shaman',
    spellName: 'Earth Shield',
    spellId: '974',
    priority,
    purgeWasOnCD: false,
    teamUnderPressure: false,
  };
}

describe('annotateMissedPurgesWithKillWindows', () => {
  it('flags misses inside a kill window and leaves others untouched', () => {
    const misses = [makeMissedPurge(45, 'Medium'), makeMissedPurge(80, 'Medium')];
    annotateMissedPurgesWithKillWindows(misses, [{ fromSeconds: 40, toSeconds: 50 }]);
    expect(misses[0].duringKillWindow).toBe(true);
    expect(misses[1].duringKillWindow).toBe(false);
  });

  it('escalates in-window misses in the formatter even at Medium priority', () => {
    const misses = [makeMissedPurge(45, 'Medium')];
    annotateMissedPurgesWithKillWindows(misses, [{ fromSeconds: 40, toSeconds: 50 }]);
    const summary = {
      allyCleanse: [],
      ourPurges: [],
      hostilePurges: [],
      missedCleanseWindows: [],
      ccEfficiency: [],
      missedPurgeWindows: misses,
    };
    const text = formatDispelContextForAI(summary as never).join('\n');
    expect(text).toContain('DURING FRIENDLY KILL WINDOW');
    expect(text).toContain('Earth Shield');
  });
});
```

(If `IDispelSummary` requires more fields than shown, build the fixture with the real full shape — check the interface at `dispelAnalysis.ts:443` while implementing.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && npx tsdx test dispelAnalysis`
Expected: FAIL — `annotateMissedPurgesWithKillWindows is not a function`. All existing dispelAnalysis tests still PASS.

- [ ] **Step 3: Implement**

In `IMissedPurgeWindow` (dispelAnalysis.ts:421), add:

```ts
  /** True when the missed purge fell inside a friendly kill window (offensiveWindows intersection).
   *  Optional: only set when annotateMissedPurgesWithKillWindows has run. */
  duringKillWindow?: boolean;
```

New exported function (place directly after the `IMissedPurgeWindow` interface):

```ts
/** Marks missed purges that fell inside a friendly kill window. Mutates in place;
 *  kept separate from reconstructDispelSummary so its signature (and all call sites) stay unchanged. */
export function annotateMissedPurgesWithKillWindows(
  missedPurgeWindows: IMissedPurgeWindow[],
  offensiveWindows: Array<{ fromSeconds: number; toSeconds: number }>,
): void {
  for (const miss of missedPurgeWindows) {
    miss.duringKillWindow = offensiveWindows.some(
      (w) => miss.timeSeconds >= w.fromSeconds && miss.timeSeconds < w.toSeconds,
    );
  }
}
```

In `formatDispelContextForAI` (around :1095), change the significance filter and line rendering:

```ts
// before:
const significantMissedPurges = missedPurgeWindows.filter((w) => w.priority === 'Critical' || w.priority === 'High');
// after:
const significantMissedPurges = missedPurgeWindows.filter(
  (w) => w.priority === 'Critical' || w.priority === 'High' || w.duringKillWindow === true,
);
```

and where each missed-purge line is rendered (find the `lines.push` inside the loop over `significantMissedPurges`), append the marker:

```ts
const killWindowSuffix = w.duringKillWindow === true ? ' — DURING FRIENDLY KILL WINDOW' : '';
// append `${killWindowSuffix}` to the end of the existing template string
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/shared && npx tsdx test dispelAnalysis`
Expected: PASS — the 2 new tests plus every pre-existing test (this file is calibrated; zero regressions allowed).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/utils/dispelAnalysis.ts packages/shared/src/utils/__tests__/dispelAnalysis.test.ts
git commit -m "feat(shared): missed purges flag duringKillWindow + formatter escalation"
```

---

### Task 6: Wire into buildMatchContext behind flag

**Files:**

- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/buildMatchContext.ts`

**Interfaces:**

- Consumes: `buildHealerOffenseSummary`, `formatHealerOffenseForContext`, `HEALER_OFFENSE_FLAGS` (Task 4); `annotateMissedPurgesWithKillWindows` (Task 5); locals already computed in buildMatchContext: `offensiveWindows` (:130), `dispelSummary` (:132), `ccTrinketSummaries` (:133), `enemyCDTimeline` (:119), `healer` (owner-is-healer boolean, used at :637/:644).
- Produces: `<healer_offense>` block in the context string (healer owners only), missed-purge escalation active.

- [ ] **Step 1: Add imports and computation**

Imports (alongside the existing `../../../utils/*` imports):

```ts
import { annotateMissedPurgesWithKillWindows } from '../../../utils/dispelAnalysis'; // merge into existing dispelAnalysis import if present
import {
  buildHealerOffenseSummary,
  formatHealerOffenseForContext,
  HEALER_OFFENSE_FLAGS,
} from '../../../utils/healerOffenseAnalysis';
```

Right after `const offensiveWaste = buildOffensiveWasteSummary(...)` (:155), add:

```ts
// Signal 3: escalate missed purges that fell inside a friendly kill window
annotateMissedPurgesWithKillWindows(dispelSummary.missedPurgeWindows, offensiveWindows);

// Healer offense V1 (slack-gated facts) — healer log owners only
const ownerCCSummary = ccTrinketSummaries.find((s) => s.playerName === owner.name);
const enemyHealerUnit = enemies.find((e) => isHealerSpec(e.spec));
const enemyHealerCCSummary = enemyHealerUnit
  ? analyzePlayerCCAndTrinket(enemyHealerUnit as ICombatUnit, friends as ICombatUnit[], combat)
  : undefined;
const ownerPurgeTimes = dispelSummary.ourPurges.filter((p) => p.sourceName === owner.name).map((p) => p.timeSeconds);
const healerOffense =
  healer && HEALER_OFFENSE_FLAGS.V1_SLACK_GATED
    ? buildHealerOffenseSummary(
        combat,
        owner,
        friends as ICombatUnit[],
        enemies as ICombatUnit[],
        offensiveWindows,
        enemyCDTimeline,
        ownerCCSummary?.ccInstances ?? [],
        enemyHealerCCSummary?.ccInstances ?? [],
        ownerPurgeTimes,
      )
    : null;
```

Notes for the implementer:

- `isHealerSpec` and `analyzePlayerCCAndTrinket` are already imported in this file (they are used at :134 and :133); if the import list differs, extend it.
- `annotateMissedPurgesWithKillWindows` must run BEFORE `formatDispelContextForAI(dispelSummary)` is called in the render section (:634) — placing it in the compute section guarantees that.
- The `healer` boolean already exists in this scope (used at :637 and :644); do not redeclare it.

- [ ] **Step 2: Render the block**

After the `offensiveWasteBlock` push (:692–696), add:

```ts
if (healerOffense) {
  const healerOffenseLines = formatHealerOffenseForContext(healerOffense);
  if (healerOffenseLines.length > 0) {
    lines.push('');
    lines.push('<healer_offense>');
    healerOffenseLines.forEach((l) => lines.push(l));
    lines.push('</healer_offense>');
  }
}
```

- [ ] **Step 3: Verify**

Run: `cd packages/shared && npx tsdx test` (full shared suite)
Expected: all suites PASS; compare the suite count against the last run on main (suite-count health guard exists in CI — commit `9c60e51a`) to confirm no suite silently dropped.
Run: `cd packages/shared && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/buildMatchContext.ts
git commit -m "feat(shared): wire healer offense block into match context behind flag"
```

---

### Task 7: System prompt rubric (both paths)

**Files:**

- Modify: `packages/shared/src/prompts/analyzeSystemPrompts.ts`

**Interfaces:**

- Consumes: `<healer_offense>` block semantics (Task 4 formatter).
- Produces: identical rubric section added to `FINDINGS_JSON_SYSTEM_PROMPT` (prod path) and `NEW_SYSTEM_PROMPT` (harness/timeline path). The two prompts are divergent — port the section to each separately; do not refactor them to share text in this task.

- [ ] **Step 1: Add the rubric section**

Add this section verbatim to BOTH prompts. In `FINDINGS_JSON_SYSTEM_PROMPT`, place it directly after the purge-responsibility bullet (:137 area); in `NEW_SYSTEM_PROMPT`, place it after the corresponding purge bullet (:79 area):

```
**Healer offense (slack-gated, free-value analysis).** The match context may include a <healer_offense> block: deterministic facts about offensive contribution — slack segments (team ≥85% HP, no enemy offensive CD active, player un-CC'd), the player's CC/damage/purge/kick output inside friendly kill windows, and up to two window-creation opportunities (opener CC ready + enemy healer at full DR + enemy healer trinket down). Rules:
- An offensive finding is valid ONLY at zero defensive cost: the slack conditions or an already-open kill window must confirm the player was free. NEVER fault the player for healing, moving, or holding CDs while any teammate was in danger.
- These lines are facts, not verdicts. Cross-check the timeline before concluding a slack segment was wasted — drinking, kiting, repositioning, and pre-positioning for an incoming swap are valid uses of slack the block cannot see.
- Frame valid findings as free value left on the table (an uncast CC on a full-DR enemy healer during your team's kill window; a long idle slack segment; a missed purge marked DURING FRIENDLY KILL WINDOW), not as trades against healing. Trade-off evaluation (heal vs CC at equal urgency) is out of scope — do not produce it.
- A missed window-creation OPPORTUNITY line is the weakest class of evidence: treat it as a question to investigate, not a finding by default.
```

- [ ] **Step 2: Verify prompts still compile and tests pass**

Run: `cd packages/shared && npx tsc --noEmit && npx tsdx test analyzeSystemPrompts` (if no such suite exists, run the full `npx tsdx test`)
Expected: clean typecheck; tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/prompts/analyzeSystemPrompts.ts
git commit -m "feat(prompts): slack-gated healer offense rubric in both prompt paths"
```

---

### Task 8: Full verification + follow-up notes

**Files:**

- Modify: `AI_UTILS.md` (add one table row)

- [ ] **Step 1: Full test suite + typecheck**

Run from worktree root: `cd packages/shared && npx tsdx test 2>&1 | tail -20 && npx tsc --noEmit`
Expected: all suites PASS, suite count ≥ the count on main + 1 (new healerOffenseAnalysis suite); typecheck clean.

- [ ] **Step 2: Document the new util**

Add to the `AI_UTILS.md` feature table:

```markdown
| `healerOffenseAnalysis.ts` | F-offense-V1 | Slack-gated healer offensive contribution: slack segments (team ≥85% HP, no enemy CDs, owner free), per-kill-window CC/damage/purge/kick facts with enemy-healer DR state, ≤2 window-creation opportunity facts per match. Disabled entirely without advanced logging. Facts only — LLM draws conclusions. |
```

- [ ] **Step 3: Commit**

```bash
git add AI_UTILS.md
git commit -m "docs: healer offense analysis util in AI_UTILS.md"
```

- [ ] **Step 4: Report follow-ups (do not execute here)**

Tell the user these remain as separate, user-triggered steps:

1. `regression-gate` (annotation regression) — requires local healer-eval corpus.
2. `improve-healer-prompts` A/B (control = flag off / treatment = flag on + rubric): acceptance = defensive scores don't regress, offensive findings verifiable by claimChecker. Record in `docs/eval-ledger.md`.
3. `git push-clean` + worktree cleanup when accepted.

# F195 Healer Exposure & Positioning Cross-Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cross-reference and align healer positioning events (`STAYED_IN`, `KITED`) with their concurrent `HEALER EXPOSURE` labels during enemy burst windows, preventing the AI coach from generating redundant findings from unlinked angles.

**Architecture:** 
1. Import `HealerExposureLabel` and `IHealerBurstExposure` into `positionAnalysis.ts`.
2. Accept `healerExposures` as an optional parameter in `computeOwnerPositionEvents` parameter interface.
3. Query and store `healerExposureLabel` on the generated positioning events.
4. Format the exposure label directly into `STAYED_IN` and `KITED` positioning timelines.
5. Pass `healerExposures` from `buildMatchContext.ts` into `computeOwnerPositionEvents`.

**Tech Stack:** TypeScript, Jest (TSDX)

---

### Task 1: Update Interfaces and Types in `positionAnalysis.ts`

**Files:**
- Modify: `packages/shared/src/utils/positionAnalysis.ts`

- [ ] **Step 1: Add imports for Healer CC Exposure types**
  Add the following imports at the top of `packages/shared/src/utils/positionAnalysis.ts`:
  ```typescript
  import { HealerExposureLabel, IHealerBurstExposure } from './healerExposureAnalysis';
  ```

- [ ] **Step 2: Add `healerExposureLabel` field to `IPositionEvent`**
  Add `healerExposureLabel?: HealerExposureLabel;` to the `IPositionEvent` interface:
  ```typescript
  export interface IPositionEvent {
    type: PositionEventType;
    atSeconds: number;
    /** Window end for window-scoped events (STAYED_IN / KITED / MISSED_PUSH) */
    toSeconds?: number;
    startDistanceYards?: number;
    endDistanceYards?: number;
    nearestEnemyName?: string;
    /** Burst window threat label for STAYED_IN / KITED */
    dangerLabel?: string;
    /** Dampening during the window (0–1), for the "staying in may be correct" nuance */
    dampeningPct?: number;
    /** STAYED_IN only: whether a defensive CD was off cooldown at window start.
     *  undefined when no defensive CDs are tracked for this spec. */
    ownerDefensiveAvailable?: boolean;
    /** STAYED_IN / KITED: whether the burst's most-pressured target was the owner.
     *  undefined when the window has no pressure-target attribution. */
    burstTargetsOwner?: boolean;
    /** STAYED_IN / KITED: name of the burst's most-pressured target when it isn't the owner */
    burstTargetName?: string;
    /** STAYED_IN only: owner HP% at window start / minimum across the window — the
     *  OUTCOME that turns "stayed in" from a hedge into a fact (near-death vs no cost). */
    ownerHpStartPct?: number | null;
    ownerHpMinPct?: number | null;
    /** HEALER_TRAINED only: healer was hard-CC'd for most of the camp → could not
     *  self-reposition (team must peel), so don't advise "reposition". */
    ownerCcLocked?: boolean;
    /** CD_OUT_OF_RANGE only */
    spellName?: string;
    /** SPLIT_PUSH: melee DPS away from the push target; HEALER_TRAINED: the healer */
    playersInvolved?: string[];
    /** HEALER_TRAINED: true when the trained healer IS the log owner */
    ownerIsSubject?: boolean;
    /** Optional: Healer exposure status during the burst window (owner is healer only) */
    healerExposureLabel?: HealerExposureLabel;
  }
  ```

- [ ] **Step 3: Add `healerExposures` to `computeOwnerPositionEvents` parameter interface**
  Add the optional `healerExposures` parameter:
  ```typescript
  export function computeOwnerPositionEvents(params: {
    owner: ICombatUnit;
    enemies: ICombatUnit[];
    combat: Pick<AtomicArenaCombat, 'startTime' | 'endTime'>;
    burstWindows: IAlignedBurstWindow[];
    ownerCooldowns: IMajorCooldownInfo[];
    ownerCCSummary?: { ccInstances: Array<Pick<ICCInstance, 'atSeconds' | 'durationSeconds'>> };
    isHealer: boolean;
    ownerIsMelee: boolean;
    friends?: ICombatUnit[];
    offensiveWindows?: Array<{
      fromSeconds: number;
      toSeconds: number;
      targetUnitId: string;
      targetName: string;
      friendlyOffensives: Array<{ playerName: string }>;
    }>;
    friendCCSummaries?: Array<{
      playerName: string;
      ccInstances: Array<Pick<ICCInstance, 'atSeconds' | 'durationSeconds'>>;
    }>;
    healerExposures?: IHealerBurstExposure[];
  }): IPositionEvent[]
  ```

- [ ] **Step 4: Commit**
  ```bash
  git add packages/shared/src/utils/positionAnalysis.ts
  git commit -m "feat(positioning): add healer exposure types and parameters to position analysis"
  ```

---

### Task 2: Implement Cross-Reference Logic and Formatting in `positionAnalysis.ts`

**Files:**
- Modify: `packages/shared/src/utils/positionAnalysis.ts`

- [ ] **Step 1: Extract healer exposure matching logic**
  Inside `computeOwnerPositionEvents`, extract `healerExposures` from `params` and query it for each burst window.
  Update destructuring:
  ```typescript
  const {
    owner,
    enemies,
    combat,
    burstWindows,
    ownerCooldowns,
    ownerCCSummary,
    isHealer,
    ownerIsMelee,
    friends,
    offensiveWindows,
    friendCCSummaries,
    healerExposures,
  } = params;
  ```
  And inside the `for (const w of burstWindows)` loop:
  ```typescript
    const exposure = isHealer && healerExposures
      ? healerExposures.find((e) => Math.abs(e.atSeconds - w.fromSeconds) < 0.1)
      : undefined;
    const healerExposureLabel = exposure?.exposureLabel;
  ```

- [ ] **Step 2: Assign `healerExposureLabel` to KITED and STAYED_IN events**
  Ensure the `healerExposureLabel` is passed when pushing `KITED` and `STAYED_IN` events:
  ```typescript
    if (maxDistance - start.distanceYards >= KITE_DELTA_YARDS) {
      events.push({
        type: 'KITED',
        atSeconds: w.fromSeconds,
        toSeconds: evalEnd,
        startDistanceYards: Math.round(start.distanceYards * 10) / 10,
        endDistanceYards: Math.round(maxDistance * 10) / 10,
        nearestEnemyName: start.enemyName,
        dangerLabel: w.dangerLabel,
        dampeningPct: w.dampeningPct,
        burstTargetsOwner,
        burstTargetName: burstTargetsOwner === false ? targetName : undefined,
        healerExposureLabel,
      });
    } else if (delta < STAY_DELTA_YARDS) {
      // ...
      events.push({
        type: 'STAYED_IN',
        atSeconds: w.fromSeconds,
        toSeconds: evalEnd,
        startDistanceYards: Math.round(start.distanceYards * 10) / 10,
        endDistanceYards: Math.round(end.distanceYards * 10) / 10,
        nearestEnemyName: start.enemyName,
        dangerLabel: w.dangerLabel,
        dampeningPct: w.dampeningPct,
        ownerDefensiveAvailable:
          defensiveCDs.length > 0 ? defensiveCDs.some((cd) => isAvailableAt(cd, w.fromSeconds)) : undefined,
        burstTargetsOwner,
        burstTargetName: burstTargetsOwner === false ? targetName : undefined,
        ownerHpStartPct: hpStart === null ? null : Math.round(hpStart),
        ownerHpMinPct: hpMin === null ? null : Math.round(hpMin),
        healerExposureLabel,
      });
    }
  ```

- [ ] **Step 3: Update `formatPositionEventsForContext`**
  Modify the formatters for `STAYED_IN` and `KITED` to include the exposure label string.
  
  For `STAYED_IN` (around line 531):
  ```typescript
      const exposureStr = e.healerExposureLabel
        ? ` — healer exposure: ${e.healerExposureLabel}`
        : '';
      lines.push(
        `    ${fmtTime(e.atSeconds)} [${e.dangerLabel} burst] ${e.startDistanceYards}→${e.endDistanceYards}yd from ${e.nearestEnemyName}${targetStr}${exposureStr}${hpStr}${defStr}`,
      );
  ```

  For `KITED` (around line 546):
  ```typescript
      const exposureStr = e.healerExposureLabel
        ? ` — healer exposure: ${e.healerExposureLabel}`
        : '';
      lines.push(
        `    ${fmtTime(e.atSeconds)} [${e.dangerLabel} burst] opened ${e.startDistanceYards}→${e.endDistanceYards}yd from ${e.nearestEnemyName}${targetStr}${exposureStr}`,
      );
  ```

- [ ] **Step 4: Commit**
  ```bash
  git add packages/shared/src/utils/positionAnalysis.ts
  git commit -m "feat(positioning): link exposure label to STAYED_IN and KITED events and format it"
  ```

---

### Task 3: Update `buildMatchContext.ts` to Pass `healerExposures`

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/buildMatchContext.ts`

- [ ] **Step 1: Pass `healerExposures` into `computeOwnerPositionEvents`**
  Modify line 258 of `packages/shared/src/components/CombatReport/CombatAIAnalysis/buildMatchContext.ts`:
  ```typescript
    const positionEvents = computeOwnerPositionEvents({
      owner: owner as ICombatUnit,
      enemies: enemies as ICombatUnit[],
      combat,
      burstWindows: enemyCDTimeline.alignedBurstWindows,
      ownerCooldowns: cooldowns,
      ownerCCSummary: ownerCCSummaryForPosition,
      isHealer: healer,
      ownerIsMelee: isMeleeSpec(owner.spec),
      friends: friends as ICombatUnit[],
      offensiveWindows,
      friendCCSummaries: ccTrinketSummaries,
      healerExposures,
    });
  ```

- [ ] **Step 2: Commit**
  ```bash
  git add packages/shared/src/components/CombatReport/CombatAIAnalysis/buildMatchContext.ts
  git commit -m "feat(positioning): pass healerExposures to positioning analysis in buildMatchContext"
  ```

---

### Task 4: Write and Run Unit Tests for the Cross-Reference Logic

**Files:**
- Modify: `packages/shared/src/utils/__tests__/positionAnalysis.test.ts`

- [ ] **Step 1: Add test case for healer exposure mapping**
  Add a new test inside the `describe('computeOwnerPositionEvents — burst-window engagement', ...)` block:
  ```typescript
    it('attaches healerExposureLabel when healerExposures is provided and owner is healer', () => {
      const owner = makeStaticUnit('o1', 0, 0, { spec: CombatUnitSpec.Priest_Holy, class: CombatUnitClass.Priest });
      const enemy = makeStaticUnit('e1', 5, 0, { spec: CombatUnitSpec.Warrior_Arms });
  
      const fakeExposures = [
        {
          atSeconds: 10,
          burstDangerLabel: 'High',
          trinketState: 'available' as const,
          trinketAvailableAtSeconds: null,
          threats: [],
          exposureLabel: 'Critical' as const,
        },
      ];
  
      const events = computeOwnerPositionEvents({
        owner: owner as any,
        enemies: [enemy] as any,
        combat: makeCombat(),
        burstWindows: [makeBurstWindow(10, 20)],
        ownerCooldowns: [],
        isHealer: true,
        ownerIsMelee: false,
        healerExposures: fakeExposures,
      });
  
      const stayedIn = events.filter((e) => e.type === 'STAYED_IN');
      expect(stayedIn).toHaveLength(1);
      expect(stayedIn[0].healerExposureLabel).toBe('Critical');
  
      const formatted = formatPositionEventsForContext(events);
      const line = formatted.find((l) => l.includes('10 [High burst]'));
      expect(line).toContain('healer exposure: Critical');
    });
  ```

- [ ] **Step 2: Run test suite to verify tests pass**
  Run: `npm run test -w @wowarenalogs/shared -- positionAnalysis.test.ts`
  Expected: PASS

- [ ] **Step 3: Commit**
  ```bash
  git add packages/shared/src/utils/__tests__/positionAnalysis.test.ts
  git commit -m "test(positioning): verify healer exposure cross-referencing and formatting"
  ```

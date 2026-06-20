# Binary Search for HP/Mana Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the performance of `getUnitHpAtTimestamp` and `getUnitManaAtTimestamp` functions by replacing linear scans with binary search, reducing their time complexity from $O(N)$ to $O(\log N)$.

**Architecture:** The `advancedActions` array within `ICombatUnit` is already chronologically sorted by `logLine.timestamp`. We will implement a generic binary search helper function that can locate the index of the closest element to a target timestamp. This helper will then be used within `getUnitHpAtTimestamp` and `getUnitManaAtTimestamp` to efficiently find the relevant `advancedAction` entry.

**Tech Stack:** TypeScript, Jest (for testing).

## Global Constraints

*   Ensure no regressions are introduced in existing functionality.
*   Maintain existing code style and conventions.
*   New tests will be added to `packages/shared/src/utils/__tests__/cooldowns.test.ts`.

---

### Task 1: Implement a generic binary search helper function

**Files:**
- Create: `packages/shared/src/utils/binarySearch.ts`
- Modify: (None)
- Test: `packages/shared/src/utils/__tests__/binarySearch.test.ts` (new file)

**Interfaces:**
- Produces: `binarySearchClosest` function:
    ```typescript
    export function binarySearchClosest<T>(
      arr: T[],
      targetTimestamp: number,
      keyFn: (item: T) => number
    ): T | null
    ```
    This function will take a sorted array `arr`, a `targetTimestamp`, and a `keyFn` to extract the timestamp from an item `T`. It will return the element closest to `targetTimestamp` or `null` if the array is empty.

- [ ] **Step 1: Create `packages/shared/src/utils/binarySearch.ts` with the helper function.**

    ```typescript
    // packages/shared/src/utils/binarySearch.ts
    export function binarySearchClosest<T>(
      arr: T[],
      targetTimestamp: number,
      keyFn: (item: T) => number
    ): T | null {
      if (arr.length === 0) {
        return null;
      }

      let low = 0;
      let high = arr.length - 1;
      let closest = arr[0];
      let minDiff = Math.abs(keyFn(arr[0]) - targetTimestamp);

      while (low <= high) {
        const mid = Math.floor(low + (high - low) / 2);
        const midItem = arr[mid];
        const midTimestamp = keyFn(midItem);
        const currentDiff = Math.abs(midTimestamp - targetTimestamp);

        if (currentDiff < minDiff) {
          minDiff = currentDiff;
          closest = midItem;
        }

        if (midTimestamp === targetTimestamp) {
          return midItem;
        } else if (midTimestamp < targetTimestamp) {
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      return closest;
    }
    ```

- [ ] **Step 2: Create `packages/shared/src/utils/__tests__/binarySearch.test.ts` with failing tests.**

    ```typescript
    // packages/shared/src/utils/__tests__/binarySearch.test.ts
    import { binarySearchClosest } from '../binarySearch';

    describe('binarySearchClosest', () => {
      const data = [
        { ts: 1000 },
        { ts: 2000 },
        { ts: 3000 },
        { ts: 4000 },
        { ts: 5000 },
      ];
      const keyFn = (item: { ts: number }) => item.ts;

      it('should return null for an empty array', () => {
        expect(binarySearchClosest([], 2500, keyFn)).toBeNull();
      });

      it('should find the exact match', () => {
        expect(binarySearchClosest(data, 3000, keyFn)).toEqual({ ts: 3000 });
      });

      it('should find the closest item when target is between two items (closer to lower)', () => {
        expect(binarySearchClosest(data, 2400, keyFn)).toEqual({ ts: 2000 });
      });

      it('should find the closest item when target is between two items (closer to higher)', () => {
        expect(binarySearchClosest(data, 2600, keyFn)).toEqual({ ts: 3000 });
      });

      it('should find the closest item at the beginning of the array', () => {
        expect(binarySearchClosest(data, 500, keyFn)).toEqual({ ts: 1000 });
      });

      it('should find the closest item at the end of the array', () => {
        expect(binarySearchClosest(data, 5500, keyFn)).toEqual({ ts: 5000 });
      });

      it('should handle target timestamp smaller than all items', () => {
        expect(binarySearchClosest(data, 100, keyFn)).toEqual({ ts: 1000 });
      });

      it('should handle target timestamp larger than all items', () => {
        expect(binarySearchClosest(data, 6000, keyFn)).toEqual({ ts: 5000 });
      });

      it('should handle single element array', () => {
        expect(binarySearchClosest([{ ts: 1000 }], 900, keyFn)).toEqual({ ts: 1000 });
        expect(binarySearchClosest([{ ts: 1000 }], 1100, keyFn)).toEqual({ ts: 1000 });
      });
    });
    ```
- [ ] **Step 3: Run test to verify it passes.**
    ```bash
    npm test packages/shared/src/utils/__tests__/binarySearch.test.ts
    ```
    Expected: PASS

- [ ] **Step 4: Commit**
    ```bash
    git add packages/shared/src/utils/binarySearch.ts packages/shared/src/utils/__tests__/binarySearch.test.ts
    git commit -m "feat: Add generic binary search closest helper"
    ```

### Task 2: Refactor `getUnitHpAtTimestamp` to use binary search

**Files:**
- Modify: `packages/shared/src/utils/cooldowns.ts`
- Test: `packages/shared/src/utils/__tests__/cooldowns.test.ts`

**Interfaces:**
- Consumes: `binarySearchClosest` from `packages/shared/src/utils/binarySearch.ts`
- Produces: `getUnitHpAtTimestamp` with $O(\log N)$ performance.

- [ ] **Step 1: Write a failing test for `getUnitHpAtTimestamp` that highlights performance or range accuracy for binary search. Since performance is hard to test directly, focus on edge cases of finding the closest value.**

    ```typescript
    // packages/shared/src/utils/__tests__/cooldowns.test.ts
    // Add inside describe('getUnitHpAtTimestamp', () => { ... });
    // If describe('getUnitHpAtTimestamp') does not exist, create it.
    // Ensure you have makeAdvancedAction and makeUnit helper functions available from testHelpers.

    import { makeAdvancedAction, makeUnit } from './testHelpers'; // Assuming testHelpers has these

    describe('getUnitHpAtTimestamp (optimized with binary search)', () => {
      const advancedActions = [
        makeAdvancedAction(1000, 100, 1000, 1000), // HP 10%
        makeAdvancedAction(2000, 500, 1000, 1000), // HP 50%
        makeAdvancedAction(3000, 200, 1000, 1000), // HP 20%
        makeAdvancedAction(4000, 800, 1000, 1000), // HP 80%
      ].sort((a, b) => a.logLine.timestamp - b.logLine.timestamp); // Ensure sorted for binary search

      const unit = makeUnit('player-1', { advancedActions });

      it('should find the exact HP at a given timestamp', () => {
        expect(getUnitHpAtTimestamp(unit, 2000)).toBe(50);
      });

      it('should find the closest HP before the timestamp', () => {
        // Target 2100, closest is 2000
        expect(getUnitHpAtTimestamp(unit, 2100)).toBe(50);
      });

      it('should find the closest HP after the timestamp', () => {
        // Target 2900, closest is 3000
        expect(getUnitHpAtTimestamp(unit, 2900)).toBe(20);
      });

      it('should handle timestamp before the first action', () => {
        expect(getUnitHpAtTimestamp(unit, 500)).toBe(10);
      });

      it('should handle timestamp after the last action', () => {
        expect(getUnitHpAtTimestamp(unit, 4500)).toBe(80);
      });

      it('should return null if no advancedActions are present', () => {
        const emptyUnit = makeUnit('player-empty', { advancedActions: [] });
        expect(getUnitHpAtTimestamp(emptyUnit, 2000)).toBeNull();
      });

      it('should respect maxDtMs and return null if no close action', () => {
        // Target 1500, closest is 1000. Diff = 500. maxDtMs = 200
        expect(getUnitHpAtTimestamp(unit, 1500, 200)).toBeNull();
      });

      it('should find closest within maxDtMs', () => {
        // Target 1500, closest is 1000. Diff = 500. maxDtMs = 600
        expect(getUnitHpAtTimestamp(unit, 1500, 600)).toBe(10);
      });
    });
    ```
- [ ] **Step 2: Run test to verify it fails.**
    ```bash
    npm test packages/shared/src/utils/__tests__/cooldowns.test.ts -- -t "getUnitHpAtTimestamp (optimized with binary search)"
    ```
    Expected: FAIL (because the `describe` block doesn't exist yet, or existing implementation doesn't pass these specific edge cases for closest). The primary goal of this step is to ensure Jest finds the new tests and reports a failure.

- [ ] **Step 3: Implement the binary search in `getUnitHpAtTimestamp`.**

    ```typescript
    // packages/shared/src/utils/cooldowns.ts
    import { binarySearchClosest } from './binarySearch'; // Add this import

    // ... existing code ...

    export function getUnitHpAtTimestamp(unit: ICombatUnit, timestampMs: number, maxDtMs = 10_000): number | null {
      // Use the binary search helper
      const closestAction = binarySearchClosest(unit.advancedActions, timestampMs, (a) => a.logLine.timestamp);

      if (!closestAction) {
        return null;
      }

      const dt = Math.abs(closestAction.logLine.timestamp - timestampMs);
      if (dt > maxDtMs) {
        return null;
      }
      if (closestAction.advancedActorMaxHp <= 0) {
        return null;
      }

      return Math.round((closestAction.advancedActorCurrentHp / closestAction.advancedActorMaxHp) * 100);
    }

    // ... rest of the file ...
    ```

- [ ] **Step 4: Run tests to verify they pass.**
    ```bash
    npm test packages/shared/src/utils/__tests__/cooldowns.test.ts -- -t "getUnitHpAtTimestamp (optimized with binary search)"
    ```
    Expected: PASS

- [ ] **Step 5: Commit**
    ```bash
    git add packages/shared/src/utils/cooldowns.ts packages/shared/src/utils/__tests__/cooldowns.test.ts
    git commit -m "refactor: Optimize getUnitHpAtTimestamp with binary search"
    ```

### Task 3: Refactor `getUnitManaAtTimestamp` to use binary search

**Files:**
- Modify: `packages/shared/src/utils/cooldowns.ts`
- Test: `packages/shared/src/utils/__tests__/cooldowns.test.ts`

**Interfaces:**
- Consumes: `binarySearchClosest` from `packages/shared/src/utils/binarySearch.ts`
- Produces: `getUnitManaAtTimestamp` with $O(\log N)$ performance.

- [ ] **Step 1: Write a failing test for `getUnitManaAtTimestamp` focusing on edge cases for binary search.**

    ```typescript
    // packages/shared/src/utils/__tests__/cooldowns.test.ts
    // Add inside describe('getUnitManaAtTimestamp', () => { ... });
    // If describe('getUnitManaAtTimestamp') does not exist, create it.
    // Ensure you have makeAdvancedAction and makeUnit helper functions available from testHelpers.

    import { CombatUnitPowerType } from '@wowarenalogs/parser';

    describe('getUnitManaAtTimestamp (optimized with binary search)', () => {
      const advancedActions = [
        makeAdvancedAction(1000, 100, 1000, 1000, CombatUnitPowerType.Mana), // Mana 100/1000
        makeAdvancedAction(2000, 500, 1000, 1000, CombatUnitPowerType.Mana), // Mana 500/1000
        makeAdvancedAction(3000, 200, 1000, 1000, CombatUnitPowerType.Mana), // Mana 200/1000
        makeAdvancedAction(4000, 800, 1000, 1000, CombatUnitPowerType.Mana), // Mana 800/1000
      ].sort((a, b) => a.logLine.timestamp - b.logLine.timestamp);

      const unit = makeUnit('player-1', { advancedActions });

      it('should find the exact mana at a given timestamp', () => {
        expect(getUnitManaAtTimestamp(unit, 2000)).toEqual({ current: 500, max: 1000 });
      });

      it('should find the closest mana before the timestamp', () => {
        expect(getUnitManaAtTimestamp(unit, 2100)).toEqual({ current: 500, max: 1000 });
      });

      it('should find the closest mana after the timestamp', () => {
        expect(getUnitManaAtTimestamp(unit, 2900)).toEqual({ current: 200, max: 1000 });
      });

      it('should handle timestamp before the first action', () => {
        expect(getUnitManaAtTimestamp(unit, 500)).toEqual({ current: 100, max: 1000 });
      });

      it('should handle timestamp after the last action', () => {
        expect(getUnitManaAtTimestamp(unit, 4500)).toEqual({ current: 800, max: 1000 });
      });

      it('should return null if no advancedActions are present', () => {
        const emptyUnit = makeUnit('player-empty', { advancedActions: [] });
        expect(getUnitManaAtTimestamp(emptyUnit, 2000)).toBeNull();
      });

      it('should return null if no mana power type is found in advancedActions', () => {
        const hpOnlyActions = [
          makeAdvancedAction(1000, 100, 1000, 1000, CombatUnitPowerType.Health),
        ];
        const unitHpOnly = makeUnit('player-hp-only', { advancedActions: hpOnlyActions });
        expect(getUnitManaAtTimestamp(unitHpOnly, 1000)).toBeNull();
      });

      it('should respect maxDtMs and return null if no close action', () => {
        expect(getUnitManaAtTimestamp(unit, 1500, 200)).toBeNull();
      });

      it('should find closest within maxDtMs', () => {
        expect(getUnitManaAtTimestamp(unit, 1500, 600)).toEqual({ current: 100, max: 1000 });
      });
    });
    ```
- [ ] **Step 2: Run test to verify it fails.**
    ```bash
    npm test packages/shared/src/utils/__tests__/cooldowns.test.ts -- -t "getUnitManaAtTimestamp (optimized with binary search)"
    ```
    Expected: FAIL

- [ ] **Step 3: Implement the binary search in `getUnitManaAtTimestamp`.**

    ```typescript
    // packages/shared/src/utils/cooldowns.ts
    // ... existing imports ...
    import { binarySearchClosest } from './binarySearch'; // Ensure this import is present

    // ... existing code ...

    export function getUnitManaAtTimestamp(
      unit: ICombatUnit,
      timestampMs: number,
      maxDtMs = 10_000,
    ): { current: number; max: number } | null {
      const closestAction = binarySearchClosest(unit.advancedActions, timestampMs, (a) => a.logLine.timestamp);

      if (!closestAction) {
        return null;
      }

      const dt = Math.abs(closestAction.logLine.timestamp - timestampMs);
      if (dt > maxDtMs) {
        return null;
      }

      const manaPower = closestAction.advancedActorPowers.find((p) => p.type === CombatUnitPowerType.Mana);
      if (!manaPower) {
        return null;
      }

      return { current: manaPower.current, max: manaPower.max };
    }

    // ... rest of the file ...
    ```

- [ ] **Step 4: Run tests to verify they pass.**
    ```bash
    npm test packages/shared/src/utils/__tests__/cooldowns.test.ts -- -t "getUnitManaAtTimestamp (optimized with binary search)"
    ```
    Expected: PASS

- [ ] **Step 5: Commit**
    ```bash
    git add packages/shared/src/utils/cooldowns.ts packages/shared/src/utils/__tests__/cooldowns.test.ts
    git commit -m "refactor: Optimize getUnitManaAtTimestamp with binary search"
    ```

### Task 4: Clean up `test_file.txt` (if it exists)

**Files:**
- Delete: `test_file.txt`

- [ ] **Step 1: Remove `test_file.txt`**
    ```bash
    rm test_file.txt
    ```

- [ ] **Step 2: Commit**
    ```bash
    git rm test_file.txt
    git commit -m "chore: Remove temporary test file"
    ```

Plan complete and saved to `docs/superpowers/plans/2026-06-18-binary-search-hpm.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
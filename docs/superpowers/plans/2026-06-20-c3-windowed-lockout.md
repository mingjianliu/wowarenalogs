# C3 Windowed-Lockout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the death-instant `wasInHardCC` check with a pre-death _windowed_ lockout, so "unused defensive at death" coaching is only suppressed when the player was genuinely CC-locked through the lethal window.

**Architecture:** Add one pure helper `wasLockedOutThroughWindow` to `deathOutcomeAnalysis.ts` that computes the longest CC-free gap in `[death−5s, death]`. Route both death-coaching paths (the `[DEATH] (Unused:)` line and the "DEATHS WITH MISSED OPTIONS" annotations) through it, then delete `wasInHardCC`.

**Tech Stack:** TypeScript monorepo; tests via `tsdx`/jest in `packages/shared`.

**Spec:** `docs/superpowers/specs/2026-06-20-c3-windowed-lockout-design.md`

## Global Constraints

- Work on local `main` (the post-decompose code lives there). Do NOT push.
- Run tests from `packages/shared` and ALWAYS pass `--no-cache` (the jest cache here gets poisoned and shows phantom `downlevelIteration` errors): `npx tsdx test <pattern> --no-cache`.
- Pre-commit hook runs lint + typecheck across all workspaces (~60s) and may reformat; on a prettier failure run `npx eslint --fix <files>`, re-test, recommit. Never `--no-verify`.
- Whitelist (`USABLE_WHILE_CC_SPELL_IDS`) and the uniform CC model are UNCHANGED. Constants: `LETHAL_WINDOW_SECONDS = 5`, `MIN_FREE_GAP_SECONDS = 1`.
- Commit trailers (end every commit message with exactly):
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01C1AuTEjpzDkjww3VF8fEDG
  ```

---

## File Structure

- `packages/shared/src/utils/deathOutcomeAnalysis.ts` — add `wasLockedOutThroughWindow` + constants (Task 1); swap Path B call sites + delete `wasInHardCC` (Task 3).
- `packages/shared/src/utils/__tests__/deathOutcomeAnalysis.test.ts` — helper unit tests (Task 1) + Path B integration test (Task 3).
- `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimelineSections.ts` — swap Path A call site (Task 2).
- `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts` — Path A integration test (Task 2).

---

### Task 1: `wasLockedOutThroughWindow` helper + constants

**Files:**

- Modify: `packages/shared/src/utils/deathOutcomeAnalysis.ts` (add export near `wasInHardCC` at line ~186)
- Test: `packages/shared/src/utils/__tests__/deathOutcomeAnalysis.test.ts`

**Interfaces:**

- Consumes: `IPlayerCCTrinketSummary` (already imported in `deathOutcomeAnalysis.ts`); each `ccInstance` has `{ atSeconds: number; durationSeconds: number; trinketState: 'used' | 'available_unused' | 'on_cooldown' | 'passive_trinket' }`.
- Produces: `export const LETHAL_WINDOW_SECONDS = 5`, `export const MIN_FREE_GAP_SECONDS = 1`, and `export function wasLockedOutThroughWindow(ccSummary: Pick<IPlayerCCTrinketSummary, 'playerName' | 'ccInstances'>, deathSeconds: number, windowSeconds?: number): boolean`.

- [ ] **Step 1: Write the failing unit tests**

Append to `packages/shared/src/utils/__tests__/deathOutcomeAnalysis.test.ts`. Add `wasLockedOutThroughWindow` to the existing import from `../deathOutcomeAnalysis`, then add:

```ts
describe('wasLockedOutThroughWindow', () => {
  const cc = (atSeconds: number, durationSeconds: number, trinketState = 'available_unused'): any => ({
    atSeconds,
    durationSeconds,
    trinketState,
  });

  it('locks out when CC covers the window but the player is free at the death tick', () => {
    // death at 10; window [5,10]; CC [5,9.9] leaves only a 0.1s free tail
    const summary = { playerName: 'p', ccInstances: [cc(5, 4.9)] };
    expect(wasLockedOutThroughWindow(summary, 10)).toBe(true);
  });

  it('does NOT lock out when there is a >= 1s free gap mid-window', () => {
    // death at 10; window [5,10]; stuns [5,6] and [9,9.5] leave a 3s gap
    const summary = { playerName: 'p', ccInstances: [cc(5, 1), cc(9, 0.5)] };
    expect(wasLockedOutThroughWindow(summary, 10)).toBe(false);
  });

  it('locks out when CC fully spans the window', () => {
    const summary = { playerName: 'p', ccInstances: [cc(4, 7)] }; // [4,11] covers [5,10]
    expect(wasLockedOutThroughWindow(summary, 10)).toBe(true);
  });

  it('does NOT lock out when there is no CC', () => {
    expect(wasLockedOutThroughWindow({ playerName: 'p', ccInstances: [] }, 10)).toBe(false);
  });

  it('ignores CC the player trinketed out of', () => {
    const summary = { playerName: 'p', ccInstances: [cc(5, 4.9, 'used')] };
    expect(wasLockedOutThroughWindow(summary, 10)).toBe(false);
  });

  it('clamps the window to match start for an early death', () => {
    // death at 3; window clamps to [0,3]; CC [0,3] fully covers it
    const summary = { playerName: 'p', ccInstances: [cc(0, 3)] };
    expect(wasLockedOutThroughWindow(summary, 3)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/shared && npx tsdx test deathOutcomeAnalysis --no-cache -t "wasLockedOutThroughWindow"`
Expected: FAIL — `wasLockedOutThroughWindow is not a function` / not exported.

- [ ] **Step 3: Implement the helper**

In `packages/shared/src/utils/deathOutcomeAnalysis.ts`, immediately above the existing `export function wasInHardCC(` (line ~186), add:

```ts
/** Lethal-window length used to judge whether a player could have pressed a defensive before dying. */
export const LETHAL_WINDOW_SECONDS = 5;
/** Minimum contiguous CC-free gap (seconds) that counts as "they had a moment to press something". */
export const MIN_FREE_GAP_SECONDS = 1;

/**
 * True only if the player had NO contiguous CC-free gap >= MIN_FREE_GAP_SECONDS in the
 * [death - windowSeconds, death] window — i.e. they were effectively locked out for the
 * whole lethal window. CC the player trinketed out of (`trinketState === 'used'`) does not
 * count as lockout. Uniform CC model: every CC type is treated the same.
 */
export function wasLockedOutThroughWindow(
  ccSummary: Pick<IPlayerCCTrinketSummary, 'playerName' | 'ccInstances'>,
  deathSeconds: number,
  windowSeconds = LETHAL_WINDOW_SECONDS,
): boolean {
  const windowStart = Math.max(0, deathSeconds - windowSeconds);
  const windowEnd = deathSeconds;
  if (windowEnd <= windowStart) return false;

  const intervals = ccSummary.ccInstances
    .filter((cc) => cc.trinketState !== 'used')
    .map((cc): [number, number] => [
      Math.max(windowStart, cc.atSeconds),
      Math.min(windowEnd, cc.atSeconds + cc.durationSeconds),
    ])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);

  let cursor = windowStart;
  let maxFreeGap = 0;
  for (const [start, end] of intervals) {
    if (start > cursor) maxFreeGap = Math.max(maxFreeGap, start - cursor);
    cursor = Math.max(cursor, end);
  }
  if (windowEnd > cursor) maxFreeGap = Math.max(maxFreeGap, windowEnd - cursor);

  return maxFreeGap < MIN_FREE_GAP_SECONDS;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/shared && npx tsdx test deathOutcomeAnalysis --no-cache`
Expected: PASS (all existing + the 6 new tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/mingjianliu/code/wowarenalogs
git add packages/shared/src/utils/deathOutcomeAnalysis.ts packages/shared/src/utils/__tests__/deathOutcomeAnalysis.test.ts
git commit  # message: "feat(deaths): add windowed wasLockedOutThroughWindow helper (C3)" + trailers
```

---

### Task 2: Route Path A (`[DEATH] (Unused:)`) through the windowed helper

**Files:**

- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimelineSections.ts:16` (import) and `:443,:451` (usage)
- Test: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`

**Interfaces:**

- Consumes: `wasLockedOutThroughWindow` from Task 1.

- [ ] **Step 1: Write the failing integration test**

In `timeline.test.ts`, find the existing test `F145: flags unused major defensives on a teammate death` (it asserts `(Unused: Lay on Hands)`). Add this new test immediately after it:

```ts
it('F145/C3: drops a non-whitelist defensive when the player was CC-locked through the lethal window', () => {
  const teammate = { ...makeOwner('Simplesauce'), damageIn: [], auraEvents: [] } as any;
  const loh: IMajorCooldownInfo = {
    spellId: '633',
    spellName: 'Lay on Hands',
    tag: 'Defensive',
    cooldownSeconds: 600,
    maxChargesDetected: 1,
    casts: [],
    availableWindows: [{ fromSeconds: 0, toSeconds: 600, durationSeconds: 600 }],
    neverUsed: true,
  };
  const result = buildMatchTimeline(
    makeBaseParams({
      friends: [makeOwner('Feramonk'), teammate],
      friendlyDeaths: [{ spec: 'Unholy Death Knight', name: 'Simplesauce', atSeconds: 118 }],
      teammateCDs: [{ player: teammate, spec: 'Unholy Death Knight', cds: [loh] }],
      // CC covers [113, 117.9] of the [113,118] window — free only 0.1s, and the CC has
      // ended by the exact death tick (118), which the OLD death-instant check missed.
      ccTrinketSummaries: [
        {
          playerName: 'Simplesauce',
          ccInstances: [{ atSeconds: 113, durationSeconds: 4.9, trinketState: 'available_unused' }],
        } as any,
      ],
    }),
  );
  expect(result).toContain('Simplesauce');
  expect(result).not.toContain('(Unused: Lay on Hands)');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/shared && npx tsdx test timeline --no-cache -t "CC-locked through the lethal window"`
Expected: FAIL — old `wasInHardCC` checks only the death tick (118), where the CC is no longer active, so `Lay on Hands` is still listed → `not.toContain` fails.

- [ ] **Step 3: Swap the call site**

In `matchTimelineSections.ts`:

Line 16, change the import:

```ts
import { wasLockedOutThroughWindow } from '../../../utils/deathOutcomeAnalysis';
```

Line ~443, change:

```ts
const isLockedOut = summary ? wasLockedOutThroughWindow(summary, death.atSeconds) : false;
```

Line ~451, change the filter to use the renamed variable:

```ts
        .filter((cd) => !isLockedOut || USABLE_WHILE_CC_SPELL_IDS.has(cd.spellId))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/shared && npx tsdx test timeline --no-cache`
Expected: PASS — the new test passes; the original `F145` test (no CC summary → not locked out) still lists `Lay on Hands`.

- [ ] **Step 5: Commit**

```bash
cd /Users/mingjianliu/code/wowarenalogs
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimelineSections.ts packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts
git commit  # message: "fix(deaths): window the [DEATH] (Unused:) CC suppression (C3 Path A)" + trailers
```

---

### Task 3: Route Path B (DEATHS WITH MISSED OPTIONS) through the helper + delete `wasInHardCC`

**Files:**

- Modify: `packages/shared/src/utils/deathOutcomeAnalysis.ts:228,261` (swap) and `:186-193` (delete `wasInHardCC`)
- Test: `packages/shared/src/utils/__tests__/deathOutcomeAnalysis.test.ts`

**Interfaces:**

- Consumes: `wasLockedOutThroughWindow` from Task 1.

- [ ] **Step 1: Write the failing integration test**

Append to `deathOutcomeAnalysis.test.ts` inside the `describe('buildDeathOutcomeSummary — immunity checks', …)` block (or after it):

```ts
it('C3: annotates "was in CC" when CC-locked through the window even if free at the death tick', () => {
  // Ret Paladin dies at 10s with Divine Shield available; CC covers [5,9.9] (window [5,10]),
  // but has ended by the exact death tick (10) — the old death-instant check said "not CC'd".
  const dead = makeDeadUnit('p1', MATCH_START + 10_000, { spec: CombatUnitSpec.Paladin_Retribution });
  const ccSummary = makeCCSummary('p1', [{ atSeconds: 5, durationSeconds: 4.9, trinketState: 'available_unused' }]);
  const result = buildDeathOutcomeSummary(makeCombat() as any, [dead], [ccSummary]);
  const out = formatDeathOutcomeForContext(result);
  expect(out).toContain('Divine Shield available, was in CC');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/shared && npx tsdx test deathOutcomeAnalysis --no-cache -t "annotates"`
Expected: FAIL — old `wasInHardCC(…, 10)` is false (CC ended at 9.9), so the annotation reads `, was not CC'd`.

- [ ] **Step 3: Swap the Path B call sites**

In `deathOutcomeAnalysis.ts`:

Line ~228:

```ts
          wasInCC: ccSummary ? wasLockedOutThroughWindow(ccSummary, atSeconds) : false,
```

Line ~261:

```ts
            casterWasInCC: teammateCCSummary ? wasLockedOutThroughWindow(teammateCCSummary, atSeconds) : false,
```

- [ ] **Step 4: Delete the now-unused `wasInHardCC`**

Confirm no remaining callers:

```bash
cd /Users/mingjianliu/code/wowarenalogs
grep -rn "wasInHardCC" packages/shared/src packages/tools/src
```

Expected: only the definition in `deathOutcomeAnalysis.ts` (the `dataManifest.json` hit is a commit-message string — ignore). Then delete the whole `export function wasInHardCC(...) { ... }` block (lines ~186-193).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/shared && npx tsdx test deathOutcomeAnalysis --no-cache`
Expected: PASS — the new annotation test passes; existing immunity/external tests (empty CC → not locked out) unchanged.

- [ ] **Step 6: Full-suite regression check**

Run: `cd packages/shared && npx tsdx test --no-cache`
Expected: 30 suites pass, 0 failures. If any pre-existing death/`(Unused:)` test changed because its fixture had CC inside the new window, update that test's expectation to the windowed semantics (showing the corrected `expect`), then re-run.

- [ ] **Step 7: Commit**

```bash
cd /Users/mingjianliu/code/wowarenalogs
git add packages/shared/src/utils/deathOutcomeAnalysis.ts packages/shared/src/utils/__tests__/deathOutcomeAnalysis.test.ts
git commit  # message: "fix(deaths): window Path B + remove wasInHardCC (C3); unify on wasLockedOutThroughWindow" + trailers
```

---

## Self-Review

- **Spec coverage:** windowed helper (Task 1) ✓; window/free-gap constants (Task 1) ✓; uniform CC model + whitelist unchanged (no whitelist edits in any task) ✓; Path A swap (Task 2) ✓; Path B swap (Task 3) ✓; `wasInHardCC` removed (Task 3) ✓; silence/interrupt lockout at `:224` left untouched (no task modifies it) ✓; all 6 unit cases + both integration cases present ✓.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `wasLockedOutThroughWindow(ccSummary, deathSeconds, windowSeconds?)` signature is identical across Task 1 (def), Task 2, and Task 3 (calls). Variable rename `isTeammateInCC → isLockedOut` applied at both its definition (:443) and use (:451).

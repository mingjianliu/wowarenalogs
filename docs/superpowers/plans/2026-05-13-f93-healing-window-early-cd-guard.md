# F93: Healing Window Early-CD Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suppress the `[HEALING]` effectiveness line when a healing-amplifier CD was cast in the first 10 seconds of the match and the measured HPS is below a minimum threshold (indicating pre-combat / cold-start noise, not real signal).

**Architecture:** Two new constants in `timelineHelpers.ts` define the guard thresholds. A two-condition check (`cast.timeSeconds < earlyThreshold && maxBucketHps < minHps`) in `matchTimeline.ts` skips appending the `[HEALING]` line entirely. The "No healing logged" fallback is also suppressed in the same branch, so the whole block is silent for early low-activity windows.

**Tech Stack:** TypeScript, Jest. No new files — changes are additive constants + a conditional.

---

## File Map

| File                                                                                      | Change                                                                                                     |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/components/CombatReport/CombatAIAnalysis/timelineHelpers.ts`         | Add two exported constants: `HEALING_WINDOW_EARLY_CD_SECONDS` and `HEALING_WINDOW_MIN_HPS`                 |
| `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`           | Import the new constants; add guard before appending `[HEALING]` lines                                     |
| `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts` | Add tests to the existing `describe('buildMatchTimeline — [HEALING] line on healing amplifier CDs')` block |

---

## Task 1: Add constants to `timelineHelpers.ts`

**Files:**

- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/timelineHelpers.ts` (after line ~272, the `HEALING_AMPLIFIER_SPELL_IDS` block)

- [ ] **Step 1: Write the failing test**

Open `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`.

Find the existing import of `HEALING_AMPLIFIER_SPELL_IDS` from `'../timelineHelpers'` (around line 23-27) and add the two new constants:

```typescript
import {
  computeHealingInWindow,
  HEALING_AMPLIFIER_SPELL_IDS,
  HEALING_WINDOW_EARLY_CD_SECONDS,
  HEALING_WINDOW_MIN_HPS,
} from '../timelineHelpers';
```

Add this test block right after the existing `computeHealingInWindow` describe block (after line ~2848):

```typescript
// ── HEALING_WINDOW_EARLY_CD_SECONDS / HEALING_WINDOW_MIN_HPS constants (F93) ──

describe('HEALING_WINDOW constants (F93)', () => {
  it('HEALING_WINDOW_EARLY_CD_SECONDS is 10', () => {
    expect(HEALING_WINDOW_EARLY_CD_SECONDS).toBe(10);
  });

  it('HEALING_WINDOW_MIN_HPS is 1000', () => {
    expect(HEALING_WINDOW_MIN_HPS).toBe(1_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/mingjianliu/code/wowarenalogs
npm run test -- --testPathPattern="timeline.test" --testNamePattern="HEALING_WINDOW constants" 2>&1 | tail -20
```

Expected: FAIL — `HEALING_WINDOW_EARLY_CD_SECONDS` and `HEALING_WINDOW_MIN_HPS` are not exported from `timelineHelpers`.

- [ ] **Step 3: Add constants to `timelineHelpers.ts`**

In `timelineHelpers.ts`, add the two new exports directly after the `HEALING_AMPLIFIER_SPELL_IDS` block (after line ~272):

```typescript
/** CD cast within this many seconds of match start is considered "early" for healing-window suppression. */
export const HEALING_WINDOW_EARLY_CD_SECONDS = 10;

/** Max per-bucket HPS below this value is treated as no meaningful healing activity. */
export const HEALING_WINDOW_MIN_HPS = 1_000;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/mingjianliu/code/wowarenalogs
npm run test -- --testPathPattern="timeline.test" --testNamePattern="HEALING_WINDOW constants" 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/timelineHelpers.ts \
        packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts
git commit -m "feat(F93): add HEALING_WINDOW_EARLY_CD_SECONDS and HEALING_WINDOW_MIN_HPS constants"
```

---

## Task 2: Add guard tests for the early-CD suppression behavior

**Files:**

- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`

These tests drive the guard implementation in Task 3.

- [ ] **Step 1: Write the failing tests**

Inside the existing `describe('buildMatchTimeline — [HEALING] line on healing amplifier CDs', () => {` block, add these test cases after the last existing test (after line ~2959):

```typescript
it('suppresses [HEALING] when PI is cast before 10s and all buckets are 0 HPS', () => {
  // Cast at 5s (early), no healing events → healStats will be null → computeHealingInWindow returns null
  // We need to simulate zero HPS: provide a heal event OUTSIDE the PI window
  // PI cast at 5s, duration 15s → window [5s, 20s]. Event at 25s is outside.
  const healOut = [makeHealEvent(matchStartMs + 25_000, 'healer-1', 100_000)];
  const timeline = buildMatchTimeline(makeBaseParams(healOut, [makePICD(5)]));
  expect(timeline).toContain('[OWNER CD]   Power Infusion');
  expect(timeline).not.toContain('[HEALING]');
});

it('suppresses [HEALING] when PI is cast before 10s and buckets are all below 1k HPS', () => {
  // Cast at 3s (early), very tiny heal in window (500 effective / 15s ≈ 33 HPS — below 1k threshold)
  const healOut = [makeHealEvent(matchStartMs + 5_000, 'healer-1', 500)];
  const timeline = buildMatchTimeline(makeBaseParams(healOut, [makePICD(3)]));
  expect(timeline).toContain('[OWNER CD]   Power Infusion');
  expect(timeline).not.toContain('[HEALING]');
});

it('does NOT suppress [HEALING] when PI is cast before 10s but HPS is above threshold', () => {
  // Cast at 5s (early), but real healing occurred → max bucket HPS well above 1k
  const healOut = [
    makeHealEvent(matchStartMs + 6_000, 'healer-1', 50_000),
    makeHealEvent(matchStartMs + 10_000, 'healer-1', 80_000),
  ];
  const timeline = buildMatchTimeline(makeBaseParams(healOut, [makePICD(5)]));
  expect(timeline).toContain('[HEALING]');
});

it('does NOT suppress [HEALING] when PI is cast at exactly 10s (boundary is exclusive)', () => {
  // Cast at 10s → not "early" by the guard (cast.timeSeconds < 10 is false)
  const healOut = [makeHealEvent(matchStartMs + 12_000, 'healer-1', 150_000)];
  const timeline = buildMatchTimeline(makeBaseParams(healOut, [makePICD(10)]));
  expect(timeline).toContain('[HEALING]');
});

it('does NOT suppress [HEALING] when PI is cast after 10s with low HPS', () => {
  // Cast at 15s (not early) — low HPS alone is not a suppression reason
  const healOut = [makeHealEvent(matchStartMs + 16_000, 'healer-1', 500)];
  const timeline = buildMatchTimeline(makeBaseParams(healOut, [makePICD(15)]));
  // HPS is low but cast is not early → still emit [HEALING]
  expect(timeline).toContain('[HEALING]');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/mingjianliu/code/wowarenalogs
npm run test -- --testPathPattern="timeline.test" --testNamePattern="suppresses \[HEALING\]|does NOT suppress \[HEALING\]" 2>&1 | tail -30
```

Expected: The two "suppresses" tests fail (line contains `[HEALING]` when it shouldn't); the three "does NOT suppress" tests pass (no guard exists yet).

- [ ] **Step 3: Commit the tests**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts
git commit -m "test(F93): add failing tests for early-CD healing window suppression guard"
```

---

## Task 3: Implement the guard in `matchTimeline.ts`

**Files:**

- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`

- [ ] **Step 1: Import the new constants**

The import block at the top of `matchTimeline.ts` already imports `HEALING_AMPLIFIER_SPELL_IDS` from `'./timelineHelpers'` (line ~26). Extend it to include the two new constants:

```typescript
import {
  computeHealingInWindow,
  DMG_SPIKE_THRESHOLD,
  extractEnemyMajorBuffIntervals,
  extractOwnerCDBuffExpiry,
  getTopDamageSourcesInWindow,
  HEALER_CAST_SPELL_ID_TO_NAME,
  HEALING_AMPLIFIER_SPELL_IDS,
  HEALING_WINDOW_EARLY_CD_SECONDS,
  HEALING_WINDOW_MIN_HPS,
  PASSIVE_SPELL_BLOCKLIST,
} from './timelineHelpers';
```

- [ ] **Step 2: Add the guard**

Find the `[HEALING]` emission block in `matchTimeline.ts` (around line 256–270). It currently looks like:

```typescript
if (HEALING_AMPLIFIER_SPELL_IDS.has(cd.spellId)) {
  const duration = spellEffectData[cd.spellId]?.durationSeconds;
  if (duration) {
    const fromMs = matchStartMs + cast.timeSeconds * 1000;
    const toMs = fromMs + duration * 1000;
    const healStats = computeHealingInWindow(owner.healOut, fromMs, toMs);
    if (healStats) {
      const bucketParts = healStats.buckets.map(
        (b) => `${b.fromSeconds}–${b.toSeconds}s: ${(b.hps / 1000).toFixed(1)}k HPS`,
      );
      extraLines.push(`      [HEALING]    ${bucketParts.join(' | ')} | Overheal: ${healStats.overhealPct}%`);
    } else {
      extraLines.push(`      [HEALING]    No healing logged during this window`);
    }
  }
}
```

Replace it with:

```typescript
if (HEALING_AMPLIFIER_SPELL_IDS.has(cd.spellId)) {
  const duration = spellEffectData[cd.spellId]?.durationSeconds;
  if (duration) {
    const fromMs = matchStartMs + cast.timeSeconds * 1000;
    const toMs = fromMs + duration * 1000;
    const healStats = computeHealingInWindow(owner.healOut, fromMs, toMs);
    const maxBucketHps = healStats ? Math.max(...healStats.buckets.map((b) => b.hps)) : 0;
    const isEarlyLowActivity =
      cast.timeSeconds < HEALING_WINDOW_EARLY_CD_SECONDS && maxBucketHps < HEALING_WINDOW_MIN_HPS;
    if (!isEarlyLowActivity) {
      if (healStats) {
        const bucketParts = healStats.buckets.map(
          (b) => `${b.fromSeconds}–${b.toSeconds}s: ${(b.hps / 1000).toFixed(1)}k HPS`,
        );
        extraLines.push(`      [HEALING]    ${bucketParts.join(' | ')} | Overheal: ${healStats.overhealPct}%`);
      } else {
        extraLines.push(`      [HEALING]    No healing logged during this window`);
      }
    }
  }
}
```

- [ ] **Step 3: Run all HEALING-related tests to verify they pass**

```bash
cd /Users/mingjianliu/code/wowarenalogs
npm run test -- --testPathPattern="timeline.test" --testNamePattern="HEALING" 2>&1 | tail -20
```

Expected: All tests PASS, including the previously failing "suppresses [HEALING]" tests.

- [ ] **Step 4: Run the full test suite**

```bash
cd /Users/mingjianliu/code/wowarenalogs
npm run test 2>&1 | tail -20
```

Expected: All tests pass, no regressions.

- [ ] **Step 5: Run lint**

```bash
cd /Users/mingjianliu/code/wowarenalogs
npm run lint 2>&1 | tail -10
```

Expected: 0 errors, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts
git commit -m "feat(F93): suppress [HEALING] window when CD cast early with low activity"
```

---

## Self-Review

**Spec coverage:**

- ✅ CD fired in first 10s of match → covered by `cast.timeSeconds < HEALING_WINDOW_EARLY_CD_SECONDS`
- ✅ HPS reading below minimum threshold → covered by `maxBucketHps < HEALING_WINDOW_MIN_HPS`
- ✅ Both conditions required (AND) → covered by `isEarlyLowActivity` combining both
- ✅ Suppression (not annotation) → `[HEALING]` line not pushed to `extraLines`
- ✅ Only applies when `healStats` is null OR max HPS is below threshold — real healing through an early CD still surfaces

**Placeholder scan:** None found. All code blocks are complete.

**Type consistency:** `cast.timeSeconds` is `number` throughout (from `IMajorCooldownInfo.casts[].timeSeconds`). `HEALING_WINDOW_EARLY_CD_SECONDS` and `HEALING_WINDOW_MIN_HPS` are both `number` constants. `Math.max(...buckets.map(b => b.hps))` returns `number`. No mismatches.

**Edge cases verified by tests:**

- Early cast + zero HPS (null healStats) → suppressed ✅
- Early cast + sub-threshold HPS → suppressed ✅
- Early cast + above-threshold HPS → NOT suppressed ✅
- Cast at exactly 10s + real healing → NOT suppressed (boundary exclusive) ✅
- Late cast + sub-threshold HPS → NOT suppressed (only one condition) ✅

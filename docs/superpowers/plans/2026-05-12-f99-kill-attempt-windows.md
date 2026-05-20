# F99: Kill Attempt Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `KILL ATTEMPT WINDOWS` section to `buildMatchPrompt` that synthesizes enemy burst CDs and damage spikes into explicit labeled windows so Claude can identify when the enemy actually tried to kill someone.

**Architecture:** A new `formatKillAttemptWindowsForContext` function in `enemyCDs.ts` joins `alignedBurstWindows` (already computed by `reconstructEnemyCDTimeline`) with `pressureWindows` (already computed by `computePressureWindows`) and emits a human-readable summary. `buildMatchPrompt` calls this function once, in the SUPPORTING DATA section after the existing `ENEMY CD TIMELINE` block. No changes to `buildMatchTimeline` — it already handles the new-path equivalent inline.

**Tech Stack:** TypeScript; `IAlignedBurstWindow` from `enemyCDs.ts`, `IDamageBucket` from `cooldowns.ts`, `fmtTime` from `cooldowns.ts`.

---

## Background

`buildMatchTimeline` (new path) emits `[OFFENSIVE WINDOW]` events inline:

```
0:14  [OFFENSIVE WINDOW]   0:14–0:24 | HIGH | 0.84M on Resto Druid | CDs: Combustion + Bloodlust
```

`buildMatchPrompt` (old path) has:

- `ENEMY CD TIMELINE` (individual CD casts, no synthesis)
- `ENEMY VULNERABILITY WINDOWS` (enemy _defensives_ down — good time to attack)

But no section for the inverse: enemy _offensives_ up — real kill attempt happening.

F99 wants: "kill attempt at 0:14–0:24" style labels in `buildMatchPrompt`.

---

## File Map

| File                                                   | Change                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/utils/enemyCDs.ts`                | Add `formatKillAttemptWindowsForContext` function + import `IDamageBucket` from `cooldowns.ts`                     |
| `packages/shared/src/utils/__tests__/enemyCDs.test.ts` | Add describe block for `formatKillAttemptWindowsForContext`                                                        |
| `packages/tools/src/printMatchPrompts.ts`              | Import `formatKillAttemptWindowsForContext`; call it in `buildMatchPrompt` after `formatEnemyCDTimelineForContext` |

---

## Task 1: Add `formatKillAttemptWindowsForContext` to `enemyCDs.ts`

**Files:**

- Modify: `packages/shared/src/utils/enemyCDs.ts`
- Test: `packages/shared/src/utils/__tests__/enemyCDs.test.ts`

### Step 1.1 — Write the failing test first

- [ ] **Step 1: Open `packages/shared/src/utils/__tests__/enemyCDs.test.ts` and append the following describe block at the end of the file.**

You need to add `formatKillAttemptWindowsForContext` to the existing import line at the top (line 4):

Change:

```typescript
import { reconstructEnemyCDTimeline } from '../enemyCDs';
```

to:

```typescript
import { formatKillAttemptWindowsForContext, reconstructEnemyCDTimeline } from '../enemyCDs';
```

Also add an import for `IDamageBucket` (new import line after line 4):

```typescript
import { IDamageBucket } from '../cooldowns';
```

Then append this describe block at the end of the file:

```typescript
describe('formatKillAttemptWindowsForContext', () => {
  function makeBurst(
    fromSeconds: number,
    toSeconds: number,
    spellName: string,
    dangerLabel: 'Low' | 'Moderate' | 'High' | 'Critical',
  ): import('../enemyCDs').IAlignedBurstWindow {
    return {
      fromSeconds,
      toSeconds,
      activeCDs: [{ playerName: 'Enemy', spellName, spellId: '12345' }],
      dangerScore: 2.0,
      dangerLabel,
      dampeningPct: 0,
      damageInWindow: 500_000,
      damageRatio: 1.0,
      healerCCed: false,
    };
  }

  function makeSpike(fromSeconds: number, totalDamage: number): IDamageBucket {
    return { fromSeconds, toSeconds: fromSeconds + 10, totalDamage, targetName: 'Healer', targetSpec: 'Resto Druid' };
  }

  it('returns no-windows message when burst windows array is empty', () => {
    const result = formatKillAttemptWindowsForContext([], []);
    expect(result).toEqual(['KILL ATTEMPT WINDOWS: None detected (no aligned enemy burst windows).']);
  });

  it('emits a kill attempt line for a burst window that has an overlapping spike', () => {
    const burst = makeBurst(14, 24, 'Combustion', 'High');
    const spike = makeSpike(14, 840_000); // 0.84M — above 300k threshold
    const result = formatKillAttemptWindowsForContext([burst], [spike]);
    expect(result[0]).toBe('KILL ATTEMPT WINDOWS (enemy burst CDs + confirmed damage spike):');
    const killLine = result.find((l) => l.includes('0:14'));
    expect(killLine).toBeDefined();
    expect(killLine).toContain('0:14–0:24');
    expect(killLine).toContain('[HIGH]');
    expect(killLine).toContain('0.84M');
    expect(killLine).toContain('Combustion');
    expect(killLine).toContain('Resto Druid');
  });

  it('does not emit a kill attempt line when spike is below threshold (300k)', () => {
    const burst = makeBurst(30, 40, 'Avenging Wrath', 'Moderate');
    const spike = makeSpike(30, 200_000); // 0.2M — below 300k threshold
    const result = formatKillAttemptWindowsForContext([burst], [spike]);
    expect(result.some((l) => l.includes('0:30'))).toBe(false);
    expect(result.some((l) => l.includes('1 burst window(s) had no confirmed spike'))).toBe(true);
  });

  it('notes unconfirmed burst windows separately from confirmed ones', () => {
    const confirmed = makeBurst(10, 20, 'Combustion', 'High');
    const unconfirmed = makeBurst(60, 70, 'Avenging Wrath', 'Moderate');
    const spike = makeSpike(10, 900_000); // only matches first burst
    const result = formatKillAttemptWindowsForContext([confirmed, unconfirmed], [spike]);
    expect(result.some((l) => l.includes('0:10'))).toBe(true);
    expect(result.some((l) => l.includes('0:60') || l.includes('1:00'))).toBe(false);
    expect(result.some((l) => l.includes('1 burst window(s) had no confirmed spike'))).toBe(true);
  });

  it('shows "no confirmed spike" message when all burst windows are unconfirmed', () => {
    const burst = makeBurst(30, 40, 'Avenging Wrath', 'Moderate');
    const result = formatKillAttemptWindowsForContext([burst], []);
    expect(result.some((l) => l.includes('No burst windows had a confirmed damage spike'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npm test -w @wowarenalogs/shared -- --testPathPattern="enemyCDs" 2>&1 | tail -20`

Expected: Fails with `formatKillAttemptWindowsForContext is not a function` or similar.

### Step 1.2 — Implement the function

- [ ] **Step 3: Add `IDamageBucket` to the import in `enemyCDs.ts`**

At the top of `packages/shared/src/utils/enemyCDs.ts`, the existing import from `cooldowns.ts` is:

```typescript
import { fmtTime, getUnitHpAtTimestamp, isHealerSpec, specToString } from './cooldowns';
```

Change it to:

```typescript
import { fmtTime, getUnitHpAtTimestamp, IDamageBucket, isHealerSpec, specToString } from './cooldowns';
```

- [ ] **Step 4: Add the `KILL_ATTEMPT_SPIKE_THRESHOLD` constant and `formatKillAttemptWindowsForContext` function to `enemyCDs.ts`**

Append at the very end of `packages/shared/src/utils/enemyCDs.ts`:

```typescript
/** Minimum total damage in a 10-second window to treat a burst window as a confirmed kill attempt */
const KILL_ATTEMPT_SPIKE_THRESHOLD = 300_000;

/**
 * Synthesizes aligned enemy burst windows with actual damage spikes to label
 * explicit kill attempt windows. A "confirmed" kill attempt = burst window that
 * overlaps with a pressure spike above threshold. Unconfirmed burst windows
 * (likely baits or log gaps) are counted and noted separately.
 */
export function formatKillAttemptWindowsForContext(
  alignedBurstWindows: IAlignedBurstWindow[],
  pressureWindows: IDamageBucket[],
): string[] {
  if (alignedBurstWindows.length === 0) {
    return ['KILL ATTEMPT WINDOWS: None detected (no aligned enemy burst windows).'];
  }

  const lines: string[] = ['KILL ATTEMPT WINDOWS (enemy burst CDs + confirmed damage spike):'];
  let unconfirmedCount = 0;

  for (const burst of alignedBurstWindows) {
    const spike = pressureWindows.find(
      (pw) =>
        pw.totalDamage >= KILL_ATTEMPT_SPIKE_THRESHOLD &&
        pw.fromSeconds >= burst.fromSeconds - 5 &&
        pw.fromSeconds <= burst.toSeconds + 5,
    );
    if (!spike) {
      unconfirmedCount++;
      continue;
    }
    const dmgM = (spike.totalDamage / 1_000_000).toFixed(2);
    const cdNames = burst.activeCDs.map((c) => c.spellName).join(' + ');
    lines.push(
      `  ${fmtTime(burst.fromSeconds)}–${fmtTime(burst.toSeconds)}  [${burst.dangerLabel.toUpperCase()}]  ${dmgM}M on ${spike.targetSpec} | CDs: ${cdNames}`,
    );
  }

  if (lines.length === 1) {
    lines.push('  No burst windows had a confirmed damage spike above threshold.');
  }
  if (unconfirmedCount > 0) {
    lines.push(
      `  Note: ${unconfirmedCount} burst window(s) had no confirmed spike — possible bait, spiked below threshold, or log gap.`,
    );
  }

  return lines;
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npm test -w @wowarenalogs/shared -- --testPathPattern="enemyCDs" 2>&1 | tail -20`

Expected:

```
Tests: 5 passed (new describe block), N passed (existing)
Test Suites: 1 passed
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/utils/enemyCDs.ts packages/shared/src/utils/__tests__/enemyCDs.test.ts
git commit -m "feat(F99): add formatKillAttemptWindowsForContext to enemyCDs.ts

Synthesizes aligned burst windows + pressure spikes into kill attempt labels.
Tests cover confirmed windows, below-threshold spikes, and mixed cases."
```

---

## Task 2: Wire `formatKillAttemptWindowsForContext` into `buildMatchPrompt`

**Files:**

- Modify: `packages/tools/src/printMatchPrompts.ts`

### Context

In `buildMatchPrompt`, the existing `formatEnemyCDTimelineForContext` call appears around line 801:

```typescript
lines.push('');
formatEnemyCDTimelineForContext(enemyCDTimeline, durationSeconds).forEach((l) => lines.push(l));

lines.push('');
formatOverlappedDefensivesForContext(overlappedDefensives).forEach((l) => lines.push(l));
```

I need to insert the kill attempt windows call between those two blocks.

Also, the existing import of `formatEnemyCDTimelineForContext` is on line 66:

```typescript
import { formatEnemyCDTimelineForContext, reconstructEnemyCDTimeline } from '../../shared/src/utils/enemyCDs';
```

- [ ] **Step 1: Add `formatKillAttemptWindowsForContext` to the enemyCDs import**

Change:

```typescript
import { formatEnemyCDTimelineForContext, reconstructEnemyCDTimeline } from '../../shared/src/utils/enemyCDs';
```

to:

```typescript
import {
  formatEnemyCDTimelineForContext,
  formatKillAttemptWindowsForContext,
  reconstructEnemyCDTimeline,
} from '../../shared/src/utils/enemyCDs';
```

- [ ] **Step 2: Insert the kill attempt windows call in `buildMatchPrompt`**

Find this block in `buildMatchPrompt` (around line 801):

```typescript
lines.push('');
formatEnemyCDTimelineForContext(enemyCDTimeline, durationSeconds).forEach((l) => lines.push(l));

lines.push('');
formatOverlappedDefensivesForContext(overlappedDefensives).forEach((l) => lines.push(l));
```

Change it to:

```typescript
lines.push('');
formatEnemyCDTimelineForContext(enemyCDTimeline, durationSeconds).forEach((l) => lines.push(l));

lines.push('');
formatKillAttemptWindowsForContext(enemyCDTimeline.alignedBurstWindows, pressureWindows).forEach((l) => lines.push(l));

lines.push('');
formatOverlappedDefensivesForContext(overlappedDefensives).forEach((l) => lines.push(l));
```

Both `enemyCDTimeline` and `pressureWindows` are already in scope in `buildMatchPrompt` (computed at lines 461 and 466 respectively).

- [ ] **Step 3: TypeScript check**

Run: `npm run -w @wowarenalogs/tools build 2>&1 | grep -i "error\|TS[0-9]" | head -20`

Expected: No errors.

- [ ] **Step 4: Run tests to confirm nothing broke**

Run: `npm test 2>&1 | tail -10`

Expected: All tests pass.

- [ ] **Step 5: Functional check**

Run: `npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 1 2>/dev/null | grep -A 6 "KILL ATTEMPT WINDOWS"`

Expected (values vary):

```
KILL ATTEMPT WINDOWS (enemy burst CDs + confirmed damage spike):
  0:14–0:24  [HIGH]  0.84M on Resto Druid | CDs: Combustion + Bloodlust
  Note: 1 burst window(s) had no confirmed spike — possible bait, spiked below threshold, or log gap.
```

Or if no burst windows: `KILL ATTEMPT WINDOWS: None detected (no aligned enemy burst windows).`

- [ ] **Step 6: Commit**

```bash
git add packages/tools/src/printMatchPrompts.ts
git commit -m "feat(F99): wire KILL ATTEMPT WINDOWS into buildMatchPrompt"
```

---

## Task 3: Mark F99 done in TRACKER.md

**Files:**

- Modify: `TRACKER.md`

- [ ] **Step 1: Change F99 row from `Backlog` to `✅ Done`**

Before:

```
| F99  | Backlog | `[OFFENSIVE WINDOW]` marker missing — synthesize enemy CDs and damage spikes into explicit kill attempt windows ...
```

After:

```
| F99  | ✅ Done | `[OFFENSIVE WINDOW]` marker missing — synthesize enemy CDs and damage spikes into explicit kill attempt windows ...
```

- [ ] **Step 2: Commit**

```bash
git add TRACKER.md
git commit -m "chore: mark F99 done"
```

---

## Self-Review

**Spec coverage:** F99 asks to synthesize enemy CDs + damage spikes into explicit kill attempt windows (e.g. "kill attempt at 0:14–0:24"). Task 1 builds the synthesizer function; Task 2 adds it to `buildMatchPrompt`. ✓

**Placeholder scan:** No TBD/TODO. All code shown in full. ✓

**Type consistency:**

- `formatKillAttemptWindowsForContext(alignedBurstWindows: IAlignedBurstWindow[], pressureWindows: IDamageBucket[]): string[]` — defined in Task 1, called with `(enemyCDTimeline.alignedBurstWindows, pressureWindows)` in Task 2. `enemyCDTimeline.alignedBurstWindows` is `IAlignedBurstWindow[]` ✓. `pressureWindows` is `IDamageBucket[]` ✓.
- `IDamageBucket` import added to `enemyCDs.ts` in Task 1 Step 3. ✓
- `fmtTime` already imported in `enemyCDs.ts`. ✓

**Edge cases:**

- No aligned burst windows → "None detected" one-liner. ✓
- All burst windows unconfirmed → "No burst windows had a confirmed damage spike" + note. ✓
- Mixed confirmed + unconfirmed → only confirmed shown, count note at end. ✓
- Spike slightly outside window (±5s tolerance) → matched per the ±5s guard in find(). ✓

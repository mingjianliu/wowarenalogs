# F96: Match End State Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `MATCH END STATE` section to `buildMatchPrompt` in `printMatchPrompts.ts` so Claude can see who survived, their HP, and who died — helping it reason about the closing seconds.

**Architecture:** `buildMatchPrompt` is the old "DECISION ANALYSIS REQUEST" prompt path (used without `--new-prompt`). The new `buildMatchPromptNew` / `buildMatchTimeline` path already has a `[MATCH END]` block with this data. This plan adds an equivalent section to `buildMatchPrompt` only. The web app React component and `buildMatchPromptNew` are already covered. No new files are needed.

**Tech Stack:** TypeScript, existing `getHpPercentAtTime` from `killWindowTargetSelection.ts`, `fmtTime` / `specToString` already imported in `printMatchPrompts.ts`.

---

## Background

F96 was filed from a May 2026 healer prompt audit. The new `buildMatchTimeline` path (used by `buildMatchPromptNew` and the React component) already appends a `[MATCH END]` block:

```
1:30  [MATCH END]   damp: 15%
  friends 1:95% 2:dead(1:20) / enemies 3:dead(1:25) 4:78%
```

The old `buildMatchPrompt` (invoked by default when running the print tool without `--new-prompt`) ends after the dampening section with no final state at all. This plan adds a `MATCH END STATE` section there.

---

## File Map

| File                                      | Change                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/tools/src/printMatchPrompts.ts` | Add `getHpPercentAtTime` to existing import from `killWindowTargetSelection`, then add `MATCH END STATE` block at end of `buildMatchPrompt` |

No new files. No changes to `matchTimeline.ts`, `index.tsx`, or any shared package files.

---

## Task 1: Add `getHpPercentAtTime` to the import in `printMatchPrompts.ts`

**Files:**

- Modify: `packages/tools/src/printMatchPrompts.ts:75-76`

The existing import at line 75–76 is:

```typescript
import {
  analyzeKillWindowTargetSelection,
  formatKillWindowTargetSelectionForContext,
} from '../../shared/src/utils/killWindowTargetSelection';
```

- [ ] **Step 1: Add `getHpPercentAtTime` to the import**

Edit `packages/tools/src/printMatchPrompts.ts`. Change:

```typescript
import {
  analyzeKillWindowTargetSelection,
  formatKillWindowTargetSelectionForContext,
} from '../../shared/src/utils/killWindowTargetSelection';
```

to:

```typescript
import {
  analyzeKillWindowTargetSelection,
  formatKillWindowTargetSelectionForContext,
  getHpPercentAtTime,
} from '../../shared/src/utils/killWindowTargetSelection';
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npm run -w @wowarenalogs/tools build 2>&1 | tail -5`

Expected: No errors. (Build may warn about other things but not about this import.)

---

## Task 2: Add `MATCH END STATE` section to `buildMatchPrompt`

**Files:**

- Modify: `packages/tools/src/printMatchPrompts.ts` — end of `buildMatchPrompt` (currently line 855–863)

The current end of `buildMatchPrompt` (before `return lines.join('\n')`) is:

```typescript
  lines.push('');
  formatDampeningForContext(
    combat.startInfo.bracket,
    [...friends, ...enemies],
    combat.startTime,
    combat.endTime,
  ).forEach((l) => lines.push(l));

  return lines.join('\n');
}
```

- [ ] **Step 1: Add the MATCH END STATE block**

Insert the following lines between the `formatDampeningForContext` block and `return lines.join('\n')`:

```typescript
// ── MATCH END STATE (F96) ─────────────────────────────────────────────────
// Mirrors [MATCH END] block in buildMatchTimeline so Claude can reason about
// who survived and at what HP without scrolling back to MATCH SUMMARY.
lines.push('');
lines.push('MATCH END STATE');

const friendlyEndParts = friends.map((u) => {
  const death = friendlyDeaths.find((d) => d.name === u.name);
  if (death) return `${specToString(u.spec)} (${u.name}): dead at ${fmtTime(death.atSeconds)}`;
  const pct = getHpPercentAtTime(u, durationSeconds, combat.startTime);
  const clamped = pct !== null ? Math.min(Math.round(pct), 100) : null;
  return `${specToString(u.spec)} (${u.name}): ${clamped !== null ? `${clamped}% HP` : '? HP'}`;
});

const enemyEndParts = enemies.map((u) => {
  const death = enemyDeaths.find((d) => d.name === u.name);
  if (death) return `${specToString(u.spec)} (${u.name}): dead at ${fmtTime(death.atSeconds)}`;
  const pct = getHpPercentAtTime(u, durationSeconds, combat.startTime);
  const clamped = pct !== null ? Math.min(Math.round(pct), 100) : null;
  return `${specToString(u.spec)} (${u.name}): ${clamped !== null ? `${clamped}% HP` : '? HP'}`;
});

if (friendlyEndParts.length > 0) lines.push(`  Friendly: ${friendlyEndParts.join(' | ')}`);
if (enemyEndParts.length > 0) lines.push(`  Enemy: ${enemyEndParts.join(' | ')}`);
```

After the insertion the full tail of `buildMatchPrompt` looks like:

```typescript
  lines.push('');
  formatDampeningForContext(
    combat.startInfo.bracket,
    [...friends, ...enemies],
    combat.startTime,
    combat.endTime,
  ).forEach((l) => lines.push(l));

  // ── MATCH END STATE (F96) ─────────────────────────────────────────────────
  lines.push('');
  lines.push('MATCH END STATE');

  const friendlyEndParts = friends.map((u) => {
    const death = friendlyDeaths.find((d) => d.name === u.name);
    if (death) return `${specToString(u.spec)} (${u.name}): dead at ${fmtTime(death.atSeconds)}`;
    const pct = getHpPercentAtTime(u, durationSeconds, combat.startTime);
    const clamped = pct !== null ? Math.min(Math.round(pct), 100) : null;
    return `${specToString(u.spec)} (${u.name}): ${clamped !== null ? `${clamped}% HP` : '? HP'}`;
  });

  const enemyEndParts = enemies.map((u) => {
    const death = enemyDeaths.find((d) => d.name === u.name);
    if (death) return `${specToString(u.spec)} (${u.name}): dead at ${fmtTime(death.atSeconds)}`;
    const pct = getHpPercentAtTime(u, durationSeconds, combat.startTime);
    const clamped = pct !== null ? Math.min(Math.round(pct), 100) : null;
    return `${specToString(u.spec)} (${u.name}): ${clamped !== null ? `${clamped}% HP` : '? HP'}`;
  });

  if (friendlyEndParts.length > 0) lines.push(`  Friendly: ${friendlyEndParts.join(' | ')}`);
  if (enemyEndParts.length > 0) lines.push(`  Enemy: ${enemyEndParts.join(' | ')}`);

  return lines.join('\n');
}
```

- [ ] **Step 2: TypeScript type-check**

Run: `npm run -w @wowarenalogs/tools build 2>&1 | grep -i "error\|TS[0-9]" | head -20`

Expected: No TypeScript errors.

- [ ] **Step 3: Run the print tool and verify output**

Run: `npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 1 2>/dev/null | grep -A 5 "MATCH END STATE"`

Expected output (exact values will vary):

```
MATCH END STATE
  Friendly: Holy Paladin (PlayerA): 95% HP | Windwalker Monk (PlayerB): dead at 1:23
  Enemy: Frost Mage (EnemyA): dead at 1:25 | Restoration Shaman (EnemyB): 78% HP
```

If no advanced log data is available for a player, HP will show as `? HP` — this is expected and correct.

- [ ] **Step 4: Commit**

```bash
git add packages/tools/src/printMatchPrompts.ts
git commit -m "feat(F96): add MATCH END STATE section to buildMatchPrompt

Shows HP of survivors and death timestamps for all players at match end,
mirroring the [MATCH END] block already present in buildMatchTimeline."
```

---

## Task 3: Mark F96 done in TRACKER.md

**Files:**

- Modify: `TRACKER.md`

- [ ] **Step 1: Update tracker row**

In `TRACKER.md`, change the F96 row from:

```markdown
| F96 | Backlog | Final state summary missing — add a match-end snapshot of survivors and enemy deaths to help Claude reason about the closing seconds. | `printMatchPrompts.ts` |
```

to:

```markdown
| F96 | ✅ Done | Final state summary missing — add a match-end snapshot of survivors and enemy deaths to help Claude reason about the closing seconds. | `printMatchPrompts.ts` |
```

- [ ] **Step 2: Commit**

```bash
git add TRACKER.md
git commit -m "chore: mark F96 done"
```

---

## Self-Review

**Spec coverage:** F96 asks for a match-end snapshot of survivors and enemy deaths. Task 2 adds exactly that to `buildMatchPrompt`. The new path (`buildMatchTimeline`) already has this via `[MATCH END]`. ✓

**Placeholder scan:** No placeholders. All code shown in full. ✓

**Type consistency:**

- `getHpPercentAtTime(u, durationSeconds, combat.startTime)` — `u` is `ICombatUnit`, `durationSeconds` is `number`, `combat.startTime` is `number` (ms). Matches the function signature `(enemy: ICombatUnit, atSeconds: number, matchStartMs: number): number | null`. ✓
- `friendlyDeaths` is already typed as `Array<{ spec: string; name: string; atSeconds: number; hpBeforeDeath?: ... }>` in `buildMatchPrompt`. The `.find` call uses `d.name` which is `string`. ✓
- `fmtTime(death.atSeconds)` — `atSeconds` is `number`. ✓
- `specToString(u.spec)` — `u.spec` is `CombatUnitSpec`. ✓

**Edge cases covered:**

- Player with no advanced actions → `getHpPercentAtTime` returns `null` → shown as `? HP`. No crash.
- Dead player → shown as `dead at T` via `friendlyDeaths.find`. ✓
- No deaths → all players show HP%. ✓
- No enemies (shouldn't happen in practice but guarded by existing `if (enemies.length === 0) return ''`). ✓

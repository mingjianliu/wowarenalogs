# F98: DTPS Baseline in buildMatchPrompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `INCOMING DAMAGE BASELINES` block to `buildMatchPrompt` so Claude can interpret damage-spike magnitudes against benchmark context.

**Architecture:** `buildMatchPromptNew` and the React component already call `formatDTPSBaselines` (from `specBaselines.ts`) to emit per-spec p50/p90 incoming-damage benchmarks. `buildMatchPrompt` (old "DECISION ANALYSIS REQUEST" path) already calls `formatSpecBaselines` for the owner but is missing the `formatDTPSBaselines` call for all friendly specs. Adding that one call (5 lines) after the existing `formatSpecBaselines` block closes the gap.

**Tech Stack:** TypeScript; `formatDTPSBaselines` and `benchmarks` already imported in `printMatchPrompts.ts`.

---

## Background

`buildMatchPrompt` shows damage pressure in lines like:

```
pressure during idle: 0:14 (0.84M on Resto Druid)
```

Without a baseline, Claude cannot tell whether `0.84M in 10s` is exceptional pressure or routine. The `INCOMING DAMAGE BASELINES` block from `formatDTPSBaselines` provides exactly that calibration:

```
INCOMING DAMAGE BASELINES (per 10s window, ≥2100 MMR):
  Resto Druid (n=312): p50 240k | p90 610k
```

`0.84M` is then clearly above p90 — signal Claude can use.

`formatDTPSBaselines` is already:

- Tested in `packages/shared/src/utils/__tests__/specBaselines.test.ts`
- Used in `buildMatchPromptNew` (line ~1004), `buildMatchPromptJson` (line ~1175), and the React component (`index.tsx` line ~217)

---

## File Map

| File                                      | Change                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/tools/src/printMatchPrompts.ts` | Add `formatDTPSBaselines` call in `buildMatchPrompt` after the existing `formatSpecBaselines` block |

No new files. No changes to `specBaselines.ts` or any test files — the function is already tested.

---

## Task 1: Add `formatDTPSBaselines` to `buildMatchPrompt`

**Files:**

- Modify: `packages/tools/src/printMatchPrompts.ts:709-713`

The existing block in `buildMatchPrompt` (around line 709):

```typescript
const baselineLines = formatSpecBaselines(ownerSpec, cooldowns, benchmarks);
if (baselineLines.length > 0) {
  lines.push('');
  baselineLines.forEach((l) => lines.push(l));
}

lines.push('');
lines.push(`COOLDOWN USAGE — LOG OWNER (${ownerSpec}) — major CDs ≥30s:`);
```

- [ ] **Step 1: Add the `formatDTPSBaselines` call immediately after the `formatSpecBaselines` block**

Insert between the `formatSpecBaselines` block and the `COOLDOWN USAGE` line:

```typescript
const dtpsBaselineLines = formatDTPSBaselines(
  friends.map((p) => specToString(p.spec)),
  benchmarks,
);
if (dtpsBaselineLines.length > 0) {
  lines.push('');
  dtpsBaselineLines.forEach((l) => lines.push(l));
}
```

The full updated section looks like:

```typescript
const baselineLines = formatSpecBaselines(ownerSpec, cooldowns, benchmarks);
if (baselineLines.length > 0) {
  lines.push('');
  baselineLines.forEach((l) => lines.push(l));
}

const dtpsBaselineLines = formatDTPSBaselines(
  friends.map((p) => specToString(p.spec)),
  benchmarks,
);
if (dtpsBaselineLines.length > 0) {
  lines.push('');
  dtpsBaselineLines.forEach((l) => lines.push(l));
}

lines.push('');
lines.push(`COOLDOWN USAGE — LOG OWNER (${ownerSpec}) — major CDs ≥30s:`);
```

`friends`, `specToString`, and `benchmarks` are all already in scope inside `buildMatchPrompt`. `formatDTPSBaselines` is already imported at line 79.

- [ ] **Step 2: TypeScript check**

Run: `npm run -w @wowarenalogs/tools build 2>&1 | grep -i "error\|TS[0-9]" | head -20`

Expected: No errors.

- [ ] **Step 3: Functional check**

Run: `npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 1 2>/dev/null | grep -A 4 "INCOMING DAMAGE BASELINES"`

Expected (values vary by spec):

```
INCOMING DAMAGE BASELINES (per 10s window, ≥2100 MMR):
  Resto Druid (n=312): p50 240k | p90 610k
  Windwalker Monk (n=289): p50 180k | p90 490k
```

If the benchmark data has no entry for the matched specs, the block is simply omitted — that is correct behavior.

- [ ] **Step 4: Commit**

```bash
git add packages/tools/src/printMatchPrompts.ts
git commit -m "feat(F98): add INCOMING DAMAGE BASELINES to buildMatchPrompt

Mirrors the formatDTPSBaselines call already present in buildMatchPromptNew
and the React component, so Claude can calibrate pressure-window magnitudes
against benchmark p50/p90 values in the old prompt path."
```

---

## Task 2: Mark F98 done in TRACKER.md

**Files:**

- Modify: `TRACKER.md`

- [ ] **Step 1: Update tracker row**

Change the F98 row from `Backlog` to `✅ Done`.

Before:

```
| F98  | Backlog | Baseline pressure-window context missing — damage spikes are shown but normal damage rate isn't. Add a `BASELINE` line to calibrate spike interpretation.
```

After:

```
| F98  | ✅ Done | Baseline pressure-window context missing — damage spikes are shown but normal damage rate isn't. Add a `BASELINE` line to calibrate spike interpretation.
```

- [ ] **Step 2: Commit**

```bash
git add TRACKER.md
git commit -m "chore: mark F98 done"
```

---

## Self-Review

**Spec coverage:** F98 asks for a `BASELINE` line to calibrate spike interpretation. The `INCOMING DAMAGE BASELINES` block from `formatDTPSBaselines` provides exactly that — per-spec p50/p90 per 10-second window. Task 1 adds the call. ✓

**Placeholder scan:** No placeholders. All code shown in full. ✓

**Type consistency:**

- `formatDTPSBaselines(friends.map((p) => specToString(p.spec)), benchmarks)` — `friends` is `ICombatUnit[]`, `specToString(p.spec)` returns `string`, `benchmarks` is `IBenchmarkData`. Matches the function signature `(friendlySpecs: string[], data: IBenchmarkData): string[]`. ✓
- `dtpsBaselineLines.forEach((l) => lines.push(l))` — `lines` is `string[]`, `l` is `string`. ✓

**Edge cases:**

- No benchmark data for the match's specs → `formatDTPSBaselines` returns `[]` → block is silently omitted. ✓ (guarded by `if (dtpsBaselineLines.length > 0)`)
- Single friendly (2v2 with one player) → one row in baselines. ✓

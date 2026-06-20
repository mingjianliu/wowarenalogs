# Design — C3: windowed lockout for "unused defensive at death"

**Date:** 2026-06-20
**Item:** C3 / H12 / M-e from `docs/analysis/2026-06-19-unfixed-bugs-handoff.md`
**Baseline:** local `main` @ `9924cb62` (post 4.A decompose; `[DEATH]` emission lives in `matchTimelineSections.ts`).

## Problem

Two death-coaching paths annotate whether a player "could have pressed a defensive" they had available, using `wasInHardCC(ccSummary, deathInstantSeconds)` — which checks CC **only at the exact death tick**:

- **Path A** — `[DEATH] … (Unused: X)` (`matchTimelineSections.ts:443-451`). Suppression: if `wasInHardCC(player, deathInstant)` → keep only `USABLE_WHILE_CC_SPELL_IDS`.
- **Path B** — "DEATHS WITH MISSED OPTIONS" (`deathOutcomeAnalysis.ts:228,261`). Annotates self-immunities + teammate externals with "was in CC" / "caster in CC".

A player stunned through the lethal burst but **free at the exact death tick** is wrongly told they should have pressed a defensive (false coaching); the inverse (free during the burst, stunned only at the tick) is wrongly excused.

## Decisions (resolved in brainstorming)

| Decision       | Choice                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Window         | **Pre-death window**, `LETHAL_WINDOW_SECONDS = 5`s                                                                                     |
| CC model       | **Uniform** — any non-trinketed CC instance counts; CC type not distinguished (silence treated like stun)                              |
| Whitelist      | **Unchanged** — `USABLE_WHILE_CC_SPELL_IDS` stays as-is (Pain Suppression confirmed usable-while-stunned by the WoW-expert maintainer) |
| Free-gap floor | `MIN_FREE_GAP_SECONDS = 1`s — a contiguous free moment ≥ 1s means they could have pressed something                                    |

**Known, accepted simplification:** because the model is uniform, a _silence_ (which only blocks magic) is treated like a stun. So a magic defensive (e.g. Pain Supp) is counted as "pressable while CC'd" even under a silence that would really block it. Accepted for simplicity; revisit only if it proves misleading.

## Design

### New helper — `wasLockedOutThroughWindow`

In `packages/shared/src/utils/deathOutcomeAnalysis.ts`, replacing the role of `wasInHardCC` at the three call sites:

```ts
export const LETHAL_WINDOW_SECONDS = 5;
export const MIN_FREE_GAP_SECONDS = 1;

// True only if the player had NO contiguous free moment (>= MIN_FREE_GAP_SECONDS)
// in the [death - LETHAL_WINDOW_SECONDS, death] window to press a non-whitelisted
// defensive — i.e. they were effectively locked out for the whole lethal window.
export function wasLockedOutThroughWindow(
  ccSummary: Pick<IPlayerCCTrinketSummary, 'playerName' | 'ccInstances'>,
  deathSeconds: number,
  windowSeconds = LETHAL_WINDOW_SECONDS,
): boolean;
```

**Algorithm:**

1. `windowStart = Math.max(0, deathSeconds - windowSeconds)`; `windowEnd = deathSeconds`.
2. From `ccInstances`, take instances with `trinketState !== 'used'` (a CC they trinketed out of did not lock them out — matches current `wasInHardCC` semantics). Map to intervals `[atSeconds, atSeconds + durationSeconds]`, clipped to `[windowStart, windowEnd]`, dropping non-overlapping ones.
3. Sort by start, merge overlaps, and compute the **longest uncovered (free) sub-interval** of the window — including the leading gap (`windowStart → first CC start`) and trailing gap (`last CC end → windowEnd`).
4. Return `maxFreeGap < MIN_FREE_GAP_SECONDS` (locked out).

**Edge cases:** no overlapping CC → free gap = full window (≥1s) → `false` (not locked out). Death within the first `windowSeconds` of the match → window clamps to `[0, death]`. Empty `ccInstances` → `false`.

### Call-site changes (behavior unified)

- `matchTimelineSections.ts:443` — `const isTeammateInCC = wasInHardCC(summary, death.atSeconds)` → `const isLockedOut = wasLockedOutThroughWindow(summary, death.atSeconds)`. The downstream filter `!isLockedOut || USABLE_WHILE_CC_SPELL_IDS.has(cd.spellId)` is unchanged.
- `deathOutcomeAnalysis.ts:228` (`wasInCC`) and `:261` (`casterWasInCC`) — swap to `wasLockedOutThroughWindow(…, atSeconds)`. The "was in CC" / "caster in CC" wording is unchanged but now means "locked out through the lethal window."
- The separate **silence/interrupt lockout** check (`deathOutcomeAnalysis.ts:224`, `isLockedOutAt` on `spell.lockoutSpellId`) is **left as-is** — it covers interrupt-lockouts, orthogonal to CC coverage.
- `wasInHardCC` is **removed** — it has no remaining callers (all three swap to the windowed helper, verified) and its `trinketState !== 'used'` semantics fold into the new helper. Drop the export and any now-dead usages.

### Data flow

No new inputs. Both paths already receive `ccSummaries` / `ccTrinketSummaries` carrying `ccInstances` (each with `atSeconds`, `durationSeconds`, `trinketState`). The window math is pure arithmetic on those.

### Constants & tuning

`LETHAL_WINDOW_SECONDS` and `MIN_FREE_GAP_SECONDS` are named, exported, and commented as tunable. 5s covers a typical arena burst; 1s is the realistic floor to squeeze in a defensive.

## Testing (TDD)

New `wasLockedOutThroughWindow` unit tests (the function currently has none):

1. **Headline fix** — CC covering `[death−5, death−0.2]` but free at the death tick → **locked out = true** (old `wasInHardCC` at the tick returned false).
2. **Free gap** — a ≥1s uncovered gap mid-window (e.g. two short stuns with a 2s gap) → **false** (could have pressed).
3. **Fully covered** — overlapping CCs spanning the whole window → **true**.
4. **No CC** → **false**.
5. **Trinketed-out CC** (`trinketState === 'used'`) ignored → **false**.
6. **Sub-window death** (death at 3s, window clamps to `[0,3]`) → correct.

Integration:

- `deathOutcomeAnalysis` test: a player CC'd through the window but free at the tick → annotation reads "was in CC" (was "was not CC'd").
- `timeline.test.ts` `[DEATH] (Unused:)`: same scenario → non-whitelist CD dropped from `(Unused:)`; a whitelist CD (e.g. Barkskin) still listed even when locked out.

Run from `packages/shared`: `npx tsdx test deathOutcome timeline --no-cache` (always `--no-cache`), then the full shared suite.

## Out of scope

- Splitting silence from hard-control (the school-aware model) — deferred by the uniform-model decision.
- Per-defensive castability flags.
- The other handoff items (H11, H13, M-a, etc.).

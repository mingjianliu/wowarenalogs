# Handoff — Unfixed items from the 4-day prompt review

**Date:** 2026-06-19
**Baseline:** `origin/main` @ `2aa917fa` (14 review fixes already landed — see below).
**Companion docs (full findings):** `docs/analysis/2026-06-18-4day-prompt-feature-review.md` (executive) and `...-review-detailed.md` (every finding, all severities, + verification ledger). Those are the source of the IDs (C-/H-/M-) used here.

## What is already fixed (context, do not redo)

14 commits on `origin/main`, each TDD'd, full shared suite green (731 passing):

C4 (Fade≠CC-avoid), H6 (cleanse ≤50ms), H7 (Stasis partial release), C2 (cheaper-available throughput exclusion), M2 (system-prompt legend), H9 (no velocity on enemy-targeted CDs), H1 (Δ delimiter), C1 (channel "channeled X of Y" not "interrupted"), H4 (spellSchools wiring confirmed + guard), H3 (drop Unknown-DR from outgoing chains), H14+M-g (Druid forms ≠ ground-CC dodge; factual phrasing), H10 (`focus:` own field), M-h (Ursol's Vortex DR), M-i (F159 cross-attach).

---

## Status table

> **Update 2026-06-20:** every higher-value item is now fixed and on `origin/main` (latest `a919afa4`). Only low-value / build-concern items remain open.

| ID                 | Sev      | Area                              | Status                                                                                                   |
| ------------------ | -------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **C3 / H12 / M-e** | 🔴/🟠    | B12 hard-CC suppression           | ✅ **DONE** — windowed lockout (`wasLockedOutThroughWindow`, 5s/1s); spec+plan+SDD. `fad69b61..452262a7` |
| **H11 / M-f**      | 🟠       | "cheaper available" target gating | ✅ **DONE** — gated on codegen `externalDefensiveSpellIds` (no new list). `a919afa4`                     |
| **H13**            | 🟠       | Positive "interrupted" label      | ✅ **DONE** — labels `(interrupted at X/Y)` only when a real kick/CC hit the caster. `5f90de5c`          |
| **M1**             | 🟠(meta) | Eval harness ≠ production prompt  | ✅ **DONE** — `buildMatchContext` extracted React-free; tool now calls it. `78002967`, `1eee4efc`        |
| **H2**             | 🟠       | Overlap Ratio num/denom mismatch  | ✅ **DONE via M1** — the divergent eval-only `computeHealerMetrics` block is gone from the tool.         |
| **H5**             | 🟠       | Dispel-summary header unfiltered  | ✅ **DONE via M1** — the tool no longer assembles its own header.                                        |
| **M-d**            | 🟡       | Overlap double-count              | ✅ **DONE via M1** — overlap ratio no longer ships in the prompt.                                        |
| **M-a**            | 🟡       | HP-velocity stale `0%/s`          | ⬜ OPEN — `matchTimeline.ts`. Low impact (HP snapshots ride with damage).                                |
| **M-b**            | 🟡       | Channel "completed" mis-pairing   | ⬜ OPEN — `timelineHelpers.ts`. Low priority after C1.                                                   |
| **H8 / M-k**       | 🟠       | `spellNames.json` 13 MB bundle    | ⬜ OPEN — `spellEffectData.ts`, `generateSpellIdLists.ts`. Build/bundle, not a prompt fix.               |
| Lows (≈12)         | ⚪       | misc                              | ⬜ OPEN — cosmetic / low value; none ship false data.                                                    |

---

## 1. Needs a decision before fixing

### ✅ DONE — C3 / H12 / M-e — B12 "unused defensive at death" is over-suppressed

> **Resolved 2026-06-20** (`fad69b61..452262a7`): chose a windowed lockout (`wasLockedOutThroughWindow`, 5s window / 1s free-gap, uniform CC model). Whitelist kept unchanged (Pain Supp confirmed usable-while-stunned). Both death paths unified; `wasInHardCC` removed. Spec + plan + subagent-driven TDD. The "decision needed" below is what was answered.

**Where:** `deathOutcomeAnalysis.ts:186-192` (`wasInHardCC`), `cooldowns.ts:36-43` (`USABLE_WHILE_CC_SPELL_IDS`), suppression at `matchTimeline.ts:618-625`.

**Problem (3 parts):**

1. `wasInHardCC` returns true for **any** `ccInstance` whose `trinketState !== 'used'`, and `ccInstances` is built from all `type==='cc'` spells (disorient, fear, cyclone, poly, silence **and** stun, undifferentiated). So a teammate who was merely Disoriented/Cyclone'd at death suppresses the "unused defensive" finding.
2. It samples CC only at the **exact death instant**, not the lethal window before death.
3. `USABLE_WHILE_CC_SPELL_IDS` lists **Pain Suppression (33206)** as usable-while-CC — false while the caster is stunned/silenced.

**Why it's not a blind fix:** the review framed (1) as a clear bug, but it is genuinely debatable — a feared/sheeped teammate cannot cast most defensives, so suppressing there may be **correct**. Getting (1) and (3) right is a WoW-mechanics judgment.

**Decision needed (please specify):**

- Which CC categories count as "hard CC" for this suppression? (e.g. _only_ Stun + Silence + Horror? or also Incapacitate/Disorient?) Recommend keying off the DR category (`drInfo.category`) rather than "any cc".
- The correct **usable-while-CC** set (is Pain Suppression in or out? add trinket / Will of the Forsaken / off-GCD instants?).
- The pre-death window to check (recommend last ~3–5 s, not the death tick).

**Then (TDD):** failing test where a teammate was only Disoriented (or freed before death) → the "unused defensive" finding is NOT suppressed; a teammate truly stun-locked through the lethal window → IS suppressed. Add `wasInHardCC` unit tests (currently none).

### ✅ DONE — H11 / M-f — "cheaper available" still suggests unreachable tools

> **Resolved 2026-06-20** (`a919afa4`): no new list needed — gated on the codegen `externalDefensiveSpellIds` set. When the annotated cast targeted a teammate, only externals are suggested as "cheaper". (Tree-of-Life throughput sub-case left as a Low.)

**Where:** `cooldowns.ts` `findCheaperDefensiveAlternatives` (added in C2), wired at `matchTimeline.ts:~810`.

**Problem:** C2 removed throughput CDs (Power Infusion) from the suggestions, but two cases remain:

1. It still offers **self-only** tools (Barkskin, Frenzied Regen) when the annotated cast was an **external** on a teammate (e.g. `Ironbark → 3 (23% HP) | cheaper available: Barkskin, Frenzied Regeneration` — Barkskin can't help teammate 3).
2. It ignores **form-gating** (Frenzied Regen offered while in Tree form) and **Incarnation: Tree of Life** (tagged `[Defensive]` only, so the `isThroughput` flag doesn't catch it though it's a throughput CD).

**Why it's not a blind fix:** requires a curated **self-only vs external** classification (and a survival-vs-throughput set for Tree) — a hardcoded, seasonal-maintenance list, which the project generally avoids.

**Decision needed:** approve building `SELF_ONLY_DEFENSIVE_IDS` / `EXTERNAL_DEFENSIVE_IDS` sets (and add Tree-of-Life to a throughput exclusion), or leave as-is. If approved, the helper is already pure + tested, so this is a clean TDD extension: pass the cast's target to the helper and exclude self-only tools when the cast targeted a teammate.

---

## 2. Deferred — enhancements / low real-world impact

### ✅ DONE — H13 — positively label _confirmed_ interrupts

> **Resolved 2026-06-20** (`5f90de5c`): added `channelWasInterrupted` (kick/CC on the caster within the channel window); early-ended channels now read `(interrupted at X/Y)` only when confirmed, else keep `(channeled X/Y)`. Legend updated.

**Where:** `matchTimeline.ts:~824-840` (channel classification), `timelineHelpers.ts` (`extractOwnerCDBuffExpiry`).
C1 already removed the harm (false "interrupted" → neutral `(channeled X of Y)`). H13 is the _positive_ follow-up: when a real `SPELL_INTERRUPT` or a CC application lands on the **caster** during `[castStart, channelEnd]`, label it `(interrupted at X / Y)`; otherwise keep `(channeled X of Y)`.
**TDD:** fixture with an interrupt on the caster mid-channel → "interrupted"; without → "channeled X of Y". Needs the owner's interrupt/CC events threaded into the channel-classification scope.

### M-a — HP-velocity can read a stale `0%/s`

**Where:** `matchTimeline.ts` `getCDTargetAndVelocityPart` (the `getHpPercentAtTime(...)` calls at `~430-431`).
`getHpPercentAtTime` returns the last advanced-action HP at-or-before the time with **no staleness bound**; if the target had no HP update in the 2 s window, both samples are identical → false `0%/s`. Fix: reuse the 2 s-bounded `getUnitHpAtTimestamp` (as the `[DMG SPIKE]` slope does) so a stale reading returns null → emit only `… DPS`, no `%/s`.
**Note:** real impact is probably small — HP snapshots are emitted on damage/heal events, so a stale window usually means genuinely no damage (`0%/s` is then ~correct). Belt-and-suspenders.

### M-b — channel "completed" pairing

**Where:** `timelineHelpers.ts:296-315` (`extractOwnerCDBuffExpiry`).
"completed" relies on the chronologically-next aura removal, which can mis-pair across overlapping casts. Bound the pairing to `castMs + expectedDuration + ε`. Lower priority after C1.

---

## 3. Not addressable by TDD (build / process / eval-only)

### H8 / M-k — `spellNames.json` is 13 MB in the web bundle

**Where:** static `import` at `spellEffectData.ts:24`; pretty-printed at `generateSpellIdLists.ts:253`.
The full 13 MB JSON (pretty-printed, ~2× size) is statically imported by a module that client components pull, so it lands in the web bundle untree-shaken. **Not a unit test** — it's a bundle-size/build concern.
**Fix direction:** (a) emit minified (`JSON.stringify(map)` — one-line generator change, needs a 13 MB regen via `start:generateSpellIdLists`, which hits wago.tools); (b) filter the map to spell IDs actually referenced; or (c) lazy / server-side load. **Guard to add:** a CI bundle-size check, not a jest test.

### ✅ DONE — M1 — the evaluation harness is NOT the production prompt

> **Resolved 2026-06-20** (`78002967`, `1eee4efc`): extracted `buildMatchContext` into a React-free module (production byte-identical) and pointed `printMatchPrompts` at it; added an optional `owner` override to preserve `--healer`. The tool's divergent reimplementation is gone — smoke-tested, zero divergent lines. **This cleared H2, H5, and M-d** (below) since they only existed in that reimplementation.

**Where:** `printMatchPrompts.ts:831-857` (`buildMatchPromptNew`) vs `CombatAIAnalysis/index.tsx` (`buildMatchContext`).
The tool injects a `<metadata>` block (`Healer Performance`, `Technical Stats: Overlap Ratio | Effective Cast | CC Avoidance` via `computeHealerMetrics`) that production **never** emits. So the eval corpus diverges from the shipped prompt — this is the root cause of why several "findings" (H2, H5, the spellSchools-0-tags scare in H4) were eval-only artifacts.
**Fix direction (structural):** make `printMatchPrompts` call the real `buildMatchContext` (or delete the divergent metadata block). **Guard:** a test asserting harness output == production assembly for the shared timeline sections. This single fix subsumes H2, H5, M-d.
**Also memorialized in:** memory `project_prompt_eval_harness_divergence`.

### ✅ DONE (via M1) — H2 — Overlap Ratio not bounded ≤ 1 (eval-only)

`healerMetrics.ts:106-112`: numerator counts overlaps over `ALL_MAJOR_DEFENSIVE_IDS`, denominator over the narrower `MAJOR_DEFENSIVE_IDS`. Ratio can exceed 1; `Overlap Ratio: 0.00` is ambiguous. **Only reaches the eval tool**, not production. Fix: use one ID set for both (or `Math.min(1, …)`). TDD-able but low value until M1.

### ✅ DONE (via M1) — H5 — dispel-summary header unfiltered (eval-only)

`printMatchPrompts.ts:866-872`: the tool's `<purge_responsibility>` header counts **all-priority** purges (e.g. `31 total purges/spellsteals (8x Moonkin Aura, …)`), contradicting the F163-filtered timeline. **Production uses `formatDispelContextForAI`, not this header.** Subsumed by M1.

### ✅ DONE (via M1) — M-d — overlap double-count (eval-only)

`cooldowns.ts:1015-1046`: one healer cast overlapping N teammates contributes N to the overlap count. Feeds the eval-only overlap ratio. Dedup overlaps per (caster, cast).

---

## 4. Lows (cosmetic / low value)

Full list in `...-review-detailed.md` (the "Low" section). Examples: `±0%/s` sign noise (`matchTimeline.ts:445-447`); DPS divisor fixed `/2` pre-match (`:442`); `next spike` finds any friendly not the owner (`:799`); `Top sources` not min-damage gated (`:1306-1316`); death-trajectory plateau artifacts; B21 drops a distinct same-name cast without a count; the skipped atonement Δ test (`timeline.test.ts:3998`); dampening recomputed per cast; F163 hardcoded priority strings ×3; the misleading B11 comment. None ship false data; batch them opportunistically.

---

## How to pick this up

- Work in a worktree off `origin/main` (current fix branch: `.worktrees/fix/prompt-review-findings`, already at `2aa917fa`).
- TDD discipline (each fix in the 14 above followed it): failing test first → minimal fix → green → full suite.
- Test command (from `packages/shared`): `npx tsdx test <pattern> --no-cache` — **always `--no-cache`**; the jest cache here gets poisoned and shows phantom `downlevelIteration` errors otherwise.
- Pre-commit hook runs lint + typecheck across all workspaces (~60 s) and may reformat; on a prettier failure run `npx eslint --fix <file>`, re-test, recommit. Never `--no-verify`.
- Commit trailers used in this work:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01C1AuTEjpzDkjww3VF8fEDG
  ```

**Status 2026-06-20:** all higher-value items are done and on `origin/main` (latest `a919afa4`) — C3, H11, H13, M1 (+ H2/H5/M-d via M1). Remaining: **M-a**, **M-b** (low impact), **H8/M-k** (13 MB bundle — build concern), and the **~12 Lows** (cosmetic). None ship false data.

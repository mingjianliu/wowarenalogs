# Efficiency & Refactor Audit: WoW Arena Logs

**Date:** 2026-06-18 (implemented 2026-06-20)  
**Status:** Implemented — §1–3 done, §4.A done, §4.B intentionally skipped (YAGNI). See status table.  
**Focus:** Parser Performance, Analysis Algorithmic Efficiency, and Memory Churn.

---

## Executive Summary

The WoW Arena Logs platform handles massive volumes of combat data. While the current implementation is robust, several "hot paths" contain $O(N)$ or $O(N^2)$ bottlenecks that scale poorly with match duration and log size. The most significant gains can be found in the **Parser (string/JSON overhead)** and the **Analysis Layer (temporal lookups)**.

---

## Implementation Status (2026-06-20)

Behavior-preserving throughout — shared suite **757 passed**, parser suite **74 passed**.

| #   | Item                                | Status               | Where / note                                                                                                                                                                            |
| :-- | :---------------------------------- | :------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.A | Eliminate `JSON.parse` churn        | ✅ Done              | `e6414c28` — single-pass `parseToken` tokenizer; 0 `JSON.parse` refs                                                                                                                    |
| 1.B | High-speed timestamp parsing        | ✅ Done              | `e6414c28` — manual `slice`/`Date.UTC` on the offset hot path; `moment.tz` retained **only** for the legacy no-offset DST fallback (correct)                                            |
| 1.C | Skip version regex once known       | ✅ Done              | `e6414c28` — `COMBAT_LOG_VERSION` short-circuit                                                                                                                                         |
| 2.A | Binary search for HP/mana           | ✅ Done              | `ff916a2a` — `binarySearchClosest` in `getUnitHp/ManaAtTimestamp`                                                                                                                       |
| 2.B | Memoized static maps                | ✅ N/A               | `SPELL_ID_TO_CLASS_MAP` is already a module-level `const` (built once at import); the "on instantiation" premise was outdated                                                           |
| 3.A | Sweep-line / bucketing rot pressure | ✅ Done              | `ff916a2a` — `dotCounts` bucketing, O(DoTs)+O(Duration)                                                                                                                                 |
| 3.B | Remove redundant sorts              | ✅ Done              | `ff916a2a` — the 2 truly-redundant sorts removed; the rest are **necessary** (merged multi-source, different sort keys, or final chronological assembly)                                |
| 4.A | Decompose `matchTimeline` god-fn    | ✅ Done (first pass) | `59c6b12d` — 5 sections → `matchTimelineSections.ts`; `buildMatchTimeline` 1,833 → 1,476 lines. Stateful `[RES]`/`[STATE]`/assembly blocks left in place (high-risk, no clean boundary) |
| 4.B | Unified DR lookup table             | ⬜ Skipped (YAGNI)   | `getDRLevelAtTime` is not a hot path and is absent from the priority matrix below. Revisit only if DR lookups become a measured bottleneck                                              |

---

## 1. Parser Optimizations (High Impact / High Effort)

The parser is the "bottleneck of bottlenecks." Every millisecond saved here is multiplied by millions of lines.

### A. Eliminate `JSON.parse` Churn

- **Current**: `jsonparse.ts` slices parameters, re-escapes them, joins them into a JSON string, and calls `JSON.parse()`. This causes massive string re-allocation and garbage collection (GC) pressure.
- **Opportunity**: Implement a single-pass tokenizing parser.
- **Target**: `packages/parser/src/jsonparse.ts`
- **Proposed Logic**:
  ```typescript
  // Instead of re-formatting for JSON.parse:
  function parseLogParameters(payload: string): (string | number)[] {
    // Use a manual scanner that respects quotes and brackets
    // and returns the array directly.
  }
  ```

### B. High-Speed Timestamp Parsing

- **Current**: Uses `moment.tz` and a regex for every line.
- **Opportunity**: Combat log timestamps are fixed-length (`MM/DD HH:mm:ss.SSS`). Use manual `slice` and `parseInt` to construct a Unix timestamp.
- **Impact**: Up to 10x faster than `moment` for timestamp resolution.

### C. Redundant Version Detection

- **Current**: `WoWCombatLogParser.parseLine` runs a complex regex on every line to find `COMBAT_LOG_VERSION`.
- **Opportunity**: Set a `versionDetected` flag. Stop running the version regex once the version is confirmed.

---

## 2. Analysis & Utilities (High Impact / Med Effort)

These utilities are called thousands of times during the generation of a single AI coaching prompt.

### A. Binary Search for Advanced Actions

- **Current**: `getUnitHpAtTimestamp` and `getUnitManaAtTimestamp` perform a linear scan over all `advancedActions` ($O(N)$).
- **Opportunity**: Since these actions are chronologically sorted, use **Binary Search** ($O(\log N)$).
- **Target**: `packages/shared/src/utils/cooldowns.ts`
- **Impact**: Reduces AI prompt generation time for long matches from seconds to milliseconds.

### B. Memoized Static Maps

- **Current**: Maps like `SPELL_ID_TO_CLASS_MAP` in `CombatGenerator.ts` are flatMapped from `classMetadata` on instantiation.
- **Opportunity**: Move these to a static singleton or a pre-computed constant file to avoid repeated construction.

---

## 3. Timeline Generation (Med Impact / Med Effort)

### A. Sweep-Line for Rot Pressure

- **Current**: The "Rot Pressure" detector in `matchTimeline.ts` iterates every second of the match and filters all DoT intervals. This is $O(\text{Duration} \times \text{DoTs})$.
- **Opportunity**: Use a sweep-line algorithm. Sort DoT start/end events. You only need to update the "active DoT count" when a DoT state changes, significantly reducing the number of checks.

### B. Redundant Sorting

- **Current**: Many analysis functions (e.g., `extractPlayerDotIntervals`) call `[...events].sort()` before processing.
- **Opportunity**: The parser emits events in order. The `CombatUnit` arrays should ideally be treated as "append-only sorted." Explicitly verify this order at the parser level and remove downstream $O(N \log N)$ sorting.

---

## 4. Architectural Refactoring (Maintenance)

### A. "Analyzer" Pattern for `matchTimeline.ts`

- **Current**: `matchTimeline.ts` is a 1700+ line "God Function" that handles dozens of disparate analysis tasks.
- **Opportunity**: Decompose into isolated `Analyzers` (e.g., `DeathAnalyzer`, `CCChainAnalyzer`). This improves testability and allows for parallelizing parts of the analysis pipeline.

### B. DR (Diminishing Returns) Lookup Table

- **Current**: DR calculations are often re-computed or filtered on the fly.
- **Opportunity**: Build a unified DR lookup table during the first pass of the match to allow $O(1)$ lookups for "What was the DR status of Unit X for Category Y at time Z?".

---

## Priority & Effort Matrix

| Opportunity                      | Impact | Effort | Priority     |
| :------------------------------- | :----- | :----- | :----------- |
| **Binary Search for HP/Mana**    | High   | Low    | **Critical** |
| **Bypass Version Regex**         | Med    | Low    | **High**     |
| **Parser Timestamp Slicing**     | High   | Med    | **High**     |
| **Decompose `matchTimeline.ts`** | Med    | High   | **Medium**   |
| **Custom Tokenizer (No JSON)**   | High   | High   | **Medium**   |
| **Sweep-Line for Rot Pressure**  | Med    | Med    | **Medium**   |

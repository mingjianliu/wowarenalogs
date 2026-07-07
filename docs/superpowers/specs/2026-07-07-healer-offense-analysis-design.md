# Healer Offense Analysis (V1, slack-gated) — Design

**Date:** 2026-07-07
**Branch:** `offense-analysis`
**Status:** Approved design, pending implementation plan

## Problem

The coaching product is heavily defense-oriented: the system prompt's core worldview is
"resource optimization for survival" (panic press, Early/Optimal/Late/Reactive timing,
healing gaps, CC/trinket/DR tracking, proactive-spend leaks). Offense coverage exists but
only at the tail end of the kill chain: `offensiveWindows.ts` (F14, did the team
capitalize), `killWindowTargetSelection.ts` (F25, was the right target chosen),
`offensiveWasteAnalysis.ts` (CDs into immunities), and F21 missed purges.

Missing: the **healer's own offensive contribution** — creating windows (CC on the enemy
healer), stacking into windows (CC/kicks/damage while the team pushes), and using free
time productively. Offense for a healer is not a mirror of defense; the analysis unit is
"was a kill window created / stacked / converted", gated on whether contributing cost
anything defensively.

## Scope decisions (made during brainstorming)

1. **Perspective:** the log-owner healer's offensive contribution ([YOU] view). Not
   team-wide offense analysis, not a DPS product line.
2. **Signals (all four in V1):** kill-window CC contribution; slack-segment utilization
   (damage/kicks); purge/kill-window alignment; window-creation opportunities.
3. **Priority model:** phased. **V1 is slack-gated** — an offensive finding is valid only
   when it carried zero defensive cost ("free value left on the table"). V2 (out of
   scope) upgrades to bidirectional trade evaluation ("one more sheep vs one more second
   of healing"); V1's fact-line design must not preclude it.
4. **Facts, not verdicts:** per standing project principle, deterministic code emits
   causal facts; the LLM reasons to conclusions. No hardcoded "you were wrong" outputs.

## 1. Core concept: Healing Slack

The gate for every offensive finding. A time segment is **slack** iff all of:

- Every friendly player HP ≥ 85% (via `getHpPercentAtTime`). If advanced logging is
  absent (no HP data), the slack signal — and everything gated on it — is **disabled
  entirely** for that match. No degraded guessing.
- No enemy offensive CD active (from `enemyCDs.ts` timeline).
- Log owner not in CC, and not within 3s after using a mobility/escape tool
  (identified via existing `SpellTag` movement/escape tags in spell metadata — no new
  hardcoded spell lists).
- Segment length ≥ 4 seconds (≥ 2–3 GCDs).

Output `ISlackSegment[]`: start/end seconds plus what the owner actually did in the
segment (damage dealt, CC casts, purge casts, kicks, or nothing).

## 2. New module: `packages/shared/src/utils/healerOffenseAnalysis.ts`

Single entry point:

```ts
buildHealerOffenseSummary(
  combat: AtomicArenaCombat,
  logOwner: ICombatUnit,
  friends: ICombatUnit[],
  enemies: ICombatUnit[],
  offensiveWindows: IOffensiveWindow[],
): IHealerOffenseSummary

interface IHealerOffenseSummary {
  slackSegments: ISlackSegment[];             // signal 2 substrate
  windowContributions: IWindowContribution[]; // signals 1+2 per kill window
  windowCreationFacts: IWindowCreationFact[]; // signal 4
  advancedLoggingAvailable: boolean;          // false → all arrays empty
}
```

Plus `formatHealerOffenseForContext(summary): string[]` emitting a `<healer_offense>`
block, style-matched to existing formatters (`fmtTime`, one fact per line).

Reused APIs (all existing, no parser changes):
`getDRLevelAtTime` / `analyzeOutgoingCCChains` (drAnalysis), cast-history CD replay and
PvP-trinket tracking (pattern from killWindowTargetSelection), `getHpPercentAtTime`,
enemy CD timeline (enemyCDs), `canOffensivePurge` (dispelAnalysis).

## 3. Signal rules

### Signal 1 — CC contribution inside kill windows

For each `IOffensiveWindow`: was one of the owner's hard-CC spells off cooldown (cast
history replay), what was the enemy healer's DR level at that moment
(`getDRLevelAtTime`), did the owner cast CC in the window, and was the owner free (not
CC'd, team HP state). Emit fact lines only, e.g.:

```
0:42–0:53 kill window on DK: your Polymorph ready, enemy healer DR: Full,
you did not cast CC (you were free, team HP 92%)
```

### Signal 2 — Slack-segment utilization

Per slack segment, report actual output. Zero-output segments ≥ 6s are surfaced as
priority fact lines. Shorter or productive segments summarized in aggregate (one line:
total slack seconds, % with any offensive output).

### Signal 3 — Purge / kill-window alignment

`dispelAnalysis.ts` gains one field: `IMissedPurgeWindow.duringKillWindow: boolean`
(interval intersection with `offensiveWindows`). `formatDispelContextForAI` escalates
in-window missed purges to Critical wording. **Only change to an existing calibrated
file; guarded by regression tests.**

### Signal 4 — Window-creation opportunities

A fact line when: slack segment ∩ owner's opener CC ready ∩ enemy healer DR level is
Full ∩ enemy healer trinket spent/on-CD ∩ no friendly kill window already in progress.
Cap at **2 per match** (longest slack segments win) to control noise. Lines carry
"opportunity, not a verdict" semantics; the LLM weighs them against the timeline.

## 4. Integration & prompts

- `buildMatchContext.ts`: append `<healer_offense>` block after the existing offensive
  sections, behind a local feature flag (easy A/B on/off).
- System prompts: add a short slack-gated offense rubric section to **both** prod
  (`FINDINGS_JSON_SYSTEM_PROMPT`) and harness (`NEW_SYSTEM_PROMPT`) — the two paths are
  divergent and must be ported separately. Rubric essence: an offensive finding is valid
  only at zero defensive cost; data lines are facts to cross-check against the timeline,
  not pre-made conclusions; never penalize the healer for healing while teammates were
  in danger. This is **free-value analysis**.

## 5. Testing & eval

- Full unit coverage for the new util (tsdx test): synthetic slack/no-slack fixtures,
  DR full vs decayed, missing advanced logging → disabled path, window intersection
  edge cases.
- `regression-gate` (annotation regression) after the dispelAnalysis change and prompt
  edits.
- `improve-healer-prompts` A/B: control = current prompt/context; treatment =
  `<healer_offense>` + rubric. Acceptance: defensive scores do not regress; offensive
  findings cite evidence that `claimChecker` can verify.
- Eval runs recorded in `docs/eval-ledger.md` as usual. Eval-integrity rules apply
  (no fabricated scores; partial honest data over complete fabricated data).

## 6. V2 reserved (out of scope)

Bidirectional trade evaluation (sheep vs heal expected value) requires only rubric
wording changes and a relaxed slack gate; the V1 fact-line schema already carries the
data (HP state, DR, CD readiness) needed for it. No data-layer rework anticipated.

## Non-goals

- Team-wide / DPS-perspective offense coaching.
- Any parser (`@wowarenalogs/parser`) changes.
- Comp-specific heuristics (e.g. "as RMP you must open with X") — facts only.
- Counterfactual damage simulation ("this would have killed") — the LLM may qualitatively
  reason, but no numeric fabrication (impactDelta rules unchanged).

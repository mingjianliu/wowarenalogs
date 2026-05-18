# Healer Prompt Improvement & A/B Testing Pipeline — Design Spec

**Date:** 2026-05-17
**Status:** Approved

---

## Goals

Close the feedback loop that `/eval-healer-prompts` opens. The eval skill identifies what to fix; this skill validates whether a fix actually worked and decides whether to adopt or abandon it.

**Not a goal:** automating the code change itself, auto-editing the eval rubric, or running without human judgment at the adopt/abandon step.

---

## Two-Skill System

```
/eval-healer-prompts          →  "what should we fix?" (existing)
/improve-healer-prompts       →  "did we fix it?"      (new)
```

The two skills have a clean handoff: the eval report produces recommendations; the human picks one, implements it, then hands it to the improve skill for validation. The improve skill's final report feeds back into the next eval cycle.

---

## Skill: `/improve-healer-prompts`

**Invocations:**

| Command                           | Behavior                                       |
| --------------------------------- | ---------------------------------------------- |
| `/improve-healer-prompts`         | Auto-detect phase from state, advance one step |
| `/improve-healer-prompts adopt`   | Conclude cycle, keep the change                |
| `/improve-healer-prompts abandon` | Conclude cycle, revert the change              |

No other arguments. Phase detection is automatic.

---

## State Machine

State is persisted in `ab-test/state.json`. The skill reads state on every invocation and executes the appropriate phase.

```
idle / no state  →  [run skill]            →  control-ready
control-ready    →  [implement, run skill] →  treatment-ready
treatment-ready  →  [fix-now, run skill]   →  treatment-ready (new iteration)
treatment-ready  →  [adopt|abandon]        →  idle (cleanup complete)
```

`state.json` shape:
```json
{
  "phase": "control-ready",
  "matchIds": ["abc123", "def456"],
  "controlRunDate": "2026-05-17",
  "treatmentRuns": 1,
  "targetDimension": "inferenceScaffolding",
  "changeDescription": "added KILL SEQUENCE block for matches < 90s (F113)"
}
```

`changeDescription` and `targetDimension` are provided by the user at the start of Phase 1 (the skill asks before fetching matches).

---

## Data Layout

All outputs are gitignored. Extends the existing `healer-eval/` directory.

```
packages/tools/local-batch/healer-eval/
  raw-logs/                        ← new: deleted on conclude
    <matchId>.log
  ab-test/                         ← new: isolated from regular eval outputs
    state.json
    control/
      index.json
      prompts/
      responses/
      scores/
      eval-report.md
    treatment/
      index.json
      prompts/
      responses/
      scores/
      eval-report.md
    comparison-report.md
```

---

## Phase 1 — Control (idle → control-ready)

**Triggered by:** `/improve-healer-prompts` with no state file or phase = `idle`.

1. Ask the user:
   - "What change are you testing?" (e.g., "added KILL SEQUENCE block for matches < 90s")
   - "Which eval dimension is this intended to improve?" (e.g., `inferenceScaffolding`)
2. Fetch 20 matches via corpus builder (same as eval skill Phase 1).
3. Save raw log for each match to `raw-logs/<matchId>.log` before discarding.
4. Save prompts to `ab-test/control/prompts/`, index to `ab-test/control/index.json`.
5. Run full eval pipeline on control prompts → `ab-test/control/`.
6. Write `state.json` → phase = `control-ready`.
7. Print: "Control established (20 matches). Implement your change, then run `/improve-healer-prompts` again."

---

## Phase 2 — Treatment (control-ready or treatment-ready → treatment-ready)

**Triggered by:** `/improve-healer-prompts` with phase = `control-ready` or `treatment-ready`.

1. Load `state.json`. Print the change description and treatment run number.
2. For each matchId in state:
   - Load `raw-logs/<matchId>.log`
   - Re-run `buildMatchPromptNew` with current (new) code
   - Write to `ab-test/treatment/prompts/`
3. Run full eval pipeline on treatment prompts → `ab-test/treatment/`.
4. Produce `ab-test/comparison-report.md` (see format below).
5. Increment `treatmentRuns`, write `state.json` → phase = `treatment-ready`.
6. Print comparison summary and triage.

---

## Comparison Report Format

```markdown
# A/B Comparison Report

**Change tested:** <changeDescription>
**Target dimension:** <targetDimension>
**Treatment run:** N  |  **Matches:** 20

---

## Target Dimension: <targetDimension>

| Ordinal | Spec | Result | Control | Treatment | Delta |
| ------- | ---- | ------ | ------- | --------- | ----- |
| 001     | ...  | Win    | 3       | 4         | +1    |

**Average:** 3.15 → 4.10 (+0.95)

---

## Regressions (other dimensions that worsened)

| Dimension | Control avg | Treatment avg | Delta |
| --------- | ----------- | ------------- | ----- |
| noise     | 3.60        | 2.90          | -0.70 |

---

## New Issues Found in Treatment

1. **[dimension]** — description (affects N/20 matches)

---

## Triage

| Issue                    | Recommendation | Rationale                                    |
| ------------------------ | -------------- | -------------------------------------------- |
| noise regression (short) | Fix now        | Cap KILL SEQUENCE at 3 events — 1 line change |
| labelBias in new section | Next cycle     | Needs its own A/B to validate               |
| Evoker CD tracking gap   | Backlog        | Unrelated to current change                 |

**Fix-now:** Make the fix, run `/improve-healer-prompts` again (same control).
**Next cycle:** Conclude this cycle first, then start fresh for these.
**Backlog:** Add to TRACKER.md manually.

---

## Rubric Feedback

What to consider updating in `eval-healer-prompts.md` after this cycle:

- [Specific suggestion about a rubric dimension, threshold, or note]

---

## Decision

Run `/improve-healer-prompts adopt` or `/improve-healer-prompts abandon`.
```

---

## Phase 3 — Conclude (treatment-ready → idle)

**Triggered by:** `/improve-healer-prompts adopt` or `/improve-healer-prompts abandon`.

1. Print: change tested, treatment runs, final delta on target dimension.
2. If `abandon`: remind user to revert the code change.
3. Delete `raw-logs/<matchId>.log` for all matchIds in this cycle.
4. Delete `ab-test/` directory.
5. Write `state.json` → `{ "phase": "idle" }`.
6. Reprint the rubric feedback section — the human-readable suggestion for what to update in `eval-healer-prompts.md`.

---

## Corpus Builder Changes (`buildHealerPromptCorpus.ts`)

**1. Save raw logs**

When env var `SAVE_RAW_LOGS=1` is set, write downloaded log text to `raw-logs/<matchId>.log` before discarding. The improve skill sets this flag when invoking the builder for Phase 1.

**2. `FROM_RAW_LOGS=1` mode**

Instead of fetching from the API, reads matchIds from `ab-test/state.json`, loads each `raw-logs/<matchId>.log`, re-runs `buildMatchPromptNew` on the parsed combat, writes prompts to the specified output dir. Used by Phase 2 to generate treatment prompts with zero API calls.

---

## Relationship to Existing Eval Skill

`/eval-healer-prompts --snapshot` and `--save-snapshot` are kept unchanged. They test rubric drift (did Claude's scoring of the same old prompts change?), not prompt builder changes. A clarifying note distinguishing the two will be added to the eval skill documentation.

---

## Disk Lifecycle

Raw logs exist only from Phase 1 through `conclude` — typically hours to a day. `conclude` deletes all raw logs and the `ab-test/` directory. No accumulation.

---
name: improve-healer-prompts
description: Use when validating whether a specific prompt-builder code change improved healer eval scores.
---

Validate whether a prompt-builder code change improved healer eval scores, via a controlled A/B test. This command is stateful — it reads `packages/tools/local-batch/healer-eval/ab-test/state.json` to determine which phase to run.

> **Scope note:** This command tests _prompt-builder code_ changes (e.g. `buildMatchPromptNew`). To find what to fix next, use `/eval-healer-prompts`. For _system prompt text_ changes (`SYSTEM_PROMPT` / `NEW_SYSTEM_PROMPT`), use `docs/prompt-ab-testing-workflow.md` (`evalPromptCompare`) instead.

## Argument Handling

Read the argument passed after `/improve-healer-prompts`:

- No argument → **auto-detect phase** from state file (Phase 1 if no state, Phase 2 if control-ready or treatment-ready)
- `adopt` → **conclude and adopt**: keep the change, clean up, print rubric feedback
- `abandon` → **conclude and abandon**: revert reminder, clean up, print rubric feedback

---

## State Detection (no argument only)

Read `packages/tools/local-batch/healer-eval/ab-test/state.json`.

- File does not exist, or `phase` is `"idle"` → run **Phase 1 (Control)**
- `phase` is `"control-ready"` or `"treatment-ready"` → run **Phase 2 (Treatment)**

---

## Shared: Response Generation Run (used by both phases)

Both phases generate responses (Step 2 of `eval-healer-prompts.md`, including the `MATCHID:` header
and ordinal-integrity check) against a base directory `BASE` under
`packages/tools/local-batch/healer-eval/` — `ab-test/control/` in Phase 1, `ab-test/treatment/` in
Phase 2:

- Read prompts from `BASE/prompts/` and the index from `BASE/index.json`.
- When spawning sub-agents with the eval-healer-prompts Step 2 template, substitute these paths for the defaults: responses go to `BASE/responses/NNN.txt`.
- Then run the deterministic quality check: `BASE_DIR=<BASE> npm run -w @wowarenalogs/tools start:promptQualityCheck`.

**No scoring happens per-arm.** All rubric scoring in this command is done once, blinded, in Phase
2 Step 2.4 — scoring an arm while knowing which arm it is (or after implementing the change being
tested) produces biased deltas and is prohibited.

These runs never read or write the regular eval skill's `healer-eval/prompts/`, `responses/`, or `scores/` directories.

---

## Phase 1 — Control

**Triggered when:** no state file, or phase = `"idle"`.

### Step 1.1: Gather context

Ask the user two questions (can be in a single message):

1. "What change are you testing?" (e.g., "added KILL SEQUENCE block for matches < 90s — F113")
2. "Which eval dimension is this intended to improve?" (e.g., `inferenceScaffolding`)

Wait for the user's answer before proceeding.

### Step 1.2: Build control corpus

Run the corpus builder with raw log saving enabled:

```
SAVE_RAW_LOGS=1 TARGET_COUNT=20 npm run -w @wowarenalogs/tools start:buildHealerPromptCorpus
```

Wait for it to complete. If it exits non-zero, abort: "Corpus build failed — see output above."

After completion, verify `packages/tools/local-batch/healer-eval/index.json` exists and read it to get the entry list. Verify that `packages/tools/local-batch/healer-eval/raw-logs/` contains one `.log` file per matchId in the index.

Copy prompts, index, and coverage manifests to control dir:

```bash
mkdir -p packages/tools/local-batch/healer-eval/ab-test/control/prompts
cp packages/tools/local-batch/healer-eval/prompts/* packages/tools/local-batch/healer-eval/ab-test/control/prompts/
cp packages/tools/local-batch/healer-eval/index.json packages/tools/local-batch/healer-eval/ab-test/control/index.json
mkdir -p packages/tools/local-batch/healer-eval/ab-test/control/manifests
cp packages/tools/local-batch/healer-eval/manifests/* packages/tools/local-batch/healer-eval/ab-test/control/manifests/
```

### Step 1.3: Generate control responses

Run the shared response-generation run (see **Shared: Response Generation Run** above) with `BASE = ab-test/control/`. Do NOT score.

### Step 1.4: Write state file

Collect all matchIds from the index. Write `packages/tools/local-batch/healer-eval/ab-test/state.json`:

```json
{
  "phase": "control-ready",
  "matchIds": ["<id1>", "<id2>", ...],
  "controlRunDate": "<YYYY-MM-DD>",
  "treatmentRuns": 0,
  "targetDimension": "<dimension from user>",
  "changeDescription": "<description from user>"
}
```

### Step 1.5: Report

Print:

```
Control established — N matches with responses (no scores yet; scoring happens blinded in Phase 2).
Control quality metrics: packages/tools/local-batch/healer-eval/ab-test/control/quality-report.json

Next steps:
1. Implement your change to the prompt builder code
2. Run /improve-healer-prompts again to run the treatment
```

---

## Phase 2 — Treatment

**Triggered when:** phase = `"control-ready"` or `"treatment-ready"`.

### Step 2.1: Load state

Read `ab-test/state.json`. Print:

```
Running treatment (run N+1) for: <changeDescription>
Target dimension: <targetDimension>
Control established: <controlRunDate> | Matches: <N>
```

### Step 2.2: Regenerate prompts with new code

Run the corpus builder in FROM_RAW_LOGS mode, targeting the treatment directory:

```
FROM_RAW_LOGS=1 \
  OUTPUT_PROMPTS_DIR=packages/tools/local-batch/healer-eval/ab-test/treatment/prompts \
  OUTPUT_INDEX_FILE=packages/tools/local-batch/healer-eval/ab-test/treatment/index.json \
  npm run -w @wowarenalogs/tools start:buildHealerPromptCorpusFromRawLogs
```

Wait for completion. Verify that `ab-test/treatment/prompts/` contains the same number of files as `ab-test/control/prompts/`. If any matchIds are missing (raw log absent), note them and continue.

### Step 2.3: Generate treatment responses

Run the shared response-generation run (see **Shared: Response Generation Run** above) with `BASE = ab-test/treatment/`.

### Step 2.4: Blind scoring

Build the blinded pool (pairs every ordinal present in both arms, shuffles, strips arm identity):

```
npm run -w @wowarenalogs/tools start:blindAbPool
```

> **BLINDING RULE (non-negotiable):** do not read `ab-test/blind/mapping.json` — not now, not to
> "verify", not on error — until every blind score is written. You implemented the change being
> tested; knowing which items are treatment corrupts the comparison. Only `start:abCompareStats`
> reads the mapping.

For each directory under `ab-test/blind/items/`, spawn one background scoring sub-agent
(self-contained; substitute ITEMID):

> You are scoring a WoW arena coaching prompt/response pair. Read
> `packages/tools/local-batch/healer-eval/ab-test/blind/items/ITEMID/prompt.txt` and
> `.../ITEMID/response.txt`. Apply the scoring rubric from `docs/commands/eval-healer-prompts.md`
> Step 3 exactly (three-pass process, 1/3/5 anchors; there is no quality-report.json for this item —
> skip the consistency rules that reference it). Do not read any other file or directory. Write
> ONLY the score JSON (standard 7-dimension format) to
> `packages/tools/local-batch/healer-eval/ab-test/blind/scores/ITEMID.json`.

One item per sub-agent — never batch two items into one agent (it could notice paired prompts).
When all score files exist, unblind and compute paired statistics:

```
npm run -w @wowarenalogs/tools start:abCompareStats
```

This prints per-dimension mean delta, SD, 95% bootstrap CI, and sign-test p, with a verdict of
improved / regressed / inconclusive (CI excluding 0), and writes `ab-test/comparison-stats.json`.

### Step 2.5: Produce comparison report

Combine two evidence sources:

1. **Deterministic metrics** (primary for sufficiency/noise/labelBias): diff
   `ab-test/control/quality-report.json` vs `ab-test/treatment/quality-report.json` — coverage
   percentages, duplicate ratios, spam-line counts, severity-lexicon hits, hard failures.
2. **Blind judge statistics** (primary for accuracy/outcomeAlignment/focusCalibration/
   inferenceScaffolding): the `start:abCompareStats` table.

The sufficiency and noise rows of the blind judge table are reported for completeness only —
they carry **no decision weight**. Blind scorers see one prompt at a time with no
quality-report grounding, so they cannot detect what a builder change added or dropped
(empirically confirmed: the 2026-07-04 calibration run and the F20 pilot, where judges scored
sufficiency 4.9 on both arms while measured interrupt coverage differed by 88 points). For those
dimensions the quality-report diff is the verdict.

Track how many control ordinals are absent from the blind pool — this is the Skipped count K.

Write `packages/tools/local-batch/healer-eval/ab-test/comparison-report.md` using this structure:

```markdown
# A/B Comparison Report

**Change tested:** <changeDescription>
**Target dimension:** <targetDimension>
**Treatment run:** N | **Control matches:** M | **Skipped (missing raw logs):** K

---

## Deterministic Metrics (quality-report diff — authoritative for sufficiency/noise/labelBias)

| Metric                          | Control | Treatment | Delta |
| ------------------------------- | ------- | --------- | ----- |
| friendly-death coverage (avg %) |         |           |       |
| CC coverage (avg %)             |         |           |       |
| interrupt coverage (avg %)      |         |           |       |
| exact duplicate ratio (avg)     |         |           |       |
| `[RES] rdy:` spam lines (avg)   |         |           |       |
| severity-lexicon hits (total)   |         |           |       |
| hard failures (matches)         |         |           |       |
| approx tokens (avg)             |         |           |       |

## Target Dimension: <targetDimension>

(Per-ordinal table — computed AFTER unblinding, i.e. after `start:abCompareStats` has run.)

| Ordinal | Spec | Result | Control | Treatment | Delta |
| ------- | ---- | ------ | ------- | --------- | ----- |
| 001     | ...  | Win    | 3       | 4         | +1    |

...

---

## All Dimensions — Blind Paired Statistics

Paste the `start:abCompareStats` table (n, means, Δ mean, Δ SD, 95% CI, sign-test p, verdict).

---

## Regressions

Dimensions with verdict **regressed** (95% CI of the paired delta entirely below 0), plus any
deterministic metric that clearly worsened (e.g., a coverage drop or new hard failures). If none,
write "None." Do NOT flag `inconclusive` dimensions as regressions — but list them if the point
estimate is negative, marked "(inconclusive — monitor)".

---

## New Issues Found in Treatment

Issues visible in the blind treatment scores that the blind control scores don't show (any score ≤ 2
on a treatment item whose paired control item was > 2), and any new hard failures in the treatment
quality report:

1. **[dimension]** — match NNN: <notes from the blind score file>

If none, write "None."

---

## Triage

For each new issue or regression, assign one of:

- **Fix now** — small, isolated change (≤ 5 lines), low risk of introducing new issues, directly related to the current change
- **Next cycle** — medium complexity or uncertain impact; conclude this cycle first
- **Backlog** — unrelated to current change or speculative; add to TRACKER.md

| Issue | Recommendation | Rationale |
| ----- | -------------- | --------- |
| ...   | ...            | ...       |

**Fix-now items:** Make these changes and run `/improve-healer-prompts` again (same control, new treatment).
**Next-cycle items:** Conclude this cycle, start a fresh `/improve-healer-prompts` for these.
**Backlog items:** Add to TRACKER.md manually.

---

## Rubric Feedback

Based on what this A/B test revealed, consider updating `eval-healer-prompts.md`:

- [One or two specific suggestions: a dimension whose definition should be clarified, a threshold to adjust, a new note to add]

If no rubric changes are warranted, write "No rubric changes suggested."

---

## Decision

- Target dimension verdict: IMPROVED / INCONCLUSIVE / REGRESSED (Δ mean, 95% CI, sign-test p — or
  the deterministic metric delta when the target dimension is sufficiency/noise/labelBias)
- Regressions (CI-confirmed or deterministic): YES / NO
- Recommendation: ADOPT / ABANDON / ITERATE (if fix-now items exist)
- If INCONCLUSIVE: say so plainly. Adopting an inconclusive change is the user's judgment call
  (e.g., deterministic metrics improved while judge deltas are neutral) — never dress an
  inconclusive delta up as a win.

Run `/improve-healer-prompts adopt` or `/improve-healer-prompts abandon` when ready.
(To iterate: implement fix-now changes, then run `/improve-healer-prompts` again.)
```

### Step 2.6: Update state and report

Increment `treatmentRuns` in `state.json`, keep phase as `"treatment-ready"`.

Print the comparison report summary (target dimension verdict with CI, any regressions, triage table) and the path to the full report.

---

## Phase 3 — Conclude

**Triggered by:** `adopt` or `abandon` argument.

### Step 3.1: Load state and print summary

Read `state.json`. Print:

```
Concluding A/B cycle.
Change: <changeDescription>
Target dimension: <targetDimension>
Treatment runs: <N>
Final target dimension delta: <from last comparison report>
Decision: ADOPT | ABANDON
```

Retain `state.matchIds` in memory — you will need this list in Step 3.3b to delete raw logs after the ab-test directory is removed.

### Step 3.2: Abandon reminder

If `abandon`, print:

```
⚠ Remember to revert your code change to the prompt builder before continuing.
```

### Step 3.3a: Capture rubric feedback and write the ledger row before deletion

Read `packages/tools/local-batch/healer-eval/ab-test/comparison-report.md` and extract the "Rubric Feedback" section content into memory. If the file does not exist, note "No comparison report found."

Append one A/B run-summary row to `docs/eval-ledger.md` (git-tracked; see the format header there):
date, git commit, change description, target dimension, pairs n, target Δ mean with 95% CI,
verdict, decision (adopt/abandon). Everything under `ab-test/` is about to be deleted — the ledger
row is the only durable record of this cycle.

### Step 3.3b: Clean up disk

Delete raw logs and the ab-test directory. Use the `matchIds` retained from Step 3.1:

```bash
# Delete raw logs for this cycle
for matchId in <matchIds from state.matchIds>; do
  rm -f packages/tools/local-batch/healer-eval/raw-logs/$matchId.log
done
# Remove ab-test directory
rm -rf packages/tools/local-batch/healer-eval/ab-test/
# Remove raw-logs dir if now empty
rmdir packages/tools/local-batch/healer-eval/raw-logs/ 2>/dev/null || true
```

### Step 3.4: State after cleanup

The `ab-test/` directory (and thus `state.json`) is deleted in Step 3.3. The absence of `state.json` is the idle state. Do not recreate it.

### Step 3.5: Print rubric feedback

Print the rubric feedback section captured in Step 3.3. If no comparison report was found (e.g., user ran conclude before treatment), print: "No comparison report found — no rubric feedback to show."

Print:

```
Cycle complete. Raw logs and ab-test data deleted.

Rubric feedback for eval-healer-prompts.md:
<rubric feedback text>

If adopting: your code change is live — run /eval-healer-prompts to establish a new baseline.
If abandoning: revert your code change, then run /eval-healer-prompts to confirm baseline is unchanged.
```

---

## Notes

- If `ab-test/treatment/` or `ab-test/blind/` already has responses or scores from a previous treatment run, `start:blindAbPool` clears the blind dir; overwrite treatment responses freely.
- Do NOT call any external AI API during scoring. Blind scoring is done by spawned sub-agents (one item each); the orchestrating session must never score items itself — it knows what changed.
- Judge trust: if the current judge/rubric has never passed `docs/commands/calibrate-judge.md`, run that first — blind statistics from an uncalibrated judge are still noise. Optionally have a second, independent model blind-score the same pool into a separate scores dir (`SCORES_DIR` on the calibration checker) and compare verdicts; agreement strengthens the conclusion. Per-case isolation must hold for the second model too — one fresh session per item, never one session across items.
- The `ab-test/` directory is gitignored and local-only; the durable record is the row in `docs/eval-ledger.md`.

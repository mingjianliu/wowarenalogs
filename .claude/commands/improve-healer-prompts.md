Validate whether a prompt-builder code change improved healer eval scores, via a controlled A/B test. This command is stateful — it reads `packages/tools/local-batch/healer-eval/ab-test/state.json` to determine which phase to run.

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

Copy prompts and index to control dir:

```bash
mkdir -p packages/tools/local-batch/healer-eval/ab-test/control/prompts
cp packages/tools/local-batch/healer-eval/prompts/* packages/tools/local-batch/healer-eval/ab-test/control/prompts/
cp packages/tools/local-batch/healer-eval/index.json packages/tools/local-batch/healer-eval/ab-test/control/index.json
```

### Step 1.3: Run eval pipeline on control

Run the full eval pipeline (Steps 2–4 from `eval-healer-prompts`) on the control prompts. Use `packages/tools/local-batch/healer-eval/ab-test/control/` as the base for responses and scores:

- Sub-agents write responses to `ab-test/control/responses/NNN.txt`
- Score each match, write to `ab-test/control/scores/NNN.json`
- Write eval report to `ab-test/control/eval-report.md`

Use the same rubric and scoring process as the regular eval skill (Steps 2–4 of `eval-healer-prompts`), reading prompts from `ab-test/control/prompts/` and the index from `ab-test/control/index.json`.

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
Control established — 20 matches scored.
Control eval report: packages/tools/local-batch/healer-eval/ab-test/control/eval-report.md

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

### Step 2.3: Run eval pipeline on treatment

Run the full eval pipeline (Steps 2–4 of `eval-healer-prompts`) on the treatment prompts, writing to `ab-test/treatment/`. Read prompts from `ab-test/treatment/prompts/` and index from `ab-test/treatment/index.json`. Write responses to `ab-test/treatment/responses/`, scores to `ab-test/treatment/scores/`, report to `ab-test/treatment/eval-report.md`.

### Step 2.4: Produce comparison report

Read all score files from both `ab-test/control/scores/` and `ab-test/treatment/scores/`. For each ordinal present in both, compute the delta per dimension.

Write `packages/tools/local-batch/healer-eval/ab-test/comparison-report.md` using this structure:

```markdown
# A/B Comparison Report

**Change tested:** <changeDescription>
**Target dimension:** <targetDimension>
**Treatment run:** N  |  **Matches:** M

---

## Target Dimension: <targetDimension>

| Ordinal | Spec | Result | Control | Treatment | Delta |
| ------- | ---- | ------ | ------- | --------- | ----- |
| 001     | ...  | Win    | 3       | 4         | +1    |
...

**Average <targetDimension>:** X.XX → Y.YY (ΔZ.ZZ)

---

## All Dimensions — Aggregate Delta

| Dimension            | Control avg | Treatment avg | Delta  |
| -------------------- | ----------- | ------------- | ------ |
| sufficiency          |             |               |        |
| noise                |             |               |        |
| labelBias            |             |               |        |
| inferenceScaffolding |             |               |        |
| accuracy             |             |               |        |
| outcomeAlignment     |             |               |        |
| focusCalibration     |             |               |        |

---

## Regressions (dimensions that worsened by >0.3 avg)

List any dimension where treatment avg < control avg by more than 0.3. If none, write "None."

---

## New Issues Found in Treatment

Issues flagged in the treatment eval report that were not flagged in the control report (any score ≤ 2 in treatment that was > 2 in control):

1. **[dimension]** — match NNN: <notes from treatment score file>

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

- Target dimension improved: YES / NO (ΔX.XX)
- Regressions: YES / NO
- Recommendation: ADOPT / ABANDON / ITERATE (if fix-now items exist)

Run `/improve-healer-prompts adopt` or `/improve-healer-prompts abandon` when ready.
(To iterate: implement fix-now changes, then run `/improve-healer-prompts` again.)
```

### Step 2.5: Update state and report

Increment `treatmentRuns` in `state.json`, keep phase as `"treatment-ready"`.

Print the comparison report summary (target dimension delta, any regressions, triage table) and the path to the full report.

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

### Step 3.2: Abandon reminder

If `abandon`, print:

```
⚠ Remember to revert your code change to the prompt builder before continuing.
```

### Step 3.3: Clean up disk

Read the rubric feedback section from `ab-test/comparison-report.md` BEFORE deleting (you will need it in Step 3.5). Then delete raw logs for all matchIds in this cycle and the ab-test directory:

```bash
rm -rf packages/tools/local-batch/healer-eval/ab-test/
```

If `raw-logs/` is now empty after deleting those files, delete it too:

```bash
# For each matchId in state.matchIds:
rm -f packages/tools/local-batch/healer-eval/raw-logs/<matchId>.log
# Then check if empty:
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

- The skill reads prompts from `ab-test/control/prompts/` (not `healer-eval/prompts/`) in all phases. The regular eval skill's `prompts/` directory is untouched.
- If `ab-test/treatment/` already has responses or scores from a previous treatment run, overwrite them.
- Do NOT call any external AI API during scoring (Steps 2.3–2.4). You (this Claude Code session) are the judge, same as in `eval-healer-prompts`.
- The `ab-test/` directory is gitignored and local-only.

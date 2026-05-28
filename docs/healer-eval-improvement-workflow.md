# Healer Eval Improvement Workflow

How to use the two-skill eval pipeline to identify prompt quality issues, validate fixes, and adopt or abandon them.

---

## The Two Skills

| Skill | Question it answers | When to run |
| ----- | ------------------- | ----------- |
| `/eval-healer-prompts` | "What should we fix?" | Periodically to find the next improvement target |
| `/improve-healer-prompts` | "Did we fix it?" | After implementing a change from the eval report |

---

## Full Cycle — Step by Step

### Step 1: Run the eval to find what to fix

```
/eval-healer-prompts
```

This fetches 20 fresh matches, generates coaching responses, scores them across 7 dimensions, and writes `eval-report.md`. At the end it lists the **Top 3 Issues** ranked by urgency.

Pick one issue from the report — e.g. "inferenceScaffolding avg 3.15, flagged in 2/20 matches."

---

### Step 2: Establish the control corpus (before you write any code)

```
/improve-healer-prompts
```

The skill detects no existing state and runs Phase 1:

1. Asks you two questions:
   - *"What change are you testing?"* — e.g. `"added KILL SEQUENCE block for matches <90s (F113)"`
   - *"Which eval dimension is this intended to improve?"* — e.g. `inferenceScaffolding`
2. Fetches 20 fresh matches, saves both prompts **and raw combat logs** to disk
3. Runs the full eval pipeline on those prompts (scores all 7 dimensions)
4. Writes `ab-test/state.json` with phase = `control-ready`

When it finishes:
```
Control established — 20 matches scored.
Control eval report: packages/tools/local-batch/healer-eval/ab-test/control/eval-report.md

Next steps:
1. Implement your change to the prompt builder code
2. Run /improve-healer-prompts again to run the treatment
```

---

### Step 3: Implement your change

Edit `packages/tools/src/printMatchPrompts.ts` (or wherever `buildMatchPromptNew` is implemented). Make the change described in the eval report's recommendation.

Do **not** run `/eval-healer-prompts` yet — that would fetch new matches and lose the controlled comparison. Run `/improve-healer-prompts` instead.

---

### Step 4: Run the treatment

```
/improve-healer-prompts
```

The skill reads `state.json` (phase = `control-ready`) and runs Phase 2:

1. Loads the saved raw combat logs from disk — **no API calls**
2. Re-runs `buildMatchPromptNew` with your new code on the exact same matches
3. Runs the eval pipeline on the new prompts
4. Produces `ab-test/comparison-report.md` with:
   - Per-match score delta on the target dimension
   - Aggregate delta across all 7 dimensions
   - Regressions (dimensions that worsened by > 0.3)
   - New issues found in treatment
   - Triage: **Fix now** / **Next cycle** / **Backlog**
   - Rubric feedback for `eval-healer-prompts.md`

Example comparison output:

```
Target dimension: inferenceScaffolding
Average: 3.15 → 4.10 (+0.95) ✓
Regressions: None
New issues: None
Recommendation: ADOPT
```

---

### Step 5: Decide — adopt, abandon, or iterate

**If the target dimension improved and no regressions:**

```
/improve-healer-prompts adopt
```

**If the target dimension did not improve or regressions are unacceptable:**

```
/improve-healer-prompts abandon
```

Remember to revert your code change if abandoning.

**If the comparison report has "Fix now" items** (small issues introduced by the change):

Make those fixes, then run treatment again against the same control:

```
/improve-healer-prompts
```

You can iterate treatment as many times as needed. The control always stays the same until you conclude.

---

### Step 6: Conclude

On `adopt` or `abandon`, the skill:

1. Prints a summary (change tested, treatment runs, final delta)
2. Reprints the rubric feedback from the comparison report — review and manually update `eval-healer-prompts.md` if warranted
3. Deletes all raw logs and the `ab-test/` directory (disk cleanup)

```
Cycle complete. Raw logs and ab-test data deleted.

Rubric feedback for eval-healer-prompts.md:
- Consider adding a note to inferenceScaffolding: short matches (<90s) require
  a KILL SEQUENCE block to score above 3, regardless of other sections present.

If adopting: your code change is live — run /eval-healer-prompts to establish a new baseline.
```

---

### Step 7: Establish a new baseline

Run the eval again to confirm the improvement holds on fresh matches and pick the next target:

```
/eval-healer-prompts
```

---

## Quick Reference

```
/eval-healer-prompts                    # find what to fix
  ↓ (pick an issue, implement the fix)
/improve-healer-prompts                 # establish control (before code change)
  ↓ (implement your change)
/improve-healer-prompts                 # run treatment (after code change)
  ↓ (fix-now items if any)
/improve-healer-prompts                 # iterate treatment (optional)
  ↓
/improve-healer-prompts adopt|abandon   # conclude, clean up, print rubric feedback
  ↓
/eval-healer-prompts                    # new baseline
```

---

## State File

The skill tracks its phase in `packages/tools/local-batch/healer-eval/ab-test/state.json` (gitignored, local only):

```json
{
  "phase": "control-ready",
  "matchIds": ["abc123", "def456", "..."],
  "controlRunDate": "2026-05-17",
  "treatmentRuns": 1,
  "targetDimension": "inferenceScaffolding",
  "changeDescription": "added KILL SEQUENCE block for matches <90s (F113)"
}
```

To check current phase: `cat packages/tools/local-batch/healer-eval/ab-test/state.json`

To hard reset if something goes wrong:
```bash
rm -rf packages/tools/local-batch/healer-eval/ab-test/
rm -rf packages/tools/local-batch/healer-eval/raw-logs/
```

---

## Disk Usage

Raw combat logs are saved from Phase 1 until `conclude`. Each log is 1–10 MB; 20 matches = up to 200 MB temporarily on disk. All deleted automatically on `adopt` or `abandon`.

---

## Gemini CLI Instructions

The workflow is identical to the Claude Code version above. The only differences are how you invoke skills and which tool names to use.

### Invoking Skills

| Claude Code | Gemini CLI |
| ----------- | ---------- |
| `/eval-healer-prompts` | `activate_skill eval-healer-prompts` |
| `/eval-healer-prompts --snapshot` | `activate_skill eval-healer-prompts --snapshot` |
| `/eval-healer-prompts --save-snapshot` | `activate_skill eval-healer-prompts --save-snapshot` |
| `/improve-healer-prompts` | `activate_skill improve-healer-prompts` |
| `/improve-healer-prompts adopt` | `activate_skill improve-healer-prompts adopt` |
| `/improve-healer-prompts abandon` | `activate_skill improve-healer-prompts abandon` |

### Tool Name Mapping

The skills internally reference Claude Code tool names. When Gemini follows them, use these equivalents:

| Skill references | Gemini uses |
| ---------------- | ----------- |
| `Read` | `read_file` |
| `Write` | `write_file` |
| `Edit` | `replace` |
| `Bash` | `run_shell_command` |
| `Agent` (spawn sub-agent) | `@generalist` with the inline prompt |

### Parallel Sub-Agents

`eval-healer-prompts` and `improve-healer-prompts` spawn one sub-agent per match to generate coaching responses in parallel (Step 2 of the eval pipeline). In Gemini, dispatch all of these `@generalist` tasks at once in a single message — do not serialize them. Pass the full sub-agent prompt from the skill's template as the message to each `@generalist`.

### Full Cycle (Gemini)

```
activate_skill eval-healer-prompts          # find what to fix
  ↓ (pick an issue, implement the fix)
activate_skill improve-healer-prompts       # establish control (before code change)
  ↓ (implement your change)
activate_skill improve-healer-prompts       # run treatment (after code change)
  ↓ (fix-now items if any)
activate_skill improve-healer-prompts       # iterate treatment (optional)
  ↓
activate_skill improve-healer-prompts adopt|abandon   # conclude and clean up
  ↓
activate_skill eval-healer-prompts          # new baseline
```

Everything else — the state file, disk layout, adopt/abandon logic, triage in the comparison report — is identical to the Claude Code version.

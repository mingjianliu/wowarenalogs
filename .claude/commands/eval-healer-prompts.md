Evaluate healer arena prompts and Claude responses across 10–50 matches, then produce a cross-match quality report. This command orchestrates a four-step pipeline.

## Argument Handling

Read the arguments passed to this command (the text after `/eval-healer-prompts`):

- No arguments → **fresh mode**: build a new corpus then run full eval
- `--snapshot` → **snapshot mode**: use `packages/tools/local-batch/healer-eval/prompts-snapshot/` as the corpus, skip Step 1
- `--save-snapshot` → **save mode**: copy `packages/tools/local-batch/healer-eval/prompts/` to `packages/tools/local-batch/healer-eval/prompts-snapshot/`, then stop. Do not run the eval pipeline.

---

## Save-Snapshot Mode (--save-snapshot only)

If `--save-snapshot` was passed:

1. Check that `packages/tools/local-batch/healer-eval/prompts/` exists and contains at least one `.txt` file. If not, abort with: "No prompts found at healer-eval/prompts/ — run /eval-healer-prompts first to build a corpus."
2. Delete `packages/tools/local-batch/healer-eval/prompts-snapshot/` if it exists.
3. Copy `packages/tools/local-batch/healer-eval/prompts/` to `packages/tools/local-batch/healer-eval/prompts-snapshot/` (including `index.json` — copy it to the snapshot dir as `index.json`).
4. Report: "Snapshot saved: N prompt files copied to healer-eval/prompts-snapshot/."
   The resulting layout will be: `prompts-snapshot/index.json` (at root) and `prompts-snapshot/prompts/*.txt` (the prompt files as a subdirectory).
5. Stop. Do not proceed to Step 1–4.

---

## Step 1: Build Corpus (fresh mode only, skip in snapshot mode)

Run the corpus builder with a target of 20 matches (override with `TARGET_COUNT` env var if set):

```
TARGET_COUNT=20 npm run -w @wowarenalogs/tools start:buildHealerPromptCorpus
```

Wait for it to complete. If it exits non-zero, abort: "Corpus build failed — see output above."

After completion, verify that `packages/tools/local-batch/healer-eval/index.json` exists. Read it to get the list of entries.

In snapshot mode, read `packages/tools/local-batch/healer-eval/prompts-snapshot/index.json` instead. Set the prompts source directory to `packages/tools/local-batch/healer-eval/prompts-snapshot/prompts/` for all subsequent steps.

---

## Step 2: Generate Responses (Parallel Sub-Agents)

Read `packages/tools/local-batch/healer-eval/index.json` (fresh mode) or `packages/tools/local-batch/healer-eval/prompts-snapshot/index.json` (snapshot mode) to get the full list of entries. Each entry has: `ordinal`, `file`, `matchId`, `spec`, `bracket`, `result`, `durationSec`.

Before spawning each sub-agent, resolve the actual prompt file path based on the current mode and substitute it into the template — do not pass mode-conditional logic to the sub-agent. In fresh mode the path is `packages/tools/local-batch/healer-eval/prompts/FILENAME`; in snapshot mode it is `packages/tools/local-batch/healer-eval/prompts-snapshot/prompts/FILENAME` (where FILENAME comes from the entry's `file` field).

For each entry, spawn a **background sub-agent** using the Agent tool with `run_in_background: true`. The sub-agent's prompt must be self-contained (it has no context from this conversation). Use this template for each sub-agent, substituting the actual values:

> You are a WoW arena coach. Your task is to produce coaching advice for a healer player based on a match log.
>
> Read the match prompt from this file:
> `packages/tools/local-batch/healer-eval/prompts/FILENAME`
>
> Produce coaching advice for the healer. Focus on:
> - What went wrong or right in this match
> - Specific decisions that affected the outcome
> - Concrete adjustments for next time
>
> Write your coaching response (and nothing else — no preamble, no meta-commentary) to:
> `packages/tools/local-batch/healer-eval/responses/NNN.txt`
>
> Where NNN is the zero-padded 3-digit ordinal from the index entry (e.g., `001`, `014`).
>
> Create the `responses/` directory if it does not exist.

Spawn all sub-agents at once (not sequentially). You will receive background completion notifications.

Proceed to Step 3 once you have received completion notifications from all sub-agents, or once you stop receiving new notifications. Verify that all expected response files exist. If any are missing, note which ordinals are missing and continue without them — do not abort.

---

## Step 3: Score Each Match

For each entry in `packages/tools/local-batch/healer-eval/index.json` (fresh mode) or `packages/tools/local-batch/healer-eval/prompts-snapshot/index.json` (snapshot mode) where a corresponding `responses/NNN.txt` file exists:

1. Read the prompt file: `packages/tools/local-batch/healer-eval/prompts/FILENAME` (fresh mode) or `packages/tools/local-batch/healer-eval/prompts-snapshot/prompts/FILENAME` (snapshot mode)
2. Read the response: `packages/tools/local-batch/healer-eval/responses/NNN.txt`
3. Note the match `result` (Win/Loss/Unknown) from the index file

Apply the rubric below to score both. Write the result to `packages/tools/local-batch/healer-eval/scores/NNN.json` (create `scores/` if needed).

### Rubric

**Prompt quality — score each 1–5 (5 = excellent):**

- **sufficiency**: Does the prompt contain enough data for Claude to identify what actually mattered? Check for: CC chain section present with timing, dampening value shown, enemy CD timeline entries, kill attempt windows. Missing critical sections → score 1–2. Partial → 3. Complete → 4–5.

- **noise**: Are there verbose or redundant sections that add length without informing analysis? Watch for: `[RES] rdy:` lines that repeat unchanged across many timestamps, passive proc spam logged as player casts, duplicate events. Heavy repetition → score 1–2. Some noise → 3. Clean → 4–5.

- **labelBias**: Do section labels or framing steer Claude toward a conclusion before it reasons? Watch for: severity labels (`[CRITICAL]`, `[SPIKE]`) applied to minor events, loaded language in headers. Biased → score 1–2. Neutral → 4–5.

- **inferenceScaffolding**: Are events ordered and labeled so Claude can connect cause → effect? A death line should appear near the damage/CC that caused it; a trinket use near the CC it responded to. Events out of order or lacking context → score 1–2. Well-scaffolded → 4–5.

**Response quality — score each 1–5 (5 = excellent):**

- **accuracy**: Does the response reference only events that appear in the prompt? Check 2–3 specific claims against the prompt text. Hallucinated spell names, made-up timestamps, events not in the prompt → score 1–2. Accurate → 4–5.

- **outcomeAlignment**: Does the response explain factors that plausibly contributed to the win or loss? For a Loss: does it identify what broke down? For a Win: does it credit the right decisions? For result Unknown: score based on whether the response identifies the key turning points regardless of explicit outcome reference — treat it the same as a Loss if the match was short or one-sided in the prompt. A response that ignores the result entirely → score 1–2. Directly addresses outcome → 4–5.

- **focusCalibration**: Does Claude identify the highest-leverage moments, or give equal weight to everything? A response that spends as much time on a minor potion use as on a match-deciding CC chain → score 1–2. Clear prioritization → 4–5.

### Score file format

Write `packages/tools/local-batch/healer-eval/scores/NNN.json`:

```json
{
  "ordinal": 1,
  "matchId": "abc123",
  "spec": "Priest_Discipline",
  "result": "Loss",
  "durationSec": 187,
  "prompt": {
    "sufficiency": 3,
    "noise": 4,
    "labelBias": 2,
    "inferenceScaffolding": 3,
    "notes": "One sentence explaining the key prompt quality issue."
  },
  "response": {
    "accuracy": 5,
    "outcomeAlignment": 2,
    "focusCalibration": 3,
    "notes": "One sentence explaining the key response quality issue."
  }
}
```

All 7 numeric scores must be integers 1–5. The `notes` fields must be non-empty strings.

---

## Step 4: Synthesize Report

Read all `packages/tools/local-batch/healer-eval/scores/*.json` files. Compute stats and write `packages/tools/local-batch/healer-eval/eval-report.md` using this structure:

```markdown
# Healer Eval Report

**Run date:** YYYY-MM-DD
**Mode:** fresh | snapshot
**Matches evaluated:** N
**Spec distribution:** Druid_Restoration: N, Monk_Mistweaver: N, ...

---

## Aggregate Scores

| Dimension            | Min | Max | Avg | % ≤ 2 (flagged) |
| -------------------- | --- | --- | --- | --------------- |
| sufficiency          |     |     |     |                 |
| noise                |     |     |     |                 |
| labelBias            |     |     |     |                 |
| inferenceScaffolding |     |     |     |                 |
| accuracy             |     |     |     |                 |
| outcomeAlignment     |     |     |     |                 |
| focusCalibration     |     |     |     |                 |

---

## Flagged Matches (any dimension ≤ 2)

For each match with at least one score ≤ 2:

### NNN — Spec Win|Loss (matchId)
- **[dimension]**: score — (one-line explanation from notes)

---

## Cross-Spec Patterns

For each healer spec with ≥ 2 evaluated matches, show average scores per dimension. Highlight any dimension where a spec averages ≤ 2.5.

---

## Top 3 Issues

Rank by: (count of matches where dimension ≤ 2) × (5 − avg score). Higher = more urgent.

1. **[dimension]**: affects N/M matches. Avg score: X.X. Pattern: [describe what the low scores have in common, based on the notes].
2. ...
3. ...

---

## Recommendations

For each of the Top 3 issues, one concrete suggestion for what to investigate or change in `buildMatchPromptNew` or the analysis utilities. Be specific about which section of the prompt is affected.
```

After writing the report, print: "Eval complete. Report written to packages/tools/local-batch/healer-eval/eval-report.md"

---

## Notes

- Do not call any external AI API during Steps 3 or 4. You (this Claude Code session) are the judge.
- Do not modify any source code files during this command.
- If `index.json` has more than 50 entries, only evaluate the first 50.
- Score files are cumulative — if scores already exist from a prior run, overwrite them.

# eval-healer-prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an `eval-healer-prompts` Claude Code command that fetches arena match prompts, generates coaching responses via parallel sub-agents, scores each prompt+response pair against a rubric, and synthesizes a cross-match report — replacing `verify-healer-prompts`.

**Architecture:** The pipeline is orchestrated by a Claude Code command file (`.claude/commands/eval-healer-prompts.md`). Corpus building reuses the existing `buildHealerPromptCorpus.ts` TypeScript script (output dir changes from `healer-review/` to `healer-eval/`). Response generation uses parallel background sub-agents (no API script needed). Scoring and synthesis are performed inline by the main Claude Code session.

**Tech Stack:** Claude Code command files (markdown), TypeScript (`buildHealerPromptCorpus.ts`), `fs-extra`, `ts-node`.

---

## File Map

| Action | Path                                            | Purpose                                              |
| ------ | ----------------------------------------------- | ---------------------------------------------------- |
| Modify | `packages/tools/src/buildHealerPromptCorpus.ts` | Change output dir: `healer-review/` → `healer-eval/` |
| Create | `.claude/commands/eval-healer-prompts.md`       | Main command: orchestrates 4-step pipeline           |
| Modify | `.gitignore`                                    | Ignore `healer-eval/` outputs                        |
| Delete | `.claude/commands/verify-healer-prompts.md`     | Replaced by eval-healer-prompts                      |
| Delete | `docs/gemini-healer-prompt-review.md`           | Replaced by eval-healer-prompts                      |

---

## Task 1: Update Corpus Builder Output Directory

**Files:**

- Modify: `packages/tools/src/buildHealerPromptCorpus.ts:41-43`

- [ ] **Step 1: Read the current output dir constant**

Open `packages/tools/src/buildHealerPromptCorpus.ts` and find these three lines (around line 41):

```typescript
const OUTPUT_DIR = path.join(__dirname, '../local-batch/healer-review');
const PROMPTS_DIR = path.join(OUTPUT_DIR, 'prompts');
const INDEX_FILE = path.join(OUTPUT_DIR, 'index.json');
```

- [ ] **Step 2: Change the output directory**

Replace those three lines with:

```typescript
const OUTPUT_DIR = path.join(__dirname, '../local-batch/healer-eval');
const PROMPTS_DIR = path.join(OUTPUT_DIR, 'prompts');
const INDEX_FILE = path.join(OUTPUT_DIR, 'index.json');
```

- [ ] **Step 3: Verify the script runs and writes to the new location**

Run:

```bash
TARGET_COUNT=3 npm run -w @wowarenalogs/tools start:buildHealerPromptCorpus
```

Expected: script prints "Wrote 3 prompt(s) to .../healer-eval/prompts" (or similar). Check that files appeared:

```bash
ls packages/tools/local-batch/healer-eval/prompts/
```

Expected: 3 `.txt` files like `001-Priest_Discipline-L-<matchId>.txt` and an `index.json`.

- [ ] **Step 4: Commit**

```bash
git add packages/tools/src/buildHealerPromptCorpus.ts
git commit -m "feat(tools): change corpus builder output dir to healer-eval"
```

---

## Task 2: Update .gitignore

**Files:**

- Modify: `.gitignore`

- [ ] **Step 1: Read .gitignore to find the right insertion point**

Open `.gitignore` and find any existing `local-batch/` entries (search for `healer-review` or `local-batch`).

- [ ] **Step 2: Add healer-eval to .gitignore**

Add these lines near the existing local-batch entries (or at the end of the file if none exist):

```
# healer-eval pipeline outputs (ephemeral, per-developer)
packages/tools/local-batch/healer-eval/prompts/
packages/tools/local-batch/healer-eval/prompts-snapshot/
packages/tools/local-batch/healer-eval/responses/
packages/tools/local-batch/healer-eval/scores/
packages/tools/local-batch/healer-eval/eval-report.md
packages/tools/local-batch/healer-eval/index.json
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore healer-eval pipeline outputs"
```

---

## Task 3: Create the eval-healer-prompts Command

**Files:**

- Create: `.claude/commands/eval-healer-prompts.md`

This is the main deliverable. It is a Claude Code command file — instructions the AI agent follows when the user runs `/eval-healer-prompts`. Write it so an agent with zero prior context can execute the pipeline correctly.

- [ ] **Step 1: Create the command file**

Create `.claude/commands/eval-healer-prompts.md` with the full content below. Read it carefully before writing — every section matters.

```markdown
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
5. Stop. Do not proceed to Step 1–4.

---

## Step 1: Build Corpus (fresh mode only, skip in snapshot mode)

Run the corpus builder with a target of 20 matches (override with `TARGET_COUNT` env var if set):
```

TARGET_COUNT=20 npm run -w @wowarenalogs/tools start:buildHealerPromptCorpus

```

Wait for it to complete. If it exits non-zero, abort: "Corpus build failed — see output above."

After completion, verify that `packages/tools/local-batch/healer-eval/index.json` exists. Read it to get the list of entries.

In snapshot mode, read `packages/tools/local-batch/healer-eval/prompts-snapshot/index.json` instead. Set the prompts source directory to `prompts-snapshot/` for all subsequent steps.

---

## Step 2: Generate Responses (Parallel Sub-Agents)

Read `index.json` (or `prompts-snapshot/index.json` in snapshot mode) to get the full list of entries. Each entry has: `ordinal`, `file`, `matchId`, `spec`, `bracket`, `result`, `durationSec`.

For each entry, spawn a **background sub-agent** using the Agent tool with `run_in_background: true`. The sub-agent's prompt must be self-contained (it has no context from this conversation). Use this template exactly, substituting the bracketed values:

---
*Sub-agent prompt template:*

You are a WoW arena coach. Your task is to produce coaching advice for a healer player based on a match log.

Read the match prompt from this file (substitute the actual values when spawning each sub-agent):
- Fresh mode: `packages/tools/local-batch/healer-eval/prompts/<filename>` where `<filename>` is the `file` field from the index entry, filename only (e.g., `001-Priest_Discipline-L-abc123.txt`)
- Snapshot mode: `packages/tools/local-batch/healer-eval/prompts-snapshot/prompts/<filename>`

Produce coaching advice for the healer. Focus on:
- What went wrong or right in this match
- Specific decisions that affected the outcome
- Concrete adjustments for next time

Write your coaching response (and nothing else — no preamble, no meta-commentary) to:
`packages/tools/local-batch/healer-eval/responses/[NNN].txt`

Where `[NNN]` is the zero-padded 3-digit ordinal (e.g., `001`, `014`).

Create the `responses/` directory if it does not exist.
---

Spawn all sub-agents at once (not sequentially). You will receive background completion notifications.

After all sub-agents have completed (or after 5 minutes — whichever comes first), verify that all expected response files exist:
```

packages/tools/local-batch/healer-eval/responses/001.txt
packages/tools/local-batch/healer-eval/responses/002.txt
... (one per index entry)

````

If any response file is missing, note which ordinals are missing and continue without them — do not abort.

---

## Step 3: Score Each Match

For each entry in `index.json` where a corresponding `responses/NNN.txt` file exists:

1. Read `prompts/NNN-<spec>-<W|L>-<matchId>.txt` (the full prompt sent to Claude)
2. Read `responses/NNN.txt` (the coaching response generated by the sub-agent)
3. Note the match `result` (Win/Loss/Unknown) from `index.json`

Apply the rubric below to score both the prompt and the response. Write the result to `packages/tools/local-batch/healer-eval/scores/NNN.json` (create the `scores/` directory if needed).

### Rubric

**Prompt quality — score each 1–5 (5 = excellent):**

- **sufficiency**: Does the prompt contain enough data for Claude to identify what actually mattered? Check for: CC chain section present with timing, dampening value shown, enemy CD timeline entries, kill attempt windows. Missing critical sections → score 1–2. Partial → 3. Complete → 4–5.

- **noise**: Are there verbose or redundant sections that add length without informing analysis? Watch for: `[RES] rdy:` lines that repeat unchanged across many timestamps (if the list doesn't change, one entry suffices), passive proc spam logged as player casts, duplicate events. Heavy repetition → score 1–2. Some noise → 3. Clean → 4–5.

- **labelBias**: Do section labels or framing steer Claude toward a conclusion before it reasons? Watch for: severity labels (`[CRITICAL]`, `[SPIKE]`) applied to minor events, loaded language in headers. Biased → score 1–2. Neutral → 4–5.

- **inferenceScaffolding**: Are events ordered and labeled so Claude can connect cause → effect? A death line should appear near the damage/CC that caused it; a trinket use should appear near the CC it responded to. Events out of order or lacking context → score 1–2. Well-scaffolded → 4–5.

**Response quality — score each 1–5 (5 = excellent):**

- **accuracy**: Does the response reference only events that appear in the prompt? Check 2–3 specific claims against the prompt text. Hallucinated spell names, made-up timestamps, events not in the prompt → score 1–2. Accurate → 4–5.

- **outcomeAlignment**: Does the response explain factors that plausibly contributed to the win or loss? For a Loss: does it identify what broke down? For a Win: does it credit the right decisions? A response that ignores the result entirely → score 1–2. Directly addresses outcome → 4–5.

- **focusCalibration**: Does Claude identify the highest-leverage moments, or give equal weight to everything? A response that spends as much time on a minor potion use as on a match-deciding CC chain → score 1–2. Clear prioritization → 4–5.

### Score file format

Write `packages/tools/local-batch/healer-eval/scores/NNN.json` (3-digit zero-padded ordinal):

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
````

All 7 numeric scores must be integers 1–5. The `notes` fields must be non-empty strings.

---

## Step 4: Synthesize Report

Read all `packages/tools/local-batch/healer-eval/scores/*.json` files. Compute the following and write `packages/tools/local-batch/healer-eval/eval-report.md`:

### Report structure

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

For each match with at least one score ≤ 2, list:

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
- If `index.json` has more than 50 entries, only evaluate the first 50 (to keep the session context manageable).
- Score files are cumulative — if scores already exist from a prior run, overwrite them.

````

- [ ] **Step 2: Verify the file was created correctly**

```bash
wc -l .claude/commands/eval-healer-prompts.md
````

Expected: > 150 lines.

```bash
head -5 .claude/commands/eval-healer-prompts.md
```

Expected: starts with "Evaluate healer arena prompts..."

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/eval-healer-prompts.md
git commit -m "feat: add eval-healer-prompts command"
```

---

## Task 4: Delete Replaced Files

**Files:**

- Delete: `.claude/commands/verify-healer-prompts.md`
- Delete: `docs/gemini-healer-prompt-review.md`

- [ ] **Step 1: Delete the old command and Gemini doc**

```bash
git rm .claude/commands/verify-healer-prompts.md
git rm docs/gemini-healer-prompt-review.md
```

- [ ] **Step 2: Commit**

```bash
git commit -m "chore: remove verify-healer-prompts and gemini-healer-prompt-review (replaced by eval-healer-prompts)"
```

---

## Task 5: Smoke Test

Verify the full pipeline runs end-to-end with a small corpus.

- [ ] **Step 1: Run the eval command with a 3-match corpus**

In a Claude Code session, run:

```
/eval-healer-prompts
```

The command will use `TARGET_COUNT=20` by default. If you want a faster test, you can temporarily set the env var:

```
TARGET_COUNT=3 /eval-healer-prompts
```

(If the command doesn't support inline env vars, you can temporarily edit the command file to change `TARGET_COUNT=20` to `TARGET_COUNT=3` for this test, then revert.)

- [ ] **Step 2: Verify outputs exist**

After the pipeline completes, check:

```bash
ls packages/tools/local-batch/healer-eval/prompts/
# Expected: NNN-Spec-W|L-matchId.txt files

ls packages/tools/local-batch/healer-eval/responses/
# Expected: 001.txt, 002.txt, 003.txt (one per prompt)

ls packages/tools/local-batch/healer-eval/scores/
# Expected: 001.json, 002.json, 003.json

cat packages/tools/local-batch/healer-eval/scores/001.json
# Expected: valid JSON with ordinal, matchId, spec, result, prompt{}, response{}

cat packages/tools/local-batch/healer-eval/eval-report.md
# Expected: markdown report with Aggregate Scores table, Flagged Matches, Top 3 Issues
```

- [ ] **Step 3: Test snapshot mode**

```
/eval-healer-prompts --save-snapshot
```

Expected: "Snapshot saved: N prompt files copied to healer-eval/prompts-snapshot/."

```bash
ls packages/tools/local-batch/healer-eval/prompts-snapshot/
# Expected: same files as prompts/ plus index.json
```

- [ ] **Step 4: Test snapshot eval**

Delete the `responses/` and `scores/` dirs to start fresh, then run snapshot mode:

```bash
rm -rf packages/tools/local-batch/healer-eval/responses packages/tools/local-batch/healer-eval/scores packages/tools/local-batch/healer-eval/eval-report.md
```

```
/eval-healer-prompts --snapshot
```

Expected: skips corpus build step, uses existing snapshot prompts, produces responses + scores + report.

- [ ] **Step 5: If anything is wrong, fix the command file and re-test**

The command file is `.claude/commands/eval-healer-prompts.md`. Edit it to fix any ambiguities or missing instructions revealed by the smoke test. Commit any fixes:

```bash
git add .claude/commands/eval-healer-prompts.md
git commit -m "fix(eval-healer-prompts): address smoke test issues"
```

---

## Post-Implementation: localBatchAnalysis.ts

After the first real eval run (not just the smoke test), review `packages/tools/src/localBatchAnalysis.ts` to determine if it overlaps with `eval-healer-prompts`. If it does, remove it:

```bash
git rm packages/tools/src/localBatchAnalysis.ts
# Also remove its entry from packages/tools/package.json scripts
git add packages/tools/package.json
git commit -m "chore: remove localBatchAnalysis.ts (superseded by eval-healer-prompts)"
```

This step is intentionally deferred until after the first real run confirms the overlap.

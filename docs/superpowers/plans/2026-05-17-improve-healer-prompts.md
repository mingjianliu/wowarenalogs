# improve-healer-prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/improve-healer-prompts` slash command — a stateful A/B testing pipeline that validates whether a prompt-builder code change actually improved eval scores, then adopt or abandon it.

**Architecture:** Three phases driven by `ab-test/state.json`. Phase 1 (control) fetches fresh matches, saves raw combat logs to disk, and runs the full eval pipeline. Phase 2 (treatment) re-runs `buildMatchPromptNew` on the saved raw logs with new code and compares scores. Phase 3 (conclude) cleans up disk and prints rubric feedback. The corpus builder gets two new env-var-gated modes to support Phases 1 and 2.

**Tech Stack:** TypeScript (ts-node), `fs-extra`, `node-fetch`, existing `buildMatchPromptNew` / `parseLogText` from `printMatchPrompts.ts`, Claude Code slash command (`.claude/commands/`).

---

## File Map

| Action | Path | Responsibility |
| ------ | ---- | -------------- |
| Modify | `packages/tools/src/buildHealerPromptCorpus.ts` | Add `SAVE_RAW_LOGS` and `FROM_RAW_LOGS` env-var modes |
| Modify | `packages/tools/package.json` | Add `start:buildHealerPromptCorpusFromRawLogs` script |
| Modify | `.gitignore` | Ignore `raw-logs/` and `ab-test/` under `healer-eval/` |
| Create | `.claude/commands/improve-healer-prompts.md` | The slash command skill |
| Modify | `.claude/commands/eval-healer-prompts.md` | Add clarifying note about snapshot vs A/B |

---

### Task 1: Save raw logs in corpus builder (`SAVE_RAW_LOGS`)

**Files:**
- Modify: `packages/tools/src/buildHealerPromptCorpus.ts`

The corpus builder downloads each match log, parses it, writes the prompt, then discards the raw text. Add a `SAVE_RAW_LOGS=1` env var that writes the raw text to `raw-logs/<matchId>.log` before discarding.

- [ ] **Step 1: Add the env var constant and raw-logs dir path** after the existing constants block (after line 44 `const MIN_RATING = ...`):

```typescript
const SAVE_RAW_LOGS = process.env.SAVE_RAW_LOGS === '1';
const RAW_LOGS_DIR = path.join(OUTPUT_DIR, 'raw-logs');
```

- [ ] **Step 2: Ensure raw-logs dir exists** in `main()`, after the existing `await fs.ensureDir(PROMPTS_DIR)` line:

```typescript
if (SAVE_RAW_LOGS) {
  await fs.ensureDir(RAW_LOGS_DIR);
}
```

- [ ] **Step 3: Save raw log in `tryProcessStub`** after `text = await res.text();` and before `combats = await parseLogText(text)`:

```typescript
if (SAVE_RAW_LOGS) {
  await fs.writeFile(path.join(RAW_LOGS_DIR, `${stub.id}.log`), text, 'utf8');
}
```

- [ ] **Step 4: Verify manually**

```bash
SAVE_RAW_LOGS=1 TARGET_COUNT=2 npm run -w @wowarenalogs/tools start:buildHealerPromptCorpus 2>&1 | tail -5
ls packages/tools/local-batch/healer-eval/raw-logs/
```

Expected: two `.log` files named `<matchId>.log`.

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/buildHealerPromptCorpus.ts
git commit -m "feat(corpus): save raw logs to disk when SAVE_RAW_LOGS=1"
```

---

### Task 2: Re-generate prompts from raw logs (`FROM_RAW_LOGS`)

**Files:**
- Modify: `packages/tools/src/buildHealerPromptCorpus.ts`
- Modify: `packages/tools/package.json`

When `FROM_RAW_LOGS=1`, skip fetching from the API. Instead read `ab-test/state.json` to get the list of matchIds, load each `raw-logs/<matchId>.log`, re-run `buildMatchPromptNew`, and write prompts to `OUTPUT_PROMPTS_DIR` (overrideable via env var so Phase 2 can target `ab-test/treatment/prompts/`).

- [ ] **Step 1: Add env var constants** after the existing constants block:

```typescript
const FROM_RAW_LOGS = process.env.FROM_RAW_LOGS === '1';
const STATE_FILE = path.join(OUTPUT_DIR, 'ab-test', 'state.json');
const OUTPUT_PROMPTS_DIR = process.env.OUTPUT_PROMPTS_DIR
  ? path.resolve(process.env.OUTPUT_PROMPTS_DIR)
  : PROMPTS_DIR;
const OUTPUT_INDEX_FILE = process.env.OUTPUT_INDEX_FILE
  ? path.resolve(process.env.OUTPUT_INDEX_FILE)
  : INDEX_FILE;
```

- [ ] **Step 2: Add the `runFromRawLogs` function** before `main()`:

```typescript
async function runFromRawLogs(): Promise<void> {
  if (!(await fs.pathExists(STATE_FILE))) {
    console.error('No ab-test/state.json found. Run /improve-healer-prompts first to establish control.');
    process.exit(1);
  }
  const state = await fs.readJson(STATE_FILE) as { matchIds: string[] };
  const matchIds: string[] = state.matchIds ?? [];
  if (matchIds.length === 0) {
    console.error('state.json has no matchIds.');
    process.exit(1);
  }
  await fs.ensureDir(OUTPUT_PROMPTS_DIR);

  const entries: IndexEntry[] = [];
  for (let i = 0; i < matchIds.length; i++) {
    const matchId = matchIds[i];
    const rawLogPath = path.join(RAW_LOGS_DIR, `${matchId}.log`);
    if (!(await fs.pathExists(rawLogPath))) {
      process.stderr.write(`  [${i + 1}] ${matchId}: raw log missing, skipping\n`);
      continue;
    }
    const text = await fs.readFile(rawLogPath, 'utf8');
    let combats: ParsedCombat[];
    try {
      combats = await parseLogText(text);
    } catch (e) {
      process.stderr.write(`  [${i + 1}] ${matchId}: parse error: ${e}\n`);
      continue;
    }
    for (const combat of combats) {
      const friends = (Object.values(combat.units) as ICombatUnit[]).filter(
        (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
      );
      const owner = friends.find((p) => p.id === combat.playerId);
      if (!owner || !isHealerSpec(owner.spec)) continue;

      const spec = specToString(owner.spec);
      const durationSec = Math.round((combat.endTime - combat.startTime) / 1000);
      const combatAny = combat as unknown as Record<string, unknown>;
      const playerWon =
        typeof combatAny['winningTeamId'] === 'string' ? combatAny['winningTeamId'] === combat.playerTeamId : null;
      const result: IndexEntry['result'] = playerWon === true ? 'Win' : playerWon === false ? 'Loss' : 'Unknown';
      const resultLetter = result === 'Win' ? 'W' : result === 'Loss' ? 'L' : 'U';

      const prompt = buildMatchPromptNew(combat, true);
      if (!prompt) continue;

      const ordinalStr = String(i + 1).padStart(3, '0');
      const filename = `${ordinalStr}-${sanitizeForFilename(spec)}-${resultLetter}-${sanitizeForFilename(matchId)}.txt`;
      await fs.writeFile(path.join(OUTPUT_PROMPTS_DIR, filename), prompt, 'utf8');
      entries.push({
        ordinal: i + 1,
        file: path.join('prompts', filename),
        matchId,
        spec,
        bracket: combat.startInfo?.bracket ?? BRACKET,
        result,
        durationSec,
      });
      process.stderr.write(`  [${i + 1}] ${matchId}: wrote ${filename}\n`);
      break; // one healer perspective per log
    }
  }

  await fs.writeJson(OUTPUT_INDEX_FILE, entries, { spaces: 2 });
  console.log(`\nWrote ${entries.length} treatment prompt(s) to ${OUTPUT_PROMPTS_DIR}`);
}
```

- [ ] **Step 3: Gate `main()` on `FROM_RAW_LOGS`** — replace the final `main().catch(...)` call:

```typescript
const run = FROM_RAW_LOGS ? runFromRawLogs : main;
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 4: Add npm script** in `packages/tools/package.json` inside `"scripts"`:

```json
"start:buildHealerPromptCorpusFromRawLogs": "ts-node --files ./src/buildHealerPromptCorpus.ts"
```

Usage will be: `FROM_RAW_LOGS=1 OUTPUT_PROMPTS_DIR=... OUTPUT_INDEX_FILE=... npm run -w @wowarenalogs/tools start:buildHealerPromptCorpusFromRawLogs`

- [ ] **Step 5: Verify manually** (requires Task 1's raw logs to exist from step 4 above):

```bash
mkdir -p /tmp/treatment-test
FROM_RAW_LOGS=1 \
  OUTPUT_PROMPTS_DIR=/tmp/treatment-test/prompts \
  OUTPUT_INDEX_FILE=/tmp/treatment-test/index.json \
  npm run -w @wowarenalogs/tools start:buildHealerPromptCorpusFromRawLogs 2>&1 | tail -5
ls /tmp/treatment-test/prompts/
```

Expected: same number of `.txt` files as the raw-logs directory.

- [ ] **Step 6: Commit**

```bash
git add packages/tools/src/buildHealerPromptCorpus.ts packages/tools/package.json
git commit -m "feat(corpus): add FROM_RAW_LOGS mode to regenerate prompts without API calls"
```

---

### Task 3: Gitignore new directories

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add entries** after the existing `healer-eval` block (after line 151 `packages/tools/local-batch/healer-eval/index.json`):

```
packages/tools/local-batch/healer-eval/raw-logs/
packages/tools/local-batch/healer-eval/ab-test/
```

- [ ] **Step 2: Verify**

```bash
mkdir -p packages/tools/local-batch/healer-eval/raw-logs packages/tools/local-batch/healer-eval/ab-test
touch packages/tools/local-batch/healer-eval/raw-logs/test.log
touch packages/tools/local-batch/healer-eval/ab-test/state.json
git status packages/tools/local-batch/healer-eval/
```

Expected: neither `raw-logs/` nor `ab-test/` appears in `git status`.

- [ ] **Step 3: Cleanup and commit**

```bash
rm packages/tools/local-batch/healer-eval/raw-logs/test.log
rm packages/tools/local-batch/healer-eval/ab-test/state.json
git add .gitignore
git commit -m "chore: gitignore healer-eval raw-logs and ab-test directories"
```

---

### Task 4: Write the `/improve-healer-prompts` skill

**Files:**
- Create: `.claude/commands/improve-healer-prompts.md`

This is the main slash command. It reads `ab-test/state.json`, detects the current phase, and runs the appropriate step. The skill is written as prose instructions for Claude to follow (same pattern as `eval-healer-prompts.md`).

- [ ] **Step 1: Create `.claude/commands/improve-healer-prompts.md`** with the following content:

````markdown
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

Delete raw logs for all matchIds in this cycle:

```bash
# For each matchId in state.matchIds:
rm packages/tools/local-batch/healer-eval/raw-logs/<matchId>.log
```

If `raw-logs/` is now empty, delete it too. Then delete `ab-test/`:

```bash
rm -rf packages/tools/local-batch/healer-eval/ab-test/
```

### Step 3.4: Reset state

Write `packages/tools/local-batch/healer-eval/ab-test/state.json`:

```json
{ "phase": "idle" }
```

Wait — since `ab-test/` was deleted in 3.3, this file no longer exists. That is correct: the absence of the file is the `idle` state. Do not recreate it.

### Step 3.5: Print rubric feedback

Reprint the "Rubric Feedback" section from `ab-test/comparison-report.md` (which was deleted in 3.3) — copy it to terminal output before deletion. If the file no longer exists (e.g., user ran `conclude` before treatment), print: "No comparison report found — no rubric feedback to show."

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
- `DO NOT call any external AI API` during scoring (Steps 2.3–2.4). You (this Claude Code session) are the judge, same as in `eval-healer-prompts`.
- The `ab-test/` directory is gitignored and local-only.
````

- [ ] **Step 2: Verify the file exists and is non-empty**

```bash
wc -l .claude/commands/improve-healer-prompts.md
```

Expected: > 100 lines.

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/improve-healer-prompts.md
git commit -m "feat: add improve-healer-prompts slash command (A/B testing pipeline)"
```

---

### Task 5: Add clarifying note to eval skill and push

**Files:**
- Modify: `.claude/commands/eval-healer-prompts.md`

- [ ] **Step 1: Add a clarifying note** at the top of `eval-healer-prompts.md`, after the first sentence and before `## Argument Handling`:

```markdown
> **Scope note:** This command assesses prompt and response quality and identifies what to fix. To validate whether a specific code change improved scores, use `/improve-healer-prompts` instead. The `--snapshot` / `--save-snapshot` modes in this command test *rubric drift* (did Claude's scoring of the same old prompts change?) — they do not test prompt builder changes.
```

- [ ] **Step 2: Verify the note appears correctly**

```bash
head -10 .claude/commands/eval-healer-prompts.md
```

Expected: the scope note appears in the first 10 lines.

- [ ] **Step 3: Commit and push**

```bash
git add .claude/commands/eval-healer-prompts.md
git commit -m "docs(eval-healer-prompts): clarify scope vs improve-healer-prompts"
git push origin main
```

---

## Self-Review

**Spec coverage:**
- ✅ Two-skill system with clean handoff
- ✅ `SAVE_RAW_LOGS` mode (Task 1)
- ✅ `FROM_RAW_LOGS` mode (Task 2)
- ✅ Gitignore `raw-logs/` and `ab-test/` (Task 3)
- ✅ State machine with auto-detection (Task 4, Phase detection section)
- ✅ Phase 1: ask user, fetch, save raw logs, eval control, write state (Task 4, Phase 1)
- ✅ Phase 2: load state, regenerate treatment prompts, eval treatment, comparison report with triage (Task 4, Phase 2)
- ✅ Phase 3: adopt/abandon, delete raw logs, delete ab-test/, print rubric feedback (Task 4, Phase 3)
- ✅ Disk lifecycle: raw logs deleted on conclude (Task 4, Phase 3, Step 3.3)
- ✅ Clarifying note on eval skill (Task 5)
- ✅ npm script for FROM_RAW_LOGS (Task 2, Step 4)

**Placeholder scan:** No TBDs, no "implement later", all code blocks are complete.

**Type consistency:** `IndexEntry` interface used identically in both `main()` and `runFromRawLogs()` — defined once at top of file, reused. `state.json` shape defined in Task 4 and read consistently in Phase 2 and Phase 3 steps.

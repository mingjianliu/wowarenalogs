---
name: eval-healer-prompts
description: Use when assessing healer prompt and response quality across many matches to find what to fix next.
---

Evaluate healer arena prompts and Claude responses across 10–50 matches, then produce a cross-match quality report. This command orchestrates a four-step pipeline.

> **Scope note — three eval harnesses exist; pick the right one:**
>
> - **This command** assesses prompt and response quality and identifies what to fix.
> - **`/improve-healer-prompts`** validates whether a specific _prompt-builder code_ change improved scores (controlled A/B on the same matches).
> - **`docs/prompt-ab-testing-workflow.md`** (`evalPromptCompare`) validates _system prompt text_ changes (`SYSTEM_PROMPT` / `NEW_SYSTEM_PROMPT`).
>
> The `--snapshot` / `--save-snapshot` modes in this command test _rubric drift_ (did Claude's scoring of the same old prompts change?) — they do not test prompt builder changes.

## Quick spot-QA mode (lightweight alternative)

When you only changed a prompt rule or one context annotation, a full 50-game eval is overkill. Run a
2–4 game spot-QA instead (~5 min): pick games that exercise the changed surface (grep the fresh
prompts for the new/changed line), launch one role-play sub-agent per game (the coach persona, per
CLAUDE.md's no-API-key role-play), and have each agent END with this self-audit checklist:

1. **Fabrication** — every spell/number/timestamp cited appears verbatim in the prompt.
2. **Anchor discipline** — verified-standing numbers quoted exactly, direction ("higher/lower is
   better") not inverted, no invented percentiles.
3. **Denominator discipline** — pro counts as "N of M shown", no absolute quantifiers.
4. **Causality guards** — no self-only tool offered for a teammate's death; no "heal less mid-crisis"
   advice; pre-CC insurance and utility casts not called waste; dead players not offered casts.
5. **Did the changed rule actually bind?** — ask the agent whether the new guard altered its answer
   (the 2026-07-03 survival-first QA: "without it I might have anchored on the percentile").

Then run the deterministic gate (`regression-gate.md`). Spot-QA + gate ≈ enough for one-rule changes;
use the full pipeline below for prompt rewrites or multi-surface changes.

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

After completion, verify that `packages/tools/local-batch/healer-eval/index.json` exists. Read it to get the list of entries. The builder also writes ground-truth coverage manifests to `manifests/NNN.json`.

Then run the deterministic quality check and read its output:

```
npm run -w @wowarenalogs/tools start:promptQualityCheck
```

This writes `packages/tools/local-batch/healer-eval/quality-report.json` with measured coverage
(friendly deaths / CC / interrupts / dispels / trinkets present in each prompt vs the raw log),
noise ratios, and severity-label hits. Step 3's judge MUST ground its sufficiency / noise /
labelBias scores in these measurements instead of eyeballing the prompt.

In snapshot mode, read `packages/tools/local-batch/healer-eval/prompts-snapshot/index.json` instead. Set the prompts source directory to `packages/tools/local-batch/healer-eval/prompts-snapshot/prompts/` for all subsequent steps. If the snapshot has no `manifests/`, skip the quality check and note in the report that deterministic grounding was unavailable.

---

## Step 2: Generate Responses (Parallel Sub-Agents)

> **Execution model:** This step uses the AI session's built-in Agent tool to spawn sub-agents. No external API key, no external scripts, no new `.ts` files. If you do not have an `Agent` tool, perform this step yourself: read each prompt file, generate coaching advice, and write the response file directly. Do NOT create wrapper scripts to call an external AI API — you ARE the AI.

Read `packages/tools/local-batch/healer-eval/index.json` (fresh mode) or `packages/tools/local-batch/healer-eval/prompts-snapshot/index.json` (snapshot mode) to get the full list of entries. Each entry has: `ordinal`, `file`, `matchId`, `spec`, `bracket`, `result`, `durationSec`.

Before spawning each sub-agent, resolve the actual prompt file path based on the current mode and substitute it into the template — do not pass mode-conditional logic to the sub-agent. In fresh mode the path is `packages/tools/local-batch/healer-eval/prompts/FILENAME`; in snapshot mode it is `packages/tools/local-batch/healer-eval/prompts-snapshot/prompts/FILENAME` (where FILENAME comes from the entry's `file` field).

For each entry, spawn a **background sub-agent** using the Agent tool with `run_in_background: true`. The sub-agent's prompt must be self-contained (it has no context from this conversation). Use this template for each sub-agent, substituting the actual values:

> You are a WoW arena coach. Your task is to produce coaching advice for a healer player based on a match log.
>
> Read the match prompt from this file:
> `packages/tools/local-batch/healer-eval/prompts/FILENAME`
>
> Produce coaching advice for the healer. Focus on:
>
> - What went wrong or right in this match
> - Specific decisions that affected the outcome
> - Concrete adjustments for next time
>
> Write your coaching response to:
> `packages/tools/local-batch/healer-eval/responses/NNN.txt`
>
> Where NNN is the zero-padded 3-digit ordinal from the index entry (e.g., `001`, `014`).
>
> The FIRST line of the file must be exactly `MATCHID: <matchId>` (substitute the actual matchId
> given above), followed by a blank line, then the coaching response and nothing else — no
> preamble, no meta-commentary.
>
> Create the `responses/` directory if it does not exist.

Spawn all sub-agents at once (not sequentially). You will receive background completion notifications.

Proceed to Step 3 once you have received completion notifications from all sub-agents, or once you stop receiving new notifications. Verify that all expected response files exist. If any are missing, note which ordinals are missing and continue without them — do not abort.

**Ordinal integrity check:** for every response file, verify its `MATCHID:` header equals the
matchId of the index entry with that ordinal. A mismatch means a file-swap bug (this has happened —
the 063/064 incident): exclude BOTH ordinals from scoring and report them. Strip the header line
before showing the response to the judge.

---

## Step 3: Score Each Match

For each entry in `packages/tools/local-batch/healer-eval/index.json` (fresh mode) or `packages/tools/local-batch/healer-eval/prompts-snapshot/index.json` (snapshot mode) where a corresponding `responses/NNN.txt` file exists:

1. Read the prompt file: `packages/tools/local-batch/healer-eval/prompts/FILENAME` (fresh mode) or `packages/tools/local-batch/healer-eval/prompts-snapshot/prompts/FILENAME` (snapshot mode)
2. Read the response: `packages/tools/local-batch/healer-eval/responses/NNN.txt` (verify and strip the `MATCHID:` header)
3. Note the match `result` (Win/Loss/Unknown) from the index file
4. Read this match's entry in `quality-report.json` (if present) — the measured coverage/noise/bias metrics

Apply the three-pass process and anchored rubric below. Write the result to `packages/tools/local-batch/healer-eval/scores/NNN.json` (create `scores/` if needed).

### Three-pass scoring process (mandatory order)

**PASS 1 — Fact audit (before any score):** identify the 3 most load-bearing claims in the coaching
response (spell casts, timestamps, death causes). For each, find the exact prompt line that proves
or disproves it. Record these in the score file's `factAudit` array. No approximations — quote the
line. A claim with no supporting line is a fabrication.

**PASS 2 — Anchored dimension assessment:** for each of the 7 dimensions, write one sentence of
evidence, then pick the score using the anchors below. Where `quality-report.json` has a measured
value for this match, the score must be consistent with it (rules inline below); cite the number.

**PASS 3 — JSON generation:** write the score file only after passes 1–2.

### Rubric (anchored: 1 / 3 / 5; use 2 and 4 for in-between cases)

**Prompt quality:**

- **sufficiency** — is the data needed to identify what mattered present?
  - 5: CC chains with durations, dampening progression, enemy major CDs, and HP context all present.
  - 3: exactly one key area missing (e.g., CC present but no dampening progression).
  - 1: major segments absent (no CD usage, no CC timing).
  - Consistency rule: if `quality-report.json` shows a missing friendly death for this match, sufficiency ≤ 2. If any coverage category (cc/kicks/dispels) is below 80%, sufficiency ≤ 3.

- **noise** — do redundant lines dilute attention?
  - 5: no repeated states or proc spam; every line is a state change.
  - 3: ~10–30% of lines are repeated/unchanged status (e.g., `[RES] rdy:` spam).
  - 1: >50% of the timeline is spam or repetition.
  - Consistency rule: score from the measured `exactDuplicateRatio` / `resReadySpamLines` for this match, not from impression; cite the numbers in the evidence sentence.

- **labelBias** — do labels steer conclusions before reasoning?
  - 5: neutral headers; severity flags only where backed by the data (e.g., real sub-25% HP drop).
  - 3: minor steering (a routine 50% HP dip labeled a "spike").
  - 1: loaded language on ordinary events ("disastrous", `[CRITICAL]` on minor trades).
  - Consistency rule: if the measured severity-lexicon hits are 0, labelBias ≥ 4 unless you can quote a specific biased framing the lexicon missed.

- **inferenceScaffolding** — can cause → effect be read off the structure?
  - 5: chronological; deaths/trinkets colocated with the damage/CC that triggered them.
  - 3: chronological but triggers separated from reactions by filler.
  - 1: events out of order or triggers detached from outcomes.

**Response quality:**

- **accuracy** — does the response only cite events that exist in the prompt?
  - 5: all PASS-1 claims verified; zero factual errors.
  - 3: 1–2 minor errors (timestamp off by a few seconds, secondary proc misnamed).
  - 1: a fabricated spell/window/death or advice addressed to a dead/absent player.

- **outcomeAlignment** — does the coaching explain the actual result?
  - 5: identifies the causal sequence that decided the match.
  - 3: mentions the result but attributes it to generic play.
  - 1: ignores or contradicts the result. (Unknown result: grade on whether the key turning points are identified.)

- **focusCalibration** — are the highest-leverage moments prioritized?
  - 5: the 2–3 match-deciding windows dominate the coaching.
  - 3: correct moments found but equal time spent on trivia.
  - 1: match-deciding moment ignored in favor of minor details.

### Score file format

Write `packages/tools/local-batch/healer-eval/scores/NNN.json`:

```json
{
  "ordinal": 1,
  "matchId": "abc123",
  "spec": "Priest_Discipline",
  "result": "Loss",
  "durationSec": 187,
  "factAudit": [
    {
      "claim": "Exact quote of a load-bearing claim from the response.",
      "evidence": "The exact prompt line (with timestamp) that proves or disproves it.",
      "verified": true
    }
  ],
  "prompt": {
    "sufficiency": 3,
    "noise": 4,
    "labelBias": 2,
    "inferenceScaffolding": 3,
    "notes": "One sentence explaining the key prompt quality issue, citing quality-report metrics where applicable."
  },
  "response": {
    "accuracy": 5,
    "outcomeAlignment": 2,
    "focusCalibration": 3,
    "notes": "One sentence explaining the key response quality issue."
  }
}
```

All 7 numeric scores must be integers 1–5. The `notes` fields must be non-empty strings. `factAudit`
must contain exactly 3 entries with quoted evidence (or an explicit "no supporting line found").

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

After writing the report, append one run-summary row to `docs/eval-ledger.md` (git-tracked; see the
format header in that file — date, git commit, mode, match count, per-dimension mean±SD, and the
quality-check hard-failure count). The score files themselves are gitignored and get overwritten —
the ledger row is the only durable record of this run, so never skip it.

Then print: "Eval complete. Report written to packages/tools/local-batch/healer-eval/eval-report.md"

---

## Notes

- **No external dependencies:** The entire pipeline (Steps 1–4) runs within this AI session. Step 1 uses an existing npm script. Steps 2–4 use only file I/O. No API keys, no new scripts, no external services.
- Do not call any external AI API during any step. You (this AI session) generate responses in Step 2 and judge them in Steps 3–4.
- Do not create new `.ts`, `.js`, or `.py` files. Do not modify any source code files during this command.
- If `index.json` has more than 50 entries, only evaluate the first 50.
- Score files are cumulative — if scores already exist from a prior run, overwrite them.

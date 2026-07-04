---
name: calibrate-judge
description: Use before trusting LLM-judge scores (new judge prompt, new rubric, new model, or periodically) — verifies the judge detects planted defects via the synthetic-defect suite. No human annotation required.
---

Calibrate the LLM judge against synthetic defects with known ground truth. This is the meta-eval
for the healer eval pipeline: instead of a human gold standard, we inject defects we control
(fabricated claims, duplicated noise, loaded labels, shuffled order, deleted death lines) and
verify the judge scores each perturbed variant lower than its unmodified sibling on the targeted
dimension.

**When to run:** after any change to the scoring rubric in `eval-healer-prompts.md`, when switching
the judge to a different model/session type, or before trusting an A/B comparison whose deltas are
small (< 0.5 avg).

## Step 1: Build the suite

Requires a completed `/eval-healer-prompts` run (needs `prompts/`, `responses/`, `index.json`):

```bash
npm run -w @wowarenalogs/tools start:buildJudgeCalibrationSuite
```

Output: `packages/tools/local-batch/healer-eval/judge-calibration/cases/case-NN/{prompt.txt,response.txt}`
(~25–30 cases from 5 source matches), plus `calibration-manifest.json`.

> **BLINDING RULE (non-negotiable):** neither you (the orchestrator) nor any scoring sub-agent may
> read `calibration-manifest.json` before all scores are written. It maps case ids to the injected
> defects; reading it invalidates the calibration. Only `start:checkJudgeCalibration` reads it.

## Step 2: Blind-score every case

For each directory under `judge-calibration/cases/`, spawn a background sub-agent (same execution
model as `eval-healer-prompts.md` Step 2 — no external API). Each sub-agent gets ONLY this,
self-contained (substitute CASEID):

> You are scoring a WoW arena coaching prompt/response pair. Read:
> `packages/tools/local-batch/healer-eval/judge-calibration/cases/CASEID/prompt.txt` (the match
> context given to the coach) and `.../CASEID/response.txt` (the coaching output).
>
> Apply the scoring rubric from `docs/commands/eval-healer-prompts.md` Step 3 exactly — including
> the three-pass process (fact audit → anchored dimension assessment → JSON) and the 1/3/5 anchors.
> Do not read any other file, directory listing, or manifest.
>
> Write ONLY the score JSON (the standard 7-dimension format with `prompt` and `response` blocks)
> to `packages/tools/local-batch/healer-eval/judge-calibration/scores/CASEID.json`.

Spawn all sub-agents at once. Every case must be scored by an agent that saw nothing but its own
pair — never score two cases in one agent (it could notice near-duplicate prompts and infer the
perturbation).

## Step 3: Check detection rates

```bash
npm run -w @wowarenalogs/tools start:checkJudgeCalibration
```

Writes `judge-calibration/calibration-report.md` and prints per-dimension detection rates.
Exit code 1 (FAIL) if any dimension detects < 80% of its planted defects (override with
`PASS_THRESHOLD`).

## Interpreting results

- **PASS** — judge scores on these dimensions carry signal; A/B deltas can be taken seriously
  (still subject to the sample-size caveats in `improve-healer-prompts.md`).
- **FAIL on a dimension** — the judge cannot see that defect class. Do NOT act on A/B deltas for
  that dimension. Fix the rubric anchors or judge prompt in `eval-healer-prompts.md`, rebuild
  nothing (suite is unchanged), rescore (Step 2), recheck.
- Log every run's verdict in `docs/eval-ledger.md` (see that file's format).

## Notes

- The suite is deterministic for a given `SEED` (default 42) — rescoring after a rubric change is
  a controlled comparison.
- To harden the suite over time, add a new perturbation to `buildJudgeCalibrationSuite.ts` whenever
  a real judge failure is discovered (same discipline as `regression-gate.md`: every judge bug
  becomes a planted defect).
- Score files here are calibration artifacts, not eval results — never mix them into
  `healer-eval/scores/`.

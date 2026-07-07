# Healer Eval Improvement Workflow

How to orchestrate the two-skill eval pipeline: find prompt quality issues, validate fixes, and adopt or abandon them. The skill internals (pipeline steps, rubric, state phases) live in the two command docs — this page only covers how the cycle fits together.

---

## Choosing the Right Harness

| Harness                                                         | Question it answers                           | Tests                                                                                        |
| --------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`/eval-healer-prompts`](commands/eval-healer-prompts.md)       | "What should we fix?"                         | Prompt + response quality across fresh matches                                               |
| [`/improve-healer-prompts`](commands/improve-healer-prompts.md) | "Did we fix it?"                              | A specific _prompt-builder code_ change (blinded, paired A/B)                                |
| [`evalPromptCompare`](prompt-ab-testing-workflow.md)            | "Is the new system prompt better?"            | _System prompt text_ changes (`SYSTEM_PROMPT` / `NEW_SYSTEM_PROMPT`)                         |
| `start:promptQualityCheck`                                      | "What does the builder measurably drop/spam?" | Deterministic coverage vs raw-log manifest, duplicate ratios, severity-lexicon hits — no LLM |
| [`/calibrate-judge`](commands/calibrate-judge.md)               | "Can the judge be trusted at all?"            | Judge detection of planted synthetic defects (the meta-eval; no human labels)                |
| [`regression-gate`](commands/regression-gate.md)                | "Did a past accuracy fix regress?"            | Golden-game invariants on the production context builder                                     |

Trust order: deterministic checks (`promptQualityCheck`, `regression-gate`) are always valid;
LLM-judge scores are valid only while the current rubric/judge passes `/calibrate-judge`. When a
judge delta and a deterministic metric disagree, the deterministic metric wins.

Cross-model checks (added 2026-07-07, see the verifiability audit):

- **Judge spot-audit** — after each full eval run: `node scripts/judge-spot-audit.mjs --count 5`.
  An independent cross-family model re-checks sampled factAudit claims against the full
  prompt/response artifacts and reports an agreement rate (report lands in the eval dir as
  `spot-audit-report.md`). Baseline from the first real run (2026-07-07): **12/15, 80%** —
  investigate the judge (via `/calibrate-judge`) if a later run drops well below that.
- **Prompt ambiguity audit** — each eval cycle, run 2 fresh prompts through
  `agy-run ask --model pro` asking for concrete notational ambiguities. **Always provide the
  system prompt alongside the user prompt** (first-run lesson: omitting it produced ~7 false
  positives on notation the legend already defines). Findings feed the system-prompt legend via
  the `evalPromptCompare` A/B workflow, never direct edits. First-run findings:
  `docs/analysis/2026-07-07-c5-prompt-ambiguity-audit.md`.
- **Score provenance** — every new score file must carry the `provenance` block (see the score
  file format in `commands/eval-healer-prompts.md`); `node scripts/check-score-provenance.mjs`
  runs in pre-commit and fails on tampered or incomplete post-2026-07-07 scores.

---

## The Cycle

```
/eval-healer-prompts                    # find what to fix
  ↓ (pick an issue from the report's Top 3)
/improve-healer-prompts                 # establish control (BEFORE any code change)
  ↓ (implement your change to the prompt builder)
/improve-healer-prompts                 # run treatment (after code change)
  ↓ (fix-now items if any — iterate against the same control)
/improve-healer-prompts                 # iterate treatment (optional, repeatable)
  ↓
/improve-healer-prompts adopt|abandon   # conclude, clean up, print rubric feedback
  ↓
/eval-healer-prompts                    # new baseline
```

Rules that keep the comparison controlled:

- Establish the control **before** implementing your change.
- Between control and conclude, do not run `/eval-healer-prompts` — it fetches new matches and would break the paired comparison.
- You can iterate treatment as many times as needed; the control stays fixed until you conclude.
- If abandoning, revert your code change.
- After concluding, review the printed rubric feedback and manually update `commands/eval-healer-prompts.md` if warranted.

---

## State File

`/improve-healer-prompts` tracks its phase in `packages/tools/local-batch/healer-eval/ab-test/state.json` (gitignored, local only). See the command doc for the schema.

Check the current phase: `cat packages/tools/local-batch/healer-eval/ab-test/state.json`

Hard reset if something goes wrong:

```bash
rm -rf packages/tools/local-batch/healer-eval/ab-test/
rm -rf packages/tools/local-batch/healer-eval/raw-logs/
```

## Disk Usage

Raw combat logs persist from control until conclude — 1–10 MB each, up to ~200 MB for 20 matches. All are deleted automatically on `adopt` or `abandon`.

---

(The former "Gemini CLI Instructions" section was removed 2026-07-04 — the Gemini CLI is no longer
part of this workflow. The skills are Claude Code commands; any other agent following them should
map tool names to its own equivalents.)

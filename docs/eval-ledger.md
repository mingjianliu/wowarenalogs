# Eval Ledger

Append-only, git-tracked record of every eval / A/B / calibration run. Everything under
`packages/tools/local-batch/` is gitignored and gets deleted or overwritten between cycles — a row
here is the only durable record of a run, which is what makes quality trends visible across weeks.

Rules:

- **Append, never edit or delete rows.** Corrections get a new row with a note.
- One row per run, written by the agent that ran it (the command docs say when).
- `corpus` is a fingerprint: match count + first/last matchId (e.g. `20: ab12..ef90`), so two rows
  are comparable only if the fingerprint matches.
- Means are reported as `mean±SD`. Unknown/not-applicable cells: `—`.

## Baseline evals (`/eval-healer-prompts`)

| Date | Commit | Mode | Corpus | suff | noise | bias | scaf | acc | outcome | focus | Hard failures | Notes |
| ---- | ------ | ---- | ------ | ---- | ----- | ---- | ---- | --- | ------- | ----- | ------------- | ----- |
| 2026-07-04 | 26e4b66d+wt | fresh | 20: 196d86fb..75dead72 | 2.95±0.22 | 4.00±0.46 | 4.95±0.22 | 4.95±0.22 | 3.85±0.81 | 4.90±0.31 | 4.50±0.61 | 0 | First post-overhaul baseline. Sufficiency ~3 across the board is a consistency-rule artifact (dispel coverage low BY DESIGN per F163 — fix the checker split, not the builder). Det. metrics: deaths/kicks 100%, cc ~81%, trinket ~90%. Top real leak: CC target-attribution errors in ~8/20 responses (F139). |

## A/B cycles (`/improve-healer-prompts`)

| Date       | Commit      | Change tested                                        | Target dim                       | Pairs | Target Δ (95% CI)                            | Verdict  | Decision | Notes                                                                                                                                                                                                                          |
| ---------- | ----------- | ---------------------------------------------------- | -------------------------------- | ----- | -------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-07-04 | 73f6b4e5+wt | F20 pilot: [KICK] timeline lines for SPELL_INTERRUPT | sufficiency (det. kick coverage) | 10    | 12%→100%, +88pp, 10/10 pairs (deterministic) | IMPROVED | adopt    | Blind judge: all 7 dims inconclusive, no CI regression; judge sufficiency 4.9 both arms = circularity confirmed again. +1.4% tokens. Regression gate ALL GREEN. Next-cycle: pet-kick owner attribution, dispel coverage (38%). |

## System-prompt A/B (`evalPromptCompare`)

| Date | Commit | Change tested | Matches | Treatment W/T/L | Token Δ (in/out) | Decision | Notes |
| ---- | ------ | ------------- | ------- | --------------- | ---------------- | -------- | ----- |

## Judge calibrations (`/calibrate-judge`)

| Date       | Commit      | Judge/rubric version                               | Cases          | Failing dimensions         | Verdict | Notes                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ----------- | -------------------------------------------------- | -------------- | -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-04 | bbd792eb+wt | anchored 3-pass rubric v1, Sonnet scorers, seed 42 | 18 (3 src × 6) | noise 67%, sufficiency 33% | FAIL    | accuracy/scaffolding/labelBias 100%. Failing dims are exactly the ones with deterministic backing: calibration cases lack quality-report.json, so judges eyeballed noise and could not see removed deaths (circularity confirmed empirically). Real pipeline grounds both dims in promptQualityCheck; treat judge-only noise/sufficiency scores as no-signal. |
| 2026-07-04 | 26e4b66d+wt | anchored 3-pass rubric v1 + 7 defect classes, Sonnet scorers, seed 42 | 24 (3 src × 8) | noise 67%, outcomeAlignment 67%, sufficiency 33% | FAIL | Round 2. accuracy/scaffolding/labelBias/focusCalibration 100% — both NEW classes (wrong-outcome, trivia-focus) detected; wrong-outcome baseline 67%. noise/sufficiency unchanged (deterministic metrics own those dims). Gemini dual-judge attempted but CLI hangs in non-interactive mode even on trivial prompts — deferred; scores-gemini/ + SCORES_DIR support ready when CLI works. |

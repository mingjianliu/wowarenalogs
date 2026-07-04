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

# Prompt A/B Testing & Evaluation Workflow

This document outlines the standard workflow for evaluating system prompt changes using the stateful A/B Prompt Comparison System. 

Any AI agent (Gemini, Antigravity, Claude Code) or human developer proposing changes to WoW Arena Logs' system prompts MUST run this comparison workflow to verify analytical improvements and token efficiency before submitting changes.

## System Overview
The evaluation system lives in [evalPromptCompare.ts](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/src/evalPromptCompare.ts) and is registered as the npm script `start:evalPromptCompare` in the `@wowarenalogs/tools` package. 

Instead of ad-hoc manual inspections, the system uses a **two-phase stateful batch runner** with an automated LLM Judge to produce objective comparison reports.

---

## The Workflow Steps

```mermaid
graph TD
    A[Modify System Prompt] --> B[Run Phase 1: Control]
    B --> C[Generate Control Prompts/Responses & state.json]
    C --> D[Run Phase 2: Treatment]
    D --> E[Regenerate Prompts with Reflection Instructions]
    E --> F[Call LLM Judge for A/B comparison]
    F --> G[Generate comparison-report.md]
```

### Phase 1: Control Run
Before making prompt modifications (or using a baseline), compile the "Control" dataset. This builds the match corpus and establishes the reference responses.

```bash
npm run -w @wowarenalogs/tools start:evalPromptCompare -- --phase control --count 10
```

**What it does:**
1. **Corpus Assembly**: Scans cached raw logs in `local-batch/healer-eval/raw-logs/` and `packages/parser/test/testlogs/`. If needed, downloads further matching retail 3v3 match logs from the WoW Arena Logs production API to fill the quota.
2. **State Locking**: Saves the selected match IDs, spec distributions, and metadata to a state file: `local-batch/compare/state.json`.
3. **Control Output Generation**: Builds prompts using the current codebase, calls the baseline system prompt (`SYSTEM_PROMPT` or `NEW_SYSTEM_PROMPT`), and saves:
   - Control prompts: `local-batch/compare/control/prompts/<matchId>.txt`
   - Control responses: `local-batch/compare/control/responses/<matchId>.txt`
   - Token usage: `local-batch/compare/control/tokens.json`

### Phase 2: Treatment Run
After applying your prompt changes (e.g. editing `NEW_SYSTEM_PROMPT` or wrapping context instructions), run the "Treatment" phase.

```bash
npm run -w @wowarenalogs/tools start:evalPromptCompare -- --phase treatment
```

**What it does:**
1. **Corpus Lockout**: Reads `state.json` to ensure the exact same corpus of match IDs and perspectives is evaluated.
2. **Prompt Wrapping & Reflection**: Wraps generated match prompts in XML blocks:
   - `<core_prompt>`: contains the match context.
   - `<meta_eval_instructions>`: requests the model to partition its output into `<core_response>` (the coaching findings) and `<meta_eval_reflection>` (internal reasoning/critique).
3. **Execution**: Sends the wrapped prompt along with the updated system instructions to Claude Sonnet.
4. **LLM Evaluation**: Invokes an independent LLM Judge (`callMetaEvalJudge`) to compare the Control response vs the Core Treatment response (stripped of XML/reflection overhead) across:
   - **Feature Usefulness**: Value of recommendations.
   - **Response Bias**: Objectivity.
   - **Noise/Confusion**: Text clarity.
   - Verdicts: `Version A Winner`, `Version B Winner`, or `Tie`.
5. **Token Normalization**: Calculates raw token counts, subtracting meta-instruction and reflection token overhead to compute the true net change in token consumption.
6. **Report Generation**: Writes the final comparison table and average statistics to:
   - [comparison-report.md](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/compare/comparison-report.md)

---

## Script Options
- `--phase <control|treatment>` (Required): Phase selection.
- `--count <N>` (Optional, default `10`): Number of matches to run during control corpus generation.
- `--healer` (Optional): Forces healer perspective logs for the evaluation pool.

---

## Verifying Results
Always check the output markdown report. The proposed system prompt change is considered successful if:
1. **Verdict Win-Rate**: Version B (Treatment) wins or ties the majority of matches.
2. **Token Efficiency**: The net token count (excluding overhead) does not increase dramatically unless offset by significant analytical quality gains.
3. **No regressions**: No typescript compile errors or eslint errors are introduced. Ensure this by running `npm run -w @wowarenalogs/tools lint` after completion.

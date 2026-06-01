# Skill: prompt-abtest-automation
Description: Automate execution of the system prompt A/B testing workflow, generate comparison reports, and evaluate model responses for proposed changes.

## Overview
This skill provides instructions for AI agents to run and verify system prompt changes via the batch comparison scripts. Use this skill when the user asks you to:
- Test a system prompt modification.
- Compare a new system prompt variant against the baseline.
- Assess token efficiency and response quality for prompt changes.

## Step-by-Step Instructions

1. **Verify Setup**
   - Ensure the Anthropic API key is available in `process.env.ANTHROPIC_API_KEY`.
   - Ensure you are working inside the correct dev branch worktree.

2. **Phase 1: Establish Control (Baseline)**
   - Run the control script on 10 matches (or another requested count) to establish baseline responses:
     ```bash
     npm run -w @wowarenalogs/tools start:evalPromptCompare -- --phase control --count 10
     ```
   - Verify that `local-batch/compare/state.json` and files under `local-batch/compare/control/` are successfully created.

3. **Apply Your Changes**
   - Edit the system prompt file at [analyzeSystemPrompts.ts](file:///Users/mingjianliu/code/wowarenalogs/packages/shared/src/prompts/analyzeSystemPrompts.ts).

4. **Phase 2: Run Treatment (Proposed Prompt)**
   - Run the treatment script. This uses the exact same matches from the locked control phase, queries Sonnet with the modified system prompt, runs the LLM Judge evaluation, and generates the comparison report:
     ```bash
     npm run -w @wowarenalogs/tools start:evalPromptCompare -- --phase treatment
     ```

5. **Examine the Comparison Report**
   - Read the generated report at [comparison-report.md](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/compare/comparison-report.md).
   - Check the judge's verdicts (Win/Loss/Tie) and verify that the token changes are expected.

6. **Post-Evaluation Checks**
   - Run linter checks to ensure no formatting or typescript errors are introduced:
     ```bash
     npm run -w @wowarenalogs/tools lint
     ```

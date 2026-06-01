---
name: meta-eval-100-games
description: Collect 100 recent Arena games, generate AI evaluations on REAL responses, enforce strict reasoning verification against raw logs, and produce a consolidated prompt engineering report.
---

# Meta-Eval 100 Games

This skill orchestrates a rigorous, evidence-based evaluation of the WoW Arena Logs AI coaching prompt builder. It evaluates 100 recent games using REAL generated responses, strictly forbidding approximations or heuristics, and forces the evaluator to trace the coach's reasoning back to exact lines in the combat log.

## STRICT RULES
1. **NO HEURISTICS OR APPROXIMATIONS:** Do not guess if a prompt is "good enough" or if a response "seems right." Get to the EXACT problem.
2. **USE REAL RESPONSES:** You must generate and read the actual coaching response for every single match. Do not evaluate a prompt in a vacuum.
3. **LOG VERIFICATION:** You must cross-reference claims made in the response directly against the raw combat log (the prompt file). If the coach says "You died without using trinket at 1:45", you must check the prompt at 1:45 to see if the trinket was indeed available and unused.
4. **PROBE REASONING:** You must ask *how* the AI reasoned about an event and document whether the prompt structure supported or hindered that reasoning.

---

## 1. Collect 100 Games

Run the following shell command to build the corpus:

```bash
TARGET_COUNT=100 npm run -w @wowarenalogs/tools start:buildHealerPromptCorpus
```

*Wait for this process to complete before proceeding.* It will output the dataset to `packages/tools/local-batch/healer-eval/prompts/` and an `index.json`.

## 2. Generate Responses (Real Role Playing)

For each prompt in the generated corpus, you must spawn a background sub-agent using the `invoke_agent` tool (or `@generalist`) to act as the AI coach and generate a real response. 

**Sub-Agent Prompt Template:**
```
You are a WoW arena coach. Read the match prompt from:
packages/tools/local-batch/healer-eval/prompts/FILENAME

Produce coaching advice focusing on what went wrong/right, specific decisions, and concrete adjustments.
Write your coaching response (and nothing else) to:
packages/tools/local-batch/healer-eval/responses/NNN.txt
(Where NNN is the ordinal 001-100).
```

*Wait for all sub-agents to complete. You MUST have the actual `responses/NNN.txt` files before moving to step 3.*

## 3. Strict Verification & Evaluation

For each of the 100 games, act as an evaluator. You MUST read BOTH the original prompt (`prompts/FILENAME`) and the generated response (`responses/NNN.txt`). 

Write your evaluation to `packages/tools/local-batch/healer-eval/scores/NNN.json`.

**Evaluation Process:**
1. **Extract a Claim:** Identify a major claim or piece of advice in the generated response.
2. **Trace Reasoning:** Ask: *How did the coach reason about this? What information in the prompt led to this conclusion?*
3. **Verify against Log:** Look back at the exact timestamps in the raw combat log (prompt) to verify if the coach's reasoning is factually correct.
4. **Identify Exact Problems:** If there is a bug, do not write "Model hallucinated." Write the EXACT problem: e.g., "Model claimed Ironbark was used at 1:12, but log shows Ironbark at 1:15 on a different target. The prompt grouped the events confusingly."

Format the JSON file as:
```json
{
  "ordinal": NNN,
  "matchId": "...",
  "spec": "...",
  "verification": {
    "coachClaim": "Exact quote or major claim from the coach's response.",
    "coachReasoning": "How the coach arrived at this conclusion based on the prompt's layout.",
    "logEvidence": "Exact timestamp and event from the raw prompt that proves or disproves this claim.",
    "isAccurate": true // or false
  },
  "prompt": {
    "labelBias": "Score 1-5 + EXACT heuristic label that caused bias (if any)",
    "noise": "Score 1-5 + EXACT line/spam pattern that caused noise",
    "sufficiency": "Score 1-5 + EXACT missing event type or context"
  },
  "response": {
    "accuracy": "Score 1-5",
    "exactProblem": "If inaccurate, what EXACTLY went wrong? Detail the discrepancy between the response and the raw log.",
    "misleadingInfo": "Describe any hallucinations or factual bugs.",
    "noisyInfo": "What exact prompt info confused the AI?",
    "usefulInfo": "What exact prompt info was most useful?",
    "promptStructureSuggestions": "Concrete, non-heuristic structural fixes."
  }
}
```

## 4. Write the Report

After all 100 evaluations are generated, parse the JSON files and generate a final report.
The report MUST contain:
1. **The Exact Issues (Merged by Topic):**
   Group all identified issues (from `exactProblem`, `misleadingInfo`, `promptStructureSuggestions`) by their underlying cause.
2. **Evidence & Related Matches:**
   Under every issue, list the exact matches (by ordinal/ID) AND the `verification.logEvidence` or `response.exactProblem` to prove exactly what happened. 
   
Present this report directly to the user in your final response.

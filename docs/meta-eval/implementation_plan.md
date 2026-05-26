# Implementation Plan — Healer Evaluation Pipeline Improvements

We will enhance the healer evaluation pipeline by adding anchored score definitions, enforcing Chain-of-Thought (CoT) reasoning on the judge, and establishing an automated calibration script to align LLM ratings with human ground-truth annotations.

---

## 1. Concrete Design Details

### A. Anchored Rubric & CoT Prompting
We will update [eval-healer-prompts.md](file:///Users/mingjianliu/code/wowarenalogs/docs/commands/eval-healer-prompts.md) to define a strict 3-pass evaluation flow for the judge:

1.  **PASS 1: Fact Audit & Evidence Gathering**
    *   List 3 specific claims in the coaching response and find their matching timestamps in the prompt timeline.
    *   Verify dampening numbers, target names, and spell IDs.
2.  **PASS 2: Anchored Rubric Scoring**
    The judge evaluates each of the 7 dimensions using explicit **1 (Fail) / 3 (Moderate) / 5 (Excellent)** anchors:
    *   *sufficiency*:
        *   **5**: Prompt contains all logs: CC chains with durations, dampening, enemy CDs, and HP snapshots.
        *   **3**: Missing one key area (e.g., CC chains are present but no dampening progression is visible).
        *   **1**: Barely any contextual information, or missing major segments like CD usages entirely.
    *   *noise*:
        *   **5**: Zero repeat states or proc spams. Every line represents critical state changes.
        *   **3**: 10–30% of lines are repeated state checks (e.g., repeating unchanged player ready states).
        *   **1**: Severe noise (e.g., >50% of the timeline is spammy passive procs or repetitive status lines).
    *   *labelBias*:
        *   **5**: Fully objective, neutral headers. No severity flags like `[CRITICAL]` unless backed by real HP drops < 25%.
        *   **3**: Minor steering in headers (e.g., calling a 50% HP drop a "spike").
        *   **1**: Highly loaded language in headers (e.g. calling minor CD trades "disastrous mistakes" or "critical failures").
    *   *inferenceScaffolding*:
        *   **5**: Events perfectly aligned chronologically; responses and deaths are colocated with their triggers.
        *   **3**: Chronologically ordered, but related actions are separated by too many filler events.
        *   **1**: Events out of order or triggers completely detached from their reactions.
    *   *accuracy*:
        *   **5**: Zero factual errors. All mentioned spells, timestamps, and outcomes are verified.
        *   **3**: 1–2 minor errors (e.g., citing a timestamp offset by 3 seconds or slightly misnaming a secondary proc).
        *   **1**: Severe hallucinations (e.g., inventing a death window, accusing a player of using a talent they do not have).
    *   *outcomeAlignment*:
        *   **5**: Directly identifies and explains the causal sequence leading to the win/loss.
        *   **3**: Mentions the result but attributes it to generic play rather than specific game-ending chains.
        *   **1**: Completely ignores the match result or contradicts it.
    *   *focusCalibration*:
        *   **5**: Prioritizes the 2-3 highest-leverage windows (e.g. major cooldown trade failures).
        *   **3**: Identifies the correct moments but spends equal time explaining low-impact details.
        *   **1**: Ignores the main event (e.g. details a buff duration while ignoring a teammate dying in a stun).
3.  **PASS 3: JSON Generation**
    *   Output the scores based on the audits.

---

### B. Calibration Script (`runMetaEvalCalibration.ts`)
The script [runMetaEvalCalibration.ts](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/src/runMetaEvalCalibration.ts) will do the following:

1.  Read `packages/tools/local-batch/healer-eval/meta-eval-gold/index.json`.
2.  If the dataset is empty or skeleton, log a warning and exit cleanly: `"Gold standard dataset is empty. Please place prompts and responses in the meta-eval-gold directory."`
3.  For each entry:
    *   Load prompt and response files.
    *   Construct the CoT system and user prompts.
    *   Invoke Claude (using `@anthropic-ai/sdk` with the key from `dotenv`).
    *   Extract the json score output.
4.  Compute alignment metrics:
    *   **Mean Absolute Error (MAE)**:
        $$\text{MAE}_d = \frac{1}{N} \sum_{i=1}^N |S_{LLM, i} - S_{human, i}|$$
    *   **Exact Match Agreement Rate**:
        $$\text{Agreement}_d = \frac{\sum_{i=1}^N \mathbb{I}(S_{LLM, i} == S_{human, i})}{N} \times 100\%$$
    *   **Spearman Rank Correlation ($\rho$)**:
        For $N \ge 5$ matches, compute the rank correlation of the LLM vs human scores per dimension to measure ranking alignment:
        $$\rho = 1 - \frac{6 \sum d_i^2}{N(N^2 - 1)}$$
5.  Generate a markdown report in `packages/tools/local-batch/healer-eval/meta-eval-calibration-report.md`.

---

## Proposed Changes

### Component 1: CLI Document Updates

#### [MODIFY] [eval-healer-prompts.md](file:///Users/mingjianliu/code/wowarenalogs/docs/commands/eval-healer-prompts.md)
*   Integrate anchored definitions (1/3/5 scale) into the rubric section.
*   Update Step 3 to detail the 3-Pass evaluation prompt template.

---

### Component 2: Calibration Code & Package Setup

#### [MODIFY] [package.json](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/package.json)
*   Add `"start:runMetaEvalCalibration"` script.

#### [NEW] [runMetaEvalCalibration.ts](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/src/runMetaEvalCalibration.ts)
*   Create the main execution logic for evaluation calibration.

---

### Component 3: Skeleton Gold Standard Dataset

#### [NEW] [index.json](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/meta-eval-gold/index.json)
*   Create a skeleton JSON array structure with examples of how data should be formatted.

#### [NEW] [prompts & responses skeleton folders](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/meta-eval-gold/)
*   Create `meta-eval-gold/prompts/` and `meta-eval-gold/responses/` directories with a `.gitkeep` file.

---

## Verification Plan

### Automated Tests
*   Run typescript build and linter to check for compilation/formatting errors:
    ```bash
    npm run -w @wowarenalogs/tools lint
    ```
*   Run the script with an empty dataset to verify the skeleton warnings work:
    ```bash
    npm run -w @wowarenalogs/tools start:runMetaEvalCalibration
    ```

---

## 4. LLM Judge System Prompt Spec

Below is the concrete system prompt that `runMetaEvalCalibration.ts` will feed to the Anthropic API. It guides the LLM through the 3-pass reasoning flow and enforces the anchored grading rubric:

```typescript
export const JUDGE_SYSTEM_PROMPT = `You are a WoW Arena PvP Evaluation Expert. Your task is to evaluate the quality of a match context prompt and a generated coaching response.

Input:
1. MATCH TIMELINE PROMPT: The context provided to the coach.
2. COACHING RESPONSE: The coaching output generated based on the match prompt.

Your evaluation must follow a strict three-pass process. You must write out your reasoning steps for each pass before outputting the final scores.

PASS 1: FACT AUDIT (Evidence Gathering)
Verify the accuracy of the coaching response against the timeline:
- Identify 3 specific claims made in the coaching response (e.g. spell casts, timestamps, death window details).
- Locate these events in the timeline prompt.
- List any discrepancies, wrong timestamps, or hallucinated spells/outcomes.

PASS 2: DIMENSION ASSESSMENT
Evaluate and justify a score (1-5 integer) for each of the following 7 dimensions. For each dimension:
- First, write out a short reasoning audit detailing the evidence.
- Second, select a score based on the explicit anchors below.

PROMPT QUALITY DIMENSIONS:
1. sufficiency: Does the timeline prompt have all necessary context (CC timings, dampening, enemy cooldowns)?
   - 5 (Excellent): Complete logs present: CC chains with durations, dampening progression, enemy major CDs, and HP snapshots.
   - 3 (Moderate): Missing one key contextual element (e.g., CC chains present but no dampening progression).
   - 1 (Poor): Barely any contextual data; missing major segments like CD usages entirely.
2. noise: Are there redundant or verbose sections that dilute attention?
   - 5 (Excellent): Zero repeat states or proc spams. Every line represents critical state changes.
   - 3 (Moderate): 10-30% of the timeline consists of repeated status lines (e.g. unchanged ready states).
   - 1 (Poor): Severe noise; >50% of the timeline is spammy passive procs or repetitive status lines.
3. labelBias: Do section headers or labels steer the model toward a biased conclusion?
   - 5 (Excellent): Fully objective, neutral headers. No severity labels (e.g., [CRITICAL]) unless backed by real HP drops < 25%.
   - 3 (Moderate): Minor steering in headers (e.g., calling a 50% HP drop a "spike").
   - 1 (Poor): Highly loaded language in labels (e.g. calling minor CD trades "disastrous mistakes" or "critical failures").
4. inferenceScaffolding: Are events logically and chronologically structured to support cause-and-effect reasoning?
   - 5 (Excellent): Events perfectly aligned chronologically; responses and deaths are colocated with their triggers.
   - 3 (Moderate): Chronologically ordered, but related actions are separated by too many filler events.
   - 1 (Poor): Events out of order or triggers completely detached from their reactions.

RESPONSE QUALITY DIMENSIONS:
5. accuracy: Does the response reference only real events present in the timeline prompt?
   - 5 (Excellent): Zero factual errors. All mentioned spells, timestamps, and outcomes are verified.
   - 3 (Moderate): 1-2 minor errors (e.g., citing a timestamp offset by 3 seconds or slightly misnaming a secondary proc).
   - 1 (Poor): Severe hallucinations (e.g., inventing a death window, accusing a player of using a talent they do not have).
6. outcomeAlignment: Does the coaching plausibly explain why the match ended in a win or loss?
   - 5 (Excellent): Directly identifies and explains the causal sequence leading to the win/loss.
   - 3 (Moderate): Mentions the result but attributes it to generic play rather than specific game-ending chains.
   - 1 (Poor): Completely ignores the match result or contradicts it.
7. focusCalibration: Does the coach prioritize the highest-leverage decision points?
   - 5 (Excellent): Prioritizes the 2-3 highest-leverage windows (e.g. major cooldown trade failures).
   - 3 (Moderate): Identifies the correct moments but spends equal time explaining low-impact details.
   - 1 (Poor): Ignores the main event (e.g. details a buff duration while ignoring a teammate dying in a stun).

PASS 3: JSON GENERATION
Output a single JSON block at the very end of your response containing the scores. Do not wrap it in anything other than markdown code fences.
{
  "prompt": {
    "sufficiency": number,
    "noise": number,
    "labelBias": number,
    "inferenceScaffolding": number,
    "notes": "string summary"
  },
  "response": {
    "accuracy": number,
    "outcomeAlignment": number,
    "focusCalibration": number,
    "notes": "string summary"
  }
}`;
```

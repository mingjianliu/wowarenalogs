# Healer Prompt Evaluation & Meta-Evaluation Research Report

This report reviews the prompt and response evaluation criteria used in the WoW Arena Logs healer evaluation pipeline (defined in [eval-healer-prompts.md](file:///Users/mingjianliu/code/wowarenalogs/docs/commands/eval-healer-prompts.md) and [improve-healer-prompts.md](file:///Users/mingjianliu/code/wowarenalogs/docs/commands/improve-healer-prompts.md)). It compares them against industry standards, checks their validity for the domain, and proposes concrete improvements.

---

## 1. Audit of the Current 7 Criteria

The current pipeline evaluates healer coaching prompts and generated responses across 7 dimensions (each scored 1–5):

### Prompt Quality Criteria
*   **`sufficiency`**: Evaluates if critical arena context (CC chains, dampening, cooldown timelines) is present.
    *   *Verdict:* **Highly Appropriate.** WoW Arena is a high-context game. An LLM cannot analyze a match without knowing player resources, dampening levels, or CC timings.
*   **`noise`**: Evaluates redundancy and irrelevant events (passive proc spam, repeated unchanged statuses).
    *   *Verdict:* **Highly Appropriate.** WoW combat logs contain thousands of lines. Trimming noise directly keeps the context window clean, prevents attention dilution, and reduces token cost.
*   **`labelBias`**: Checks if heuristics apply loaded headers (e.g., `[CRITICAL]`) that steer the LLM.
    *   *Verdict:* **Highly Appropriate.** LLMs are highly susceptible to sycophancy and local bias; if a parser flags minor damage as "critical," the coach will hallucinate player panic.
*   **`inferenceScaffolding`**: Assesses if events are organized temporally (e.g., placing a death near the CC/burst that caused it).
    *   *Verdict:* **Highly Appropriate.** LLM attention works on proximity. Structuring cause and effect chronologically helps the LLM link setups to outcomes.

### Response Quality Criteria
*   **`accuracy`**: Checks for factual correctness against the prompt (no made-up spells or timestamps).
    *   *Verdict:* **Appropriate.** Grounding the LLM to the prompt data is the primary guardrail against hallucinated abilities.
*   **`outcomeAlignment`**: Measures if the coaching plausibly explains why the team won or lost.
    *   *Verdict:* **Appropriate.** For PvP coaching, the explanation must align with the outcome. However, a minor weakness is that "unknown" results are treated identically to losses, which may not always fit.
*   **`focusCalibration`**: Evaluates if the coach prioritizes high-leverage moments over trivial events.
    *   *Verdict:* **Appropriate.** Calibrates the coach to act like a gladiator-level player rather than just recapping the game chronologically.

---

## 2. Gaps in the Current Implementation

While the criteria themselves are conceptually sound, the current **evaluation execution** has several structural gaps compared to industry best practices:

### Gap A: Lack of Anchoring for Likert Scores (1–5)
*   **The Issue:** The rubric defines boundaries vaguely (e.g., "Some noise $\to$ 3", "Heavy repetition $\to$ 1-2"). Without explicit anchors for every score integer, the LLM judge's scores will drift between runs, model updates, or different contexts (low inter-rater reliability).
*   **Industry Standard:** Modern evaluation frameworks use **anchored rubrics**, defining precisely what a 1, 2, 3, 4, and 5 represent for each dimension.

### Gap B: Absence of Pre-Evaluation Chain-of-Thought (CoT)
*   **The Issue:** The evaluator currently outputs scores directly alongside a short, one-sentence `notes` field.
*   **Industry Standard (G-Eval / Confident AI):** LLM judges are significantly more accurate and align better with humans when they are forced to write a detailed, step-by-step reasoning trace *before* assigning a score.

### Gap C: No Automated Meta-Evaluation (Agreement/Correlation)
*   **The Issue:** We have no automated way to verify if the LLM judge's scores align with human experts. In A/B tests ([improve-healer-prompts.md](file:///Users/mingjianliu/code/wowarenalogs/docs/commands/improve-healer-prompts.md)), we trust the LLM judge's delta scoring blindly.
*   **Industry Standard:** Teams use a human-annotated **Gold Standard Dataset** (e.g., 20 representative matches human-scored on the 7 dimensions) and calculate:
    1.  **Cohen's Kappa ($\kappa$)** or **Percent Agreement**: For categorical agreement.
    2.  **Spearman's Rank Correlation ($\rho$)**: To measure if the judge's ranking matches human preferences.

### Gap D: Judge Susceptibility to Biases
*   **The Issue:** The LLM generating the response and the LLM judging it are both Claude/Gemini (though run in separate contexts). This introduces **self-preference bias** (model prefers its own formatting) and **verbosity bias** (longer coaching responses are scored higher on focus and alignment).

---

## 3. How We Can Improve (Proposed Roadmap)

### Action 1: Enforce a Reasoning-First (CoT) Judge Prompt
Modify the scoring loop so the evaluator must write an explicit evaluation trace before generating the JSON scores.

**Example Structured Scoring Prompt:**
```markdown
For the dimension "focusCalibration", evaluate as follows:
1. List all main events discussed in the coaching response.
2. Cross-reference them with the prompt's timeline. Were these the high-leverage moments?
3. Detail any minor events that received undue attention.
4. Conclude with a score from 1-5 based on the following anchors:
   - 5: Only high-leverage moments are coached; no minor fluff.
   - 3: High-leverage moments are coached, but equal time is spent on minor details.
   - 1: Focuses entirely on trivial events, ignoring the match-deciding CC/burst.
```

### Action 2: Establish a Human Gold Standard Dataset for Meta-Evaluation
Create a permanent directory: `packages/tools/local-batch/healer-eval/meta-eval-gold/`.
*   Store 15–20 matches where a human expert has pre-written the scores and justifications.
*   Write a script `npm run -w @wowarenalogs/tools start:metaEval` that runs the LLM judge on these matches and prints:
    *   **Average Absolute Error** per dimension.
    *   **Spearman Correlation ($\rho$)** and **Cohen's Kappa ($\kappa$)**.
*   This lets us mathematically verify if a change to the judge prompt or scoring rubric actually makes the judge better.

### Action 3: Mitigate Verbosity Bias
Add a rule to the response criteria:
*   Normalize the focus calibration or outcome alignment score based on length (or explicitly instruct the judge: *"A concise response that covers the key point in 100 words must score higher than a 500-word essay detailing every timestamp"*).

### Action 4: Include Variance and Confidence in A/B Comparisons
In `comparison-report.md`, instead of just comparing simple averages (e.g., `3.15 -> 4.10`), calculate:
*   **Standard Deviation ($\sigma$)** or **Mean Absolute Deviation (MAD)** of the deltas.
*   If the variance is high, flag that the sample size (20 matches) might be too small to confirm an improvement, preventing us from adopting noisy prompt changes.

# 100-Game Healer Prompt & Response Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conduct a comprehensive evaluation of 100 arena games (5 batches of 20) to assess the quality of healer prompts and Claude responses, identifying useful, noisy, and misleading information with game-backed evidence.

**Architecture:** 
- Scale up the existing `healer-eval` pipeline to 100 matches.
- Process in 5 distinct batches to manage context and state.
- Extend the scoring rubric to include specific qualitative feedback on "useful/noisy/misleading" info and prompt structure improvements.
- Synthesize a final report summarizing patterns across all 100 games.

**Tech Stack:** Node.js, ts-node, @wowarenalogs/parser, Claude (via sub-agents)

---

### Task 1: Setup and Corpus Generation

**Files:**
- Modify: `packages/tools/local-batch/healer-eval/index.json` (generated)
- Create: `packages/tools/local-batch/healer-eval/prompts/*.txt` (generated)

- [ ] **Step 1: Generate 100 healer prompts**
Run the corpus builder with `TARGET_COUNT=100`.
Run: `TARGET_COUNT=100 npm run -w @wowarenalogs/tools start:buildHealerPromptCorpus`
Expected: 100 prompts in `packages/tools/local-batch/healer-eval/prompts/` and an `index.json` with 100 entries.

- [ ] **Step 2: Verify the corpus**
Read `packages/tools/local-batch/healer-eval/index.json` and count entries.
Run: `cat packages/tools/local-batch/healer-eval/index.json | jq '. | length'`
Expected: 100 (or close to it if matches are scarce).

- [ ] **Step 3: Commit setup**
```bash
git add packages/tools/local-batch/healer-eval/index.json
git commit -m "eval: setup 100-game corpus for healer evaluation"
```

---

### Task 2: Process Batch 1 (Matches 1-20)

**Files:**
- Create: `packages/tools/local-batch/healer-eval/responses/001.txt` ... `020.txt`
- Create: `packages/tools/local-batch/healer-eval/scores/001.json` ... `020.json`

- [ ] **Step 1: Generate responses for Batch 1**
Spawn 20 background sub-agents to generate coaching advice for ordinals 001-020.
Use the template from `eval-healer-prompts.md`.

- [ ] **Step 2: Score Batch 1 with extended rubric**
For each response in Batch 1, score using the standard rubric plus:
- `usefulInfo`: string
- `noisyInfo`: string
- `misleadingInfo`: string
- `promptStructureSuggestions`: string
Verify claims against the prompt text.

- [ ] **Step 3: Commit Batch 1**
```bash
git add packages/tools/local-batch/healer-eval/responses/ packages/tools/local-batch/healer-eval/scores/
git commit -m "eval: complete processing for batch 1 (1-20)"
```

---

### Task 3: Process Batch 2 (Matches 21-40)

- [ ] **Step 1: Generate responses for Batch 2 (21-40)**
- [ ] **Step 2: Score Batch 2 with extended rubric**
- [ ] **Step 3: Commit Batch 2**

---

### Task 4: Process Batch 3 (Matches 41-60)

- [ ] **Step 1: Generate responses for Batch 3 (41-60)**
- [ ] **Step 2: Score Batch 3 with extended rubric**
- [ ] **Step 3: Commit Batch 3**

---

### Task 5: Process Batch 4 (Matches 61-80)

- [ ] **Step 1: Generate responses for Batch 4 (61-80)**
- [ ] **Step 2: Score Batch 4 with extended rubric**
- [ ] **Step 3: Commit Batch 4**

---

### Task 6: Process Batch 5 (Matches 81-100)

- [ ] **Step 1: Generate responses for Batch 5 (81-100)**
- [ ] **Step 2: Score Batch 5 with extended rubric**
- [ ] **Step 3: Commit Batch 5**

---

### Task 7: Final Synthesis and Report

**Files:**
- Create: `packages/tools/local-batch/healer-eval/100-game-report.md`

- [ ] **Step 1: Aggregate all 100 scores**
Read all 100 `.json` files in `scores/`.
Compute averages for sufficiency, noise, accuracy, etc.
Extract common themes from `usefulInfo`, `noisyInfo`, `misleadingInfo`.

- [ ] **Step 2: Write the 100-game report**
Follow the structure in `eval-healer-prompts.md` but expanded with the new qualitative sections.
Include specific "Game-Backed Evidence" sections for misleading info and prompt improvements.

- [ ] **Step 3: Final Review and Commit**
```bash
git add packages/tools/local-batch/healer-eval/100-game-report.md
git commit -m "eval: final 100-game healer evaluation report"
```

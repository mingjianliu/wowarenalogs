# Healer Evaluation Batch Processing (091-100) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide professional WoW arena coaching advice and prompt feedback for 10 healer match records (091-100) and save them to the responses directory.

**Architecture:** Iterative processing of each match timeline. For each match, I will analyze the cooldown usage, positioning (implied), and death sequences to provide actionable advice. I will also evaluate the prompt's effectiveness in conveying the match arc.

**Tech Stack:** Node.js (for file operations), WoW Arena domain knowledge.

---

### Task 1: Process Ordinals 091-093

**Files:**
- Read: `packages/tools/local-batch/healer-eval/prompts/09[1-3]-*.txt`
- Create: `packages/tools/local-batch/healer-eval/responses/091.txt`, `092.txt`, `093.txt`

- [ ] **Step 1: Analyze 091 (Mistweaver Monk - Loss)**
- [ ] **Step 2: Write response for 091**
- [ ] **Step 3: Analyze 092 (Restoration Shaman - Win)**
- [ ] **Step 4: Write response for 092**
- [ ] **Step 5: Analyze 093 (Mistweaver Monk - Win)**
- [ ] **Step 6: Write response for 093**

### Task 2: Process Ordinals 094-096

**Files:**
- Read: `packages/tools/local-batch/healer-eval/prompts/09[4-6]-*.txt`
- Create: `packages/tools/local-batch/healer-eval/responses/094.txt`, `095.txt`, `096.txt`

- [ ] **Step 1: Analyze 094 (Restoration Shaman - Win)**
- [ ] **Step 2: Write response for 094**
- [ ] **Step 3: Analyze 095 (Mistweaver Monk - Win)**
- [ ] **Step 4: Write response for 095**
- [ ] **Step 5: Analyze 096 (Restoration Shaman - Win)**
- [ ] **Step 6: Write response for 096**

### Task 3: Process Ordinals 097-100

**Files:**
- Read: `packages/tools/local-batch/healer-eval/prompts/09[7-9]-*.txt`, `100-*.txt`
- Create: `packages/tools/local-batch/healer-eval/responses/097.txt`, `098.txt`, `099.txt`, `100.txt`

- [ ] **Step 1: Analyze 097 (Restoration Shaman - Win)**
- [ ] **Step 2: Write response for 097**
- [ ] **Step 3: Analyze 098 (Mistweaver Monk - Loss)**
- [ ] **Step 4: Write response for 098**
- [ ] **Step 5: Analyze 099 (Restoration Shaman - Loss)**
- [ ] **Step 6: Write response for 099**
- [ ] **Step 7: Analyze 100 (Restoration Shaman - Loss)**
- [ ] **Step 8: Write response for 100**

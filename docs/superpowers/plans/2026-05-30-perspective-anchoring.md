# Perspective Anchoring & Hallucination Prevention (F137 + F150) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate AI perspective hallucinations by using explicit identity anchors ([YOU], [TEAM], [ENEMY]) and a perspective banner in the match timeline.

**Architecture:** 
- Modify `matchTimeline.ts` to rename internal label constants and add a banner injection point.
- Update `analyzeSystemPrompts.ts` to include grounding rules that define these new labels.
- Verify using existing CLI tools (`printMatchPrompts.ts`).

**Tech Stack:** TypeScript, React (shared components), Node.js (tools).

---

### Task 1: Update Timeline Labels and Banner (F150 + F137)

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`

- [ ] **Step 1: Refactor tag strings to personal/team/enemy format**

Modify `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`:
- Change `[OWNER CD]` to `[YOU] [CD]`
- Change `[OWNER CAST]` to `[YOU] [CAST]`
- Change `[OWNER CC]` to `[YOU] [CC]`
- Change `[TEAMMATE CD]` to `[TEAM] [CD]`
- Change `[TEAMMATE CC]` to `[TEAM] [CC]`
(And any other OWNER/TEAMMATE variants like `[OWNER DEATH]`, etc if they exist)

- [ ] **Step 2: Add Perspective Banner logic**

Inside `buildMatchTimeline`, before the timeline lines are joined, add the banner:
```typescript
  const outputLines: string[] = [
    'MATCH TIMELINE',
    '  Units: M = Million damage (1,000,000), k = Thousand damage (1,000)',
    '',
    `[PERSPECTIVE: Log Owner - ${ownerSpec}]`,
    `(You are the ${ownerSpec} in this match. Your actions are marked with [YOU].)`,
    '',
  ];
```

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts
git commit -m "feat(analysis): implement perspective anchoring labels [YOU]/[TEAM] (F150) and banner (F137)"
```

---

### Task 2: Update System Prompt Rules

**Files:**
- Modify: `packages/shared/src/prompts/analyzeSystemPrompts.ts`

- [ ] **Step 1: Update label definitions in NEW_SYSTEM_PROMPT**

Update the rules in `packages/shared/src/prompts/analyzeSystemPrompts.ts` to reflect the new labels.
Replace references to `[OWNER CD]` with `[YOU] [CD]` and `[TEAMMATE CD]` with `[TEAM] [CD]`.

- [ ] **Step 2: Add "Selfish Analysis" boundary rule**

Add the following to the `Core rules` or `Your task` section:
```text
- Focus exclusively on the decisions and resources of [YOU]. Do not treat a teammate's mistake as your own, but evaluate how that teammate's state (e.g., being in CC) should have influenced your own decision to trade or hold a resource.
```

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/prompts/analyzeSystemPrompts.ts
git commit -m "feat(prompts): update system prompt with identity grounding and analytical boundaries"
```

---

### Task 3: Verification with Local Logs

- [ ] **Step 1: Run local log analysis**

Run: `npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 1 --local --new-prompt`

- [ ] **Step 2: Verify output format**

Check that:
1. The banner `[PERSPECTIVE: Log Owner - ...]` appears.
2. Timeline events use `[YOU] [CD]` and `[TEAM] [CD]`.
3. The system prompt contains the new boundary rules.

- [ ] **Step 3: Cleanup evaluation scratch files**

```bash
rm eval_perspectives.ts scratch/timeline_*.txt scratch/generate_variants.js scratch/browser_eval.html
```

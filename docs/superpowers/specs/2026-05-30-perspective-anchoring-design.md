# Design Spec: Perspective Anchoring & Hallucination Prevention (F137 + F150)

## Problem Statement
The AI analysis occasionally suffers from "perspective hallucinations" where it misidentifies the log owner or attributes enemy/teammate actions to the player. This is particularly frequent in mirror matches (e.g., two Discipline Priests) or high-density 3v3 matches. Current labeling (`[OWNER CD]`) is too neutral and fails to anchor the LLM's identity in long contexts.

## Goals
- Eliminate perspective hallucinations in mirror matches.
- Strengthen the AI's focus on the log owner's specific decision-making.
- Maintain neutral framing for evaluation (avoiding sycophancy) while using personal identity for grounding.

## Proposed Changes

### 1. Identity Anchoring (Data Formatting)
We will refactor the timeline and facts sections to use explicit, personal identity markers.

- **F137 (Perspective Banner):** Add a prominent banner immediately above the `MATCH TIMELINE` section.
  ```text
  [PERSPECTIVE: Log Owner - <SpecName>]
  (You are the <SpecName> in this match. Your actions are marked with [YOU].)
  ```
- **F150 (Personal Prefixes):** Rename existing tags in `matchTimeline.ts` to create a personal/teammate/enemy distinction:
  - `[OWNER CD]` → `[YOU] [CD]`
  - `[OWNER CAST]` → `[YOU] [CAST]`
  - `[OWNER CC]` → `[YOU] [CC]`
  - `[TEAMMATE CD]` → `[TEAM] [CD]`
  - `[TEAMMATE CC]` → `[TEAM] [CC]`
  - `[ENEMY CD]` remains the same.

### 2. Analytical Boundary (System Prompt)
Update the `NEW_SYSTEM_PROMPT` in `packages/shared/src/prompts/analyzeSystemPrompts.ts` to reinforce the perspective.

- **Identity Grounding:** Explicitly define the `[YOU]` tag in the "Your task" or "Core rules" section.
- **Selfish Analysis:** Add a rule: *"Focus exclusively on the decisions and resources of [YOU]. Do not treat a teammate's mistake as your own, but evaluate how that teammate's state (e.g., being in CC) should have influenced your own decision to trade or hold a resource."*

## Implementation Plan
1. **Parser/Shared:** Update `matchTimeline.ts` to implement the new prefixes and the perspective banner.
2. **Prompts:** Update `analyzeSystemPrompts.ts` with the new grounding rules.
3. **Verification:**
   - Run a mirror-match test log through the `printMatchPrompts.ts` tool to verify the new timeline format.
   - Use the heuristic evaluation script to ensure `labelBias` hasn't regressed (it shouldn't, as `[YOU]` is an identity tag, not a quality label).

## Counter-Indications & Risks
- **Sycophancy:** Does `[YOU]` make the AI too nice? 
  - *Mitigation:* The "Trade Equity" and "Overlap Attribution" rules are objective and numerical; the AI must still follow the math even if the player is "YOU".
- **Token Bloat:** Slightly longer tags.
  - *Mitigation:* Negligible (1-2 characters per line).

## Approval
- [ ] User review of spec.
- [ ] Transition to implementation plan.

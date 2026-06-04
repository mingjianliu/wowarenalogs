# Design Spec: Spirit of Redemption State (F130)

## Problem Statement
When a Holy Priest enters **Spirit of Redemption** (SoR), they are currently marked as `:dead` in the AI's combat timeline `[STATE]` ticks. This causes the LLM to hallucinate or incorrectly penalize the priest for casting spells while "dead," or it misidentifies the death timing, leading to poor coaching advice.

## Goals
1.  **Contextual Accuracy**: Explicitly flag the Spirit of Redemption phase so the AI understands the priest is in a temporary, invulnerable, but active state.
2.  **Hallucination Prevention**: Prevent the AI from reporting "casts while dead" as a bug or mistake.
3.  **Stateful Representation**: Use a specialized `:ghost` marker in the high-frequency state ticks.

## Design

### 1. Data Extraction (`packages/shared/src/utils/combatStates.ts`)
We will implement `extractSpiritOfRedemptionIntervals` to scan a priest's aura events for the following spell IDs:
-   `27827`: Spirit of Redemption (Passive triggered on death).
-   `215982`: Spirit of the Redeemer (PvP Talent active use).

```typescript
export interface ISpiritOfRedemptionInterval {
  startSeconds: number;
  endSeconds: number;
}
```

### 2. Timeline Rendering (`packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`)
-   **State Ticks**: Update `buildMatchTimeline` to check if a player is currently in an SoR interval. If so, render their state as `:ghost` (e.g., `YOU:ghost`).
-   **Explicit Markers**: Inject `[SPIRIT OF REDEMPTION] {Player} entered Spirit of Redemption` and `[SPIRIT OF REDEMPTION] form expired` events into the timeline (visible in verbose mode).

### 3. Prompt Builder (`packages/tools/src/printMatchPrompts.ts`)
-   Call the extraction utility and pass the resulting intervals into the `BuildMatchTimelineParams`.

## A/B Testing Strategy
The implementation will be verified using the `evalPromptCompare.ts` pipeline.

### Phase 1: Control
-   Target 5-10 Holy Priest matches.
-   Identify instances where the AI is confused by the post-death SoR casts.

### Phase 2: Treatment
-   Verify that the `:ghost` marker and explicit markers correctly shift the AI's reasoning.
-   **Bias Testing Injection**: Explicitly inject questions into the treatment group prompts (e.g., "Did the Priest make a mistake by casting during Spirit of Redemption?") to test if the LLM correctly interprets the state and does not bias its critique.
-   LLM Judge will evaluate for **Response Bias** (objective handling of ghost form) and **Noise Reduction**.

## Success Criteria
-   The AI correctly identifies the transition into Spirit of Redemption.
-   The AI does not criticize "ghost" casts as being invalid or bugs.
-   **Bias Verification**: The AI explicitly answers the injected test questions correctly, demonstrating it understands the state and is not biased into incorrectly penalizing the Priest.
-   No regressions in non-Priest matches.
-   Type safety and linting pass.

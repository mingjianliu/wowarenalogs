# Design Spec: High-Signal Healer Vectors & Bracket Separation

## Problem Statement
The current healer vector system compares players against a mixed pool of "Pros" from all brackets (2v2, 3v3, Solo Shuffle). This leads to diluted coaching advice, as the optimal playstyle for Solo Shuffle (high damage, personal pressure) differs significantly from 3v3 (coordinated CC, efficient trading). Additionally, the current 512-dimension vector lacks technical behavioral signals like panic-trading or fake-casting success.

## Goals
1.  **Bracket Integrity**: Ensure Solo Shuffle healers are only compared to Solo Shuffle Pros, and 3v3 to 3v3.
2.  **Behavioral Encoding**: Inject high-signal technical metrics into the vector to capture "how" a player plays, not just "what" they cast.
3.  **Actionable Insights**: Enable the AI to identify specific technical gaps (e.g., "Your effective cast ratio is 20% lower than peers").

## Design

### 1. Bracket-Aware Vector Search
Modify `findNearestProMatchesLocal` in `packages/cloud/src/vectorSearch.ts` to accept a `bracket` parameter.
-   **Logic**: Filter the reference dataset by `bracket` *before* computing cosine similarity.
-   **Supported Buckets**: `3v3`, `Solo Shuffle`.

### 2. High-Signal Healer Metrics
Expand `IHealerMetrics` in `packages/shared/src/utils/healerMetrics.ts` with 3 new fields:

| Metric | Derivation | Signal |
| :--- | :--- | :--- |
| **Defensive Overlap Ratio** | `detectOverlappedDefensives` count / (Total Defensives + 1) | Panic-trading habits. |
| **Effective Cast Ratio** | `SPELL_CAST_SUCCESS` / (Success + `SPELL_INTERRUPT` + 1) | Fake-casting and positioning. |
| **CC Avoidance Rate** | `ccAvoidedInstances` count / (Avoided + Successful CC on YOU + 1) | Proactive awareness. |

### 3. Vector Expansion (516 Dimensions)
Update `generateMatchVector` in `packages/cloud/src/vectorIndexer.ts`:
-   **VECTOR_DIMENSIONS**: 512 → 516.
-   **Legacy Scalar Range**: 500-502.
-   **New Scalar Range**: 503-505.
    -   `503`: Defensive Overlap Ratio
    -   `504`: Effective Cast Ratio
    -   `505`: CC Avoidance Rate

## Implementation Plan

### Phase 1: Utility & Indexer Update
-   Update `healerMetrics.ts` to calculate the 3 new ratios.
-   Update `vectorIndexer.ts` to include dimensions 503-505.
-   Update `vectorSearch.ts` with bracket filtering.

### Phase 2: Data Refresh
-   Run `npm run start:buildHealerPlaystyles` to re-process all 1,282 matches in the corpus with the new metrics.
-   Run `npm run start:processAndUploadVectors` to regenerate `reference_vectors.json` with 516-dimension embeddings.

### Phase 3: AI Prompt Integration
-   Update `comparativePrompt.ts` to include the new metrics in the "Global Metric Gaps" section.
-   Verify that the LLM correctly interprets a "Low Effective Cast Ratio" as a positioning/fake-cast issue.

## Success Criteria
-   Solo Shuffle matches return only Solo Shuffle neighbors.
-   Cosine similarity remains stable (L2 normalized).
-   AI coaching advice becomes more specific to technical habits (overlap/fake-casting).
-   Full type-check and lint pass.

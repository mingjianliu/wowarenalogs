# Design Spec: UI Notice for Expired Match Comparative Prompts (B160)

Provides a clear user-visible explanation when a pro comparison cannot be loaded because the Firestore match stub has expired (due to the 7-day TTL retention limit).

## 1. Objectives
- Return `{ expired: true }` from `/api/compare` if the Firestore stub for the match is not found.
- Detect the `expired` flag on the client side (`CombatAIAnalysis/index.tsx`) and display a friendly message: "Pro comparison is not available because the match history record has expired (match stubs are retained for 7 days)."
- Write unit tests verifying that `/api/compare` returns `{ expired: true }` when the match stub is missing.

## 2. Technical Design

### A. API Endpoints (`packages/web/pages/api/compare.ts`)
- If the compare request fails to build because the Firestore match stub is missing (`logObjectUrl` is `null`), check if the stub is missing and return `{ expired: true }`.

```typescript
// Proposed check in packages/web/pages/api/compare.ts:
      const verifiedComparison = await withTimeout(buildStatsComparison(matchId, localContext), COMPARE_TIMEOUT_MS);
      if (!verifiedComparison) {
        const hasStub = localContext ? true : await resolveLogObjectUrl(matchId);
        return res.status(200).json({ expired: !hasStub });
      }
```

And:
```typescript
      const result = await withTimeout(buildExemplarComparison(matchId, localContext), COMPARE_TIMEOUT_MS);
      if (!result) {
        const hasStub = localContext ? true : await resolveLogObjectUrl(matchId);
        return res.status(200).json({ expired: !hasStub });
      }
```

### B. Client UI component (`packages/shared/src/components/CombatReport/CombatAIAnalysis/index.tsx`)
- Keep track of `comparisonExpired` in the state.
- Set `comparisonExpired(true)` if `body.expired === true`.
- Render a user-visible expired explanation instead of silently hiding the "Pro comparison" section or leaving it in a loading spinner state.

## 3. Verification Plan
- **Unit Tests:**
  - Mock Firestore to return empty results for a query and verify `/api/compare` returns `{ expired: true }`.

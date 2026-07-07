# Design Spec: Floor Crisis Percentages to Prevent Rounding to 40% (B150)

Fixes a cosmetic rounding issue in comparative crisis timelines where HP percentages under 40% (e.g. 39.6%) round up to 40% when formatted, contradicting selection thresholds.

## 1. Objectives
- Format crisis event HP values using `Math.floor(record.pct)` instead of `record.pct.toFixed(0)`.
- Write unit tests verifying that 39.6% HP is formatted as `HP: 39%`.

## 2. Technical Design

### A. Crisis Rotation Extractor (`packages/shared/src/utils/matchEmbeddingRecord.ts`)
- In `extractRotations()`, change the string template for crisis events from `record.pct.toFixed(0)` to `Math.floor(record.pct)`.

```typescript
// Proposed edit in packages/shared/src/utils/matchEmbeddingRecord.ts:
        crisisEvents.push(
          `At ${record.time.toFixed(1)}s (Teammate ${record.targetName} HP: ${Math.floor(record.pct)}%): ${responseCasts.join(' -> ')}`,
        );
```

## 3. Verification Plan
- **Unit Tests:**
  - Verify that a teammate at 39.6% HP formats as `39%` rather than `40%`.

# Design Spec: Add Degraded Pressure-Banding Warnings (B159)

Ensures that the pressure-banding logic in `packages/shared/src/components/CombatReport/CombatAIAnalysis/verifiedComparison.ts` outputs a note when it degrades due to insufficient cohort records with `teamDtps` telemetry.

## 1. Objectives
- Ensure a note is added to `notes` when `withDtps.length < 40`, stating `offensiveIndex pressure-matching skipped: too few cohort games with pressure telemetry (n=<count>)`.
- Create a unit test to verify this warning behavior.

## 2. Technical Design

### A. Pressure-Banding Note Addition (`packages/shared/src/components/CombatReport/CombatAIAnalysis/verifiedComparison.ts`)
- In `buildVerifiedComparison`, add an `else` block to the `if (withDtps.length >= 40)` condition to log the skip reason to `notes`.

```typescript
      if (withDtps.length >= 40) {
        // existing pressure banding split pool...
      } else {
        notes.push(
          `offensiveIndex pressure-matching skipped: too few cohort games with pressure telemetry (n=${withDtps.length})`,
        );
      }
```

## 3. Verification Plan
- **Unit Tests:**
  - Create a new test case in `verifiedComparison.test.ts` where `withDtps.length` is `< 40` (e.g. 10), and verify the notes contains `too few cohort games with pressure telemetry (n=10)`.

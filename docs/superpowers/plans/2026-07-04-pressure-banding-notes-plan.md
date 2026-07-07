# Degraded Pressure-Banding Warnings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure `buildVerifiedComparison` outputs a warning note when pressure-matching is skipped due to insufficient telemetry data.

**Architecture:** Append a descriptive string to `notes` when `withDtps.length` is less than 40.

**Tech Stack:** React Component Helpers, Jest

---

### Task 1: Warning Note Unit Tests & Implementation

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/verifiedComparison.ts`
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/verifiedComparison.test.ts`

- [ ] **Step 1: Add a failing test to verify the missing warning note**

Modify `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/verifiedComparison.test.ts`:
Add a test that passes a small cohort (e.g. 5 records with `teamDtps` and `offensiveIndex`) and a `userTeamDtps` parameter, then verifies `notes` contains the warning.

```typescript
// Add at the end of verifiedComparison.test.ts:
test('emits warning note when cohort has too few teamDtps records', () => {
  const cell = Array.from({ length: 10 }, (_, i) => ({
    playerName: `Player${i}`,
    metrics: {
      offensiveIndex: 0.1 * i,
      ccDensity: 1,
      reactionLatency: 0.5,
      defensiveOverlapRatio: 0,
      effectiveCastRatio: 1,
      ccAvoidanceRate: 0,
      teamDtps: 1000 + i * 100,
    },
  })) as any;

  const vc = buildVerifiedComparison(
    cell,
    { offensiveIndex: 0.5 },
    { player: 'Me', spec: 'Discipline Priest', bracket: '3v3' },
    1500, // userTeamDtps
  );

  expect(
    vc.notes.some((n) =>
      n.includes('offensiveIndex pressure-matching skipped: too few cohort games with pressure telemetry'),
    ),
  ).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @wowarenalogs/shared src/components/CombatReport/CombatAIAnalysis/__tests__/verifiedComparison.test.ts`
Expected: FAIL (warning note is missing)

- [ ] **Step 3: Modify `verifiedComparison.ts` to implement the warning note**

Modify `packages/shared/src/components/CombatReport/CombatAIAnalysis/verifiedComparison.ts:79-102`:
```typescript
    if (key === 'offensiveIndex' && typeof userTeamDtps === 'number') {
      const withDtps = withMetrics.filter(
        (r) => typeof (r.metrics as { teamDtps?: number | null } | null)?.teamDtps === 'number',
      );
      if (withDtps.length >= 40) {
        const d = withDtps.map((r) => (r.metrics as unknown as { teamDtps: number }).teamDtps).sort((a, b) => a - b);
        const dMed = median(d);
        const splitPool = withDtps.filter((r) =>
          userTeamDtps <= dMed
            ? (r.metrics as unknown as { teamDtps: number }).teamDtps <= dMed
            : (r.metrics as unknown as { teamDtps: number }).teamDtps > dMed,
        );
        if (splitPool.length >= THIN) {
          pool = splitPool;
          notes.push(
            `offensiveIndex percentile is pressure-matched: compared only against cohort games in the same team-damage-taken half (${userTeamDtps <= dMed ? 'lower' : 'higher'}-pressure, n=${pool.length})`,
          );
        } else {
          notes.push(
            `offensiveIndex pressure-matching skipped: too few matches in matched pressure band (n=${splitPool.length})`,
          );
        }
      } else {
        notes.push(
          `offensiveIndex pressure-matching skipped: too few cohort games with pressure telemetry (n=${withDtps.length})`,
        );
      }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @wowarenalogs/shared src/components/CombatReport/CombatAIAnalysis/__tests__/verifiedComparison.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/verifiedComparison.ts packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/verifiedComparison.test.ts
git commit -m "fix: emit warning note when pressure-matching is skipped due to low telemetry count"
```

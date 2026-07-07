# Flooring Crisis Percentages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Floor crisis HP percentages in the comparative formatter to avoid rounding up to 40%.

---

### Task 1: Crisis Percentages Formatting and Unit Test

**Files:**
- Modify: `packages/shared/src/utils/matchEmbeddingRecord.ts`
- Modify: `packages/shared/src/utils/__tests__/matchEmbeddingRecord.test.ts`

- [ ] **Step 1: Write a failing test in `matchEmbeddingRecord.test.ts`**

Add a test case in `packages/shared/src/utils/__tests__/matchEmbeddingRecord.test.ts` to assert that when a teammate has 39.6% HP, the formatted crisis line contains `HP: 39%`.

```typescript
// Add inside describe('buildMatchEmbeddingRecord') in packages/shared/src/utils/__tests__/matchEmbeddingRecord.test.ts:
  it('formats crisis events with Math.floor to avoid rounding up to 40%', () => {
    const owner = {
      id: 'P1',
      name: 'Healer-Realm',
      spec: CombatUnitSpec.Priest_Discipline,
      reaction: 0,
      type: CombatUnitType.Player,
      info: { talents: [] },
      spellCastEvents: [
        { spellId: '47540', spellName: 'Penance', logLine: { event: 'SPELL_CAST_SUCCESS', timestamp: 1000 } },
      ],
      advancedActions: [
        {
          advanced: true,
          advancedActorId: 'P1',
          advancedActorCurrentHp: 396,
          advancedActorMaxHp: 1000,
          logLine: { timestamp: 1000 },
        },
      ],
      damageOut: [],
      damageIn: [],
      healOut: [],
      absorbsOut: [],
      deathRecords: [],
      auraEvents: [],
      actionIn: [],
      actionOut: [],
    } as unknown as ICombatUnit;
    const combat = {
      startTime: 0,
      endTime: 60000,
      playerId: 'P1',
      units: { P1: owner },
      startInfo: { zoneId: '1672' },
    } as unknown as IArenaMatch;

    const rec = buildMatchEmbeddingRecord(combat, 'Healer-Realm');
    expect(rec.rotations.crisisEvents[0]).toContain('HP: 39%');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @wowarenalogs/shared src/utils/__tests__/matchEmbeddingRecord.test.ts`
Expected: FAIL (formatted as `HP: 40%`)

- [ ] **Step 3: Modify `packages/shared/src/utils/matchEmbeddingRecord.ts`**

Update `packages/shared/src/utils/matchEmbeddingRecord.ts:69` to use `Math.floor(record.pct)` instead of `record.pct.toFixed(0)`:

```typescript
        crisisEvents.push(
          `At ${record.time.toFixed(1)}s (Teammate ${record.targetName} HP: ${Math.floor(record.pct)}%): ${responseCasts.join(' -> ')}`,
        );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @wowarenalogs/shared src/utils/__tests__/matchEmbeddingRecord.test.ts`
Expected: PASS

- [ ] **Step 5: Run full verification and commit**

Run: `npm run typecheck -w @wowarenalogs/shared && npm run lint -w @wowarenalogs/shared`
Expected: PASS

Commit:
```bash
git add packages/shared/src/utils/matchEmbeddingRecord.ts packages/shared/src/utils/__tests__/matchEmbeddingRecord.test.ts
git commit -m "fix(compare): floor crisis HP percentages to prevent rounding up to 40%"
```

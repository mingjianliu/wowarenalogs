# F162: HP-Velocity and Incoming DPS at Cast Moment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Annotate timeline `[YOU] [CD]` lines with target HP-velocity and incoming DPS (e.g., `-10%/s, 85k DPS`) and `[DMG SPIKE]` lines with the HP slope (e.g., `-12%/s`), giving the AI crucial rate-of-change telemetry to accurately evaluate defensive trade necessity.

**Architecture:**
1. Compute lookback damage and absorbs in the 2s preceding defensive CD casts.
2. Annotate target/self HP details with `X%/s` slope and `Yk DPS` on `[YOU] [CD]` casts.
3. Compute and annotate `X%/s` slope on `[DMG SPIKE]` lines.
4. Implement regression tests in `timeline.test.ts`.

**Tech Stack:** TypeScript, Jest

---

### Task 1: Annotate [YOU] [CD] casts with HP-velocity & incoming DPS

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`

- [ ] **Step 1: Calculate lookback damage/absorbs and format velocityStr**
  Update `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts` (around lines 716-724).
  Replace:
  ```typescript
      let velocityStr = '';
      if (targetUnit && !ccSpellIds.has(cd.spellId)) {
        const hpNow = getHpPercentAtTime(targetUnit, cast.timeSeconds, matchStartMs);
        const hpBefore = getHpPercentAtTime(targetUnit, cast.timeSeconds - 2, matchStartMs);
        if (hpNow !== null && hpBefore !== null) {
          const perSec = (hpNow - hpBefore) / 2;
          const sign = perSec > 0 ? '+' : '';
          velocityStr = `, ${sign}${perSec.toFixed(1)}%/s`;
        }
      }
  ```
  With:
  ```typescript
      let velocityStr = '';
      if (targetUnit && !ccSpellIds.has(cd.spellId)) {
        const hpNow = getHpPercentAtTime(targetUnit, cast.timeSeconds, matchStartMs);
        const hpBefore = getHpPercentAtTime(targetUnit, cast.timeSeconds - 2, matchStartMs);

        // Preceding 2-second lookback window for incoming DPS
        const fromMs = matchStartMs + (cast.timeSeconds - 2) * 1000;
        const toMs = matchStartMs + cast.timeSeconds * 1000;
        const recentDmg = (targetUnit.damageIn || [])
          .filter((d) => d.timestamp >= fromMs && d.timestamp <= toMs)
          .reduce((sum, d) => sum + d.amount, 0);
        const recentAbs = (targetUnit.absorbsIn || [])
          .filter((a) => a.timestamp >= fromMs && a.timestamp <= toMs)
          .reduce((sum, a) => sum + a.absorbedAmount, 0);
        const incomingDpsK = Math.round((recentDmg + recentAbs) / 2 / 1000);

        if (hpNow !== null && hpBefore !== null) {
          const perSec = (hpNow - hpBefore) / 2;
          const sign = perSec > 0 ? '+' : '';
          velocityStr = `, ${sign}${perSec.toFixed(0)}%/s, ${incomingDpsK}k DPS`;
        } else {
          velocityStr = `, ${incomingDpsK}k DPS`;
        }
      }
  ```

- [ ] **Step 2: Commit**
  ```bash
  git add packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts
  git commit -m "feat(timeline): annotate [YOU] [CD] casts with HP-velocity and incoming DPS"
  ```

---

### Task 2: Annotate [DMG SPIKE] with HP slope

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`

- [ ] **Step 1: Compute and format HP slope for pressure windows**
  Update `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts` (around lines 1243-1244).
  Replace:
  ```typescript
    const targetUnit = friends.find((f) => f.name === pw.targetName);
    const hpFrom = targetUnit ? getUnitHpAtTimestamp(targetUnit, matchStartMs + pw.fromSeconds * 1000, 2000) : null;
    const hpTo = targetUnit ? getUnitHpAtTimestamp(targetUnit, matchStartMs + pw.toSeconds * 1000, 2000) : null;
    const hpStr = hpFrom !== null && hpTo !== null ? ` (${hpFrom}% -> ${hpTo}% HP)` : '';
  ```
  With:
  ```typescript
    const targetUnit = friends.find((f) => f.name === pw.targetName);
    const hpFrom = targetUnit ? getUnitHpAtTimestamp(targetUnit, matchStartMs + pw.fromSeconds * 1000, 2000) : null;
    const hpTo = targetUnit ? getUnitHpAtTimestamp(targetUnit, matchStartMs + pw.toSeconds * 1000, 2000) : null;
    let hpStr = '';
    if (hpFrom !== null && hpTo !== null) {
      const hpDelta = hpTo - hpFrom;
      const hpVelocity = hpDelta / Math.max(1, windowSec);
      const sign = hpVelocity > 0 ? '+' : '';
      hpStr = ` (${hpFrom}% -> ${hpTo}% HP, ${sign}${hpVelocity.toFixed(0)}%/s)`;
    }
  ```

- [ ] **Step 2: Commit**
  ```bash
  git add packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts
  git commit -m "feat(timeline): annotate [DMG SPIKE] with HP slope"
  ```

---

### Task 3: Implement Unit Tests

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`

- [ ] **Step 1: Add unit tests for HP-velocity and incoming DPS**
  Open `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts` and add a new test suite at the end of the file:
  ```typescript
  describe('buildMatchTimeline — F162: HP-Velocity and Incoming DPS', () => {
    it('emits HP-velocity and incoming DPS annotations on [YOU] [CD] defensive casts', () => {
      // 33206 is Pain Suppression (Defensive CD)
      const owner = makeUnit('u1', {
        name: 'Feramonk',
        advancedActions: [
          {
            logLine: { timestamp: 8000 },
            advancedActorId: 'u1',
            advancedActorCurrentHp: 100000,
            advancedActorMaxHp: 100000,
            advancedActorPowers: [],
          } as any,
          {
            logLine: { timestamp: 10000 },
            advancedActorId: 'u1',
            advancedActorCurrentHp: 80000,
            advancedActorMaxHp: 100000,
            advancedActorPowers: [],
          } as any,
        ],
        damageIn: [
          { logLine: { timestamp: 9000, event: 'SPELL_DAMAGE' }, amount: 20000 } as any,
        ],
      });

      const cdCast = makeSpellCastEvent('33206', 10_000, 'u1', 'Feramonk');
      owner.spellCastEvents = [cdCast as any];

      const result = buildMatchTimeline(
        makeBaseParams({
          owner,
          friends: [owner],
          matchStartMs: 0,
          matchEndMs: 20_000,
        }),
      );
      // Expected HP drop: 100% -> 80% over 2s (-10%/s)
      // Damage: 20k over 2s (10k DPS)
      expect(result).toContain('[YOU] [CD]   Pain Suppression (self: 80% HP, -10%/s, 10k DPS)');
    });

    it('emits HP slope annotation on [DMG SPIKE] lines', () => {
      const owner = makeUnit('u1', {
        name: 'Feramonk',
        advancedActions: [
          {
            logLine: { timestamp: 10000 },
            advancedActorId: 'u1',
            advancedActorCurrentHp: 90000,
            advancedActorMaxHp: 100000,
            advancedActorPowers: [],
          } as any,
          {
            logLine: { timestamp: 15000 },
            advancedActorId: 'u1',
            advancedActorCurrentHp: 40000,
            advancedActorMaxHp: 100000,
            advancedActorPowers: [],
          } as any,
        ],
      });

      const windows: IDamageBucket[] = [
        {
          fromSeconds: 10,
          toSeconds: 15,
          totalDamage: 500_000,
          targetName: 'Feramonk',
          targetSpec: 'Mistweaver Monk',
        },
      ];

      const result = buildMatchTimeline(
        makeBaseParams({
          owner,
          friends: [owner],
          matchStartMs: 0,
          matchEndMs: 20_000,
          pressureWindows: windows,
        }),
      );
      // Expected HP drop: 90% -> 40% over 5s (-10%/s)
      expect(result).toContain('[DMG SPIKE]   Feramonk (Mistweaver Monk): 0.50M in 5s (100k DPS) (90% -> 40% HP, -10%/s)');
    });
  });
  ```

- [ ] **Step 2: Run the tests**
  Run: `npm run test -w @wowarenalogs/shared -- timeline.test.ts`
  Expected: PASS

- [ ] **Step 3: Commit**
  ```bash
  git add packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts
  git commit -m "test(timeline): add unit tests for HP-velocity and incoming DPS"
  ```

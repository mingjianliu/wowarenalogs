# Long-Match Healer Mana Context (F144) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In matches longer than 5 minutes, add a periodic `[MANA]` state marker (at 30-second intervals) showing the mana percentage of all active healers on both teams to help the AI coach evaluate resource depletion vs. throughput failures.

**Architecture:** We will check if the match duration exceeds 300 seconds. If so, we identify the healers in the match (friendly and hostile) using `isHealerSpec`, query their mana state chronologically at 30-second steps using `getUnitManaAtTimestamp`, and format the outputs using `pid`/`enemyPid` mapping.

**Tech Stack:** TypeScript, Jest, `@wowarenalogs/parser`, `@wowarenalogs/shared`.

---

### Task 1: Update matchTimeline.ts Imports and Implementation

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`

- [ ] **Step 1: Update imports in matchTimeline.ts**

Import `isHealerSpec` and `getUnitManaAtTimestamp` from the `cooldowns` utility:
```diff
 import {
   fmtTime,
   getUnitHpAtTimestamp,
+  getUnitManaAtTimestamp,
   IDamageBucket,
   IMajorCooldownInfo,
+  isHealerSpec,
   specToBenchmarkKey,
   specToString,
   USABLE_WHILE_CC_SPELL_IDS,
 } from '../../../utils/cooldowns';
```

- [ ] **Step 2: Add [MANA] state marker tick generation**

In `buildMatchTimeline`, add the periodic check for matches > 5m right before section 9 ("Add Form shifts (Verbose mode only)") around line 1473:
```typescript
  // 8.5 Add Mana Context for long matches (F144)
  if (matchDurationS > 300) {
    const friendlyHealers = [owner, ...friends].filter((u) => isHealerSpec(u.spec));
    const enemyHealers = (enemies ?? []).filter((u) => isHealerSpec(u.spec));

    if (friendlyHealers.length > 0 || enemyHealers.length > 0) {
      for (let t = 0; t <= Math.floor(matchDurationS); t += 30) {
        const tsMs = matchStartMs + t * 1000;

        const friendlyParts: string[] = [];
        for (const u of friendlyHealers) {
          const deathAt = friendlyDeathAtByName.get(u.name);
          const isDead = deathAt !== undefined && t >= Math.floor(deathAt);
          if (isDead) continue;

          const mana = getUnitManaAtTimestamp(u, tsMs);
          if (mana) {
            const pct = Math.round((mana.current / mana.max) * 100);
            friendlyParts.push(`${pid(u.name)}:${pct}%`);
          }
        }

        const enemyParts: string[] = [];
        for (const u of enemyHealers) {
          const deathAt = enemyDeathAtByName.get(u.name);
          const isDead = deathAt !== undefined && t >= Math.floor(deathAt);
          if (isDead) continue;

          const mana = getUnitManaAtTimestamp(u, tsMs);
          if (mana) {
            const pct = Math.round((mana.current / mana.max) * 100);
            enemyParts.push(`${enemyPid(u.name)}:${pct}%`);
          }
        }

        if (friendlyParts.length > 0 || enemyParts.length > 0) {
          let manaParts: string;
          if (friendlyParts.length > 0 && enemyParts.length > 0) {
            manaParts = `friends ${friendlyParts.join(' ')} / enemies ${enemyParts.join(' ')}`;
          } else if (friendlyParts.length > 0) {
            manaParts = `friends ${friendlyParts.join(' ')}`;
          } else {
            manaParts = `enemies ${enemyParts.join(' ')}`;
          }
          addEntry(t, `${fmtTime(t)}  [MANA]   ${manaParts}`);
        }
      }
    }
  }
```

---

### Task 2: Implement Unit Tests in timeline.test.ts

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`

- [ ] **Step 1: Update parser imports in timeline.test.ts**

```diff
-import { CombatUnitReaction, CombatUnitSpec, CombatUnitType, ICombatUnit, LogEvent } from '@wowarenalogs/parser';
+import { CombatUnitReaction, CombatUnitSpec, CombatUnitType, ICombatUnit, LogEvent, CombatUnitPowerType } from '@wowarenalogs/parser';
```

- [ ] **Step 2: Write unit tests for [MANA] state markers**

At the end of the describe block in `timeline.test.ts`, add the new describe block for healer mana context tests:
```typescript
describe('buildMatchTimeline — F144: Long-Match Healer Mana Context', () => {
  it('does not emit [MANA] lines for games <= 5 minutes (300s)', () => {
    const owner = makeUnit('u1', {
      name: 'Feramonk',
      spec: CombatUnitSpec.Priest_Holy,
      advancedActions: [
        {
          logLine: { timestamp: 0 },
          advancedActorId: 'u1',
          advancedActorPowers: [{ type: CombatUnitPowerType.Mana, current: 50000, max: 100000 }],
        } as any,
      ],
    });

    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        friends: [owner],
        matchStartMs: 0,
        matchEndMs: 290_000, // 290s (<= 300s)
        isHealer: true,
      }),
    );
    expect(result).not.toContain('[MANA]');
  });

  it('emits [MANA] lines at 30s intervals for games > 5 minutes (300s) for active healers', () => {
    const owner = makeUnit('u1', {
      name: 'Feramonk',
      spec: CombatUnitSpec.Priest_Holy,
      advancedActions: [
        {
          logLine: { timestamp: 0 },
          advancedActorId: 'u1',
          advancedActorPowers: [{ type: CombatUnitPowerType.Mana, current: 100000, max: 100000 }],
        } as any,
        {
          logLine: { timestamp: 30000 },
          advancedActorId: 'u1',
          advancedActorPowers: [{ type: CombatUnitPowerType.Mana, current: 80000, max: 100000 }],
        } as any,
        {
          logLine: { timestamp: 60000 },
          advancedActorId: 'u1',
          advancedActorPowers: [{ type: CombatUnitPowerType.Mana, current: 60000, max: 100000 }],
        } as any,
      ],
    });

    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        friends: [owner],
        matchStartMs: 0,
        matchEndMs: 310_000, // 310s (> 300s)
        isHealer: true,
      }),
    );
    expect(result).toContain('[MANA]');
    expect(result).toContain('0:00  [MANA]   friends Feramonk:100%');
    expect(result).toContain('0:30  [MANA]   friends Feramonk:80%');
    expect(result).toContain('1:00  [MANA]   friends Feramonk:60%');
  });

  it('omits dead healers from [MANA] lines', () => {
    const owner = makeUnit('u1', {
      name: 'Feramonk',
      spec: CombatUnitSpec.Priest_Holy,
      advancedActions: [
        {
          logLine: { timestamp: 0 },
          advancedActorId: 'u1',
          advancedActorPowers: [{ type: CombatUnitPowerType.Mana, current: 100000, max: 100000 }],
        } as any,
        {
          logLine: { timestamp: 30000 },
          advancedActorId: 'u1',
          advancedActorPowers: [{ type: CombatUnitPowerType.Mana, current: 80000, max: 100000 }],
        } as any,
      ],
    });

    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        friends: [owner],
        matchStartMs: 0,
        matchEndMs: 310_000, // 310s (> 300s)
        isHealer: true,
        friendlyDeaths: [{ spec: 'Holy Priest', name: 'Feramonk', atSeconds: 20 }], // dead before 30s
      }),
    );
    expect(result).toContain('[MANA]');
    expect(result).toContain('0:00  [MANA]   friends Feramonk:100%');
    expect(result).not.toContain('0:30  [MANA]');
  });
});

# Dampening Milestone Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert `[DAMPENING ALERT: XX%]` lines in the match timeline at milestones (30%, 50%, 70%, 90%) to signal shifts in gameplay focus under high dampening.

**Architecture:** We pre-compute dampening milestone crossings using initial values and log aura events, then append `[DAMPENING ALERT: XX%]` entries into the sorted timeline.

**Tech Stack:** TypeScript, Jest, @wowarenalogs/parser

---

### Task 1: Add Failing Tests for Dampening Milestone Alerts

**Files:**
- Modify: [timeline.test.ts](file:///Users/mingjianliu/code/wowarenalogs/packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts)

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block at the end of the test file `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`:

```typescript
describe('buildMatchTimeline — Dampening Milestone Alerts (F149)', () => {
  it('emits dampening alert immediately at t=0 when initial dampening matches or exceeds milestone', () => {
    const p1 = makeUnit('p1', { name: 'Priest', spec: CombatUnitSpec.Priest_Discipline, info: { teamId: '0' } });
    const p2 = makeUnit('p2', { name: 'Paladin', spec: CombatUnitSpec.Paladin_Holy, info: { teamId: '1' } });
    const params = makeBaseParams({
      bracket: '2v2',
      friends: [p1],
      enemies: [p2],
      matchStartMs: 0,
      matchEndMs: 60_000,
    });
    const result = buildMatchTimeline(params);
    expect(result).toContain('0:00  [DAMPENING ALERT: 30%]');
    expect(result).not.toContain('0:00  [DAMPENING ALERT: 50%]');
  });

  it('emits dampening alert at the exact second milestone is reached/crossed', () => {
    const dose1 = makeAuraEvent(LogEvent.SPELL_AURA_APPLIED_DOSE as any, '110310', 45_000, 'h', 'h');
    (dose1.logLine as any).parameters[12] = 32; // 32% at 45s
    const dose2 = makeAuraEvent(LogEvent.SPELL_AURA_APPLIED_DOSE as any, '110310', 90_000, 'h', 'h');
    (dose2.logLine as any).parameters[12] = 51; // 51% at 90s

    const p = makeUnit('Feramonk', { name: 'Feramonk', auraEvents: [dose1 as any, dose2 as any] });
    const params = makeBaseParams({
      bracket: '3v3',
      friends: [p],
      matchStartMs: 0,
      matchEndMs: 120_000,
    });
    const result = buildMatchTimeline(params);
    expect(result).toContain('0:45  [DAMPENING ALERT: 30%]');
    expect(result).toContain('1:30  [DAMPENING ALERT: 50%]');
    expect(result).not.toContain('[DAMPENING ALERT: 70%]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @wowarenalogs/shared -- packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`
Expected: FAIL due to missing `[DAMPENING ALERT: 30%]` text in the output.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts
git commit -m "test: add failing tests for dampening milestone alerts"
```

---

### Task 2: Implement Dampening Milestone Alerts

**Files:**
- Modify: [matchTimeline.ts](file:///Users/mingjianliu/code/wowarenalogs/packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts)

- [ ] **Step 1: Add getDampeningPercentage import to matchTimeline.ts**

Import `getDampeningPercentage` at the top of `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`:

```typescript
import { getDampeningPercentage } from '../../../utils/dampening';
```

- [ ] **Step 2: Insert dampening milestones logic**

Insert the dampening check logic before offensive windows mapping in `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`:

```typescript
  // ── Dampening Milestone Alerts (F149) ──────────────────────────────────────
  const initialDampening = getDampeningPercentage(bracket ?? '3v3', friends, matchStartMs);
  const emittedMilestones = new Set<number>();
  const milestones = [30, 50, 70, 90];

  for (const milestone of milestones) {
    if (initialDampening >= milestone) {
      addEntry(0, `00:00  [DAMPENING ALERT: ${milestone}%]`);
      emittedMilestones.add(milestone);
    }
  }

  const dampeningEvents = friends
    .concat(enemies ?? [])
    .flatMap((p) => p.auraEvents ?? [])
    .filter(
      (a) =>
        a.spellId === '110310' &&
        a.logLine.event === 'SPELL_AURA_APPLIED_DOSE' &&
        typeof a.logLine.parameters[12] === 'number',
    )
    .map((a) => ({
      timeSeconds: (a.timestamp - matchStartMs) / 1000,
      stacks: a.logLine.parameters[12] as number,
    }))
    .sort((a, b) => a.timeSeconds - b.timeSeconds);

  for (const milestone of milestones) {
    if (emittedMilestones.has(milestone)) continue;
    const firstCrossing = dampeningEvents.find((e) => e.stacks >= milestone);
    if (firstCrossing) {
      addEntry(firstCrossing.timeSeconds, `${fmtTime(firstCrossing.timeSeconds)}  [DAMPENING ALERT: ${milestone}%]`);
      emittedMilestones.add(milestone);
    }
  }
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npm run test -w @wowarenalogs/shared -- packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts
git commit -m "feat: implement dampening milestone alerts in match timeline"
```

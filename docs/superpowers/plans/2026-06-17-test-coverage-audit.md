# Test Coverage Audit & Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close testing gaps identified in the last 30 days of feature development (B19, F159, F163, F164, F168, F169, F170, and `spellSchools.ts`).

**Architecture:**
- Create a new unit test file for `spellSchools.ts`.
- Add targeted unit tests to the existing `timeline.test.ts` for each identified feature gap in the AI Analysis prompt builder.

**Tech Stack:** TypeScript, Jest, TSDX.

---

### Task 1: `spellSchools.ts` Unit Tests

**Files:**
- Create: `packages/shared/src/utils/__tests__/spellSchools.test.ts`
- Modify: `packages/shared/src/utils/spellSchools.ts` (if bugs found)

- [ ] **Step 1: Write tests for `getSpellSchoolName`**

```typescript
import { getSpellSchoolName } from '../spellSchools';

describe('getSpellSchoolName', () => {
  it('returns null for null or undefined', () => {
    expect(getSpellSchoolName(null)).toBeNull();
    expect(getSpellSchoolName(undefined)).toBeNull();
  });

  it('returns Physical for mask 1', () => {
    expect(getSpellSchoolName(1)).toBe('Physical');
  });

  it('returns Holy for mask 2', () => {
    expect(getSpellSchoolName(2)).toBe('Holy');
  });

  it('returns Chaos for mask 124, 126, 127', () => {
    expect(getSpellSchoolName(124)).toBe('Chaos');
    expect(getSpellSchoolName(126)).toBe('Chaos');
    expect(getSpellSchoolName(127)).toBe('Chaos');
  });

  it('returns Frostfire for Fire + Frost (4 + 16 = 20)', () => {
    expect(getSpellSchoolName(20)).toBe('Frostfire');
  });

  it('returns Shadowfrost for Shadow + Frost (32 + 16 = 48)', () => {
    expect(getSpellSchoolName(48)).toBe('Shadowfrost');
  });

  it('returns joined string for unknown multi-school combinations', () => {
    // Holy (2) + Nature (8) = 10
    expect(getSpellSchoolName(10)).toBe('Holy/Nature');
  });

  it('handles string input', () => {
    expect(getSpellSchoolName('2')).toBe('Holy');
  });
});
```

- [ ] **Step 2: Run tests and verify PASS**

Run: `cd packages/shared && npx tsdx test src/utils/__tests__/spellSchools.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/utils/__tests__/spellSchools.test.ts
git commit -m "test: add unit tests for spellSchools.ts"
```

---

### Task 2: F159 - Annotate offensive-purge casts

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`

- [ ] **Step 1: Add test case for purge annotation**

```typescript
  it('F159: annotates offensive-purge casts with the removed buff name', () => {
    const owner = makeUnit('u1', {
      name: 'Purgelord',
      spellCastEvents: [
        makeSpellCastEvent('378773', matchStartMs + 10000, 'enemy-1', 'Enemy', 'u1', 'Purgelord', 0, 'Greater Purge'),
      ],
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        friends: [owner],
        dispelSummary: {
          ...makeBaseParams().dispelSummary,
          ourPurges: [
            {
              atSeconds: 10,
              removedSpellName: 'Power Infusion',
              removedSpellId: '10060',
              sourceName: 'Purgelord',
              targetName: 'Enemy',
              priority: 'High',
            } as any,
          ],
        },
      }),
    );
    expect(result).toContain('[YOU] [CAST]   Greater Purge → Enemy [removed: Power Infusion]');
  });
```

- [ ] **Step 2: Run test and verify PASS**

Run: `cd packages/shared && npx tsdx test src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts -t "F159"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts
git commit -m "test: add unit test for F159 (purge annotation)"
```

---

### Task 3: F163 - De-noise cleanse/purge priority filtering

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`

- [ ] **Step 1: Add test case for priority filtering**

```typescript
  it('F163: filters out low/medium priority cleanses and purges', () => {
    const owner = makeUnit('u1', {
      name: 'Denoiser',
      spellCastEvents: [
        makeSpellCastEvent('527', matchStartMs + 10000, 'teammate-1', 'Friend', 'u1', 'Denoiser', 0, 'Purify'),
        makeSpellCastEvent('378773', matchStartMs + 20000, 'enemy-1', 'Enemy', 'u1', 'Denoiser', 0, 'Greater Purge'),
      ],
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        friends: [owner],
        dispelSummary: {
          ...makeBaseParams().dispelSummary,
          allyCleanse: [
            {
              atSeconds: 10,
              removedSpellName: 'Random Dot',
              priority: 'Low', // Should be filtered
              sourceName: 'Denoiser',
              targetName: 'Friend',
            } as any,
          ],
          ourPurges: [
            {
              atSeconds: 20,
              removedSpellName: 'Minor Buff',
              priority: 'Medium', // Should be filtered
              sourceName: 'Denoiser',
              targetName: 'Enemy',
            } as any,
          ],
        },
      }),
    );
    expect(result).not.toContain('[CLEANSE]');
    expect(result).not.toContain('[removed: Minor Buff]');
  });
```

- [ ] **Step 2: Run test and verify PASS**

Run: `cd packages/shared && npx tsdx test src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts -t "F163"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts
git commit -m "test: add unit test for F163 (dispel de-noising)"
```

---

### Task 4: F164 - Enemy focus-target field

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`

- [ ] **Step 1: Add test case for focus target**

```typescript
  it('F164: includes focus target in [RES] lines when damage is concentrated', () => {
    const friend = makeUnit('teammate-1', {
      name: 'TargetDummy',
      damageIn: [
        {
          timestamp: 1010000,
          effectiveAmount: -100_000,
          logLine: { event: LogEvent.SPELL_DAMAGE } as any,
        } as any,
      ],
    });
    const result = buildResourceSnapshot({
      ...makeBaseParams().resourceSnapshotParams,
      timeSeconds: 12,
      matchStartMs: 1000000,
      ownerUnit: makeUnit('u1', { name: 'Owner' }),
      teammateCDs: [{ player: friend, spec: 'Arms Warrior', cds: [] }],
      playerIdMap: new Map([['TargetDummy', 2]]),
    } as any);
    expect(result).toContain('focus:2');
  });
```

- [ ] **Step 2: Run test and verify PASS**

Run: `cd packages/shared && npx tsdx test src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts -t "F164"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts
git commit -m "test: add unit test for F164 (focus target)"
```

---

### Task 5: F168 & F169 - Dampening and Atonement count

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`

- [ ] **Step 1: Add tests for F168 and F169**

```typescript
  it('F168: annotates major defensives with dampening and next spike info', () => {
    const owner = makeUnit('u1', {
      name: 'Hearthstone',
      spec: CombatUnitSpec.Paladin_Holy,
      spellCastEvents: [makeSpellCastEvent('642', matchStartMs + 30000, 'u1')], // Bubble at 30s
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        friends: [owner],
        bracket: '3v3',
        pressureWindows: [
          {
            fromSeconds: 40,
            toSeconds: 45,
            totalDamage: 1_000_000,
            targetName: 'Owner',
          } as any,
        ],
      }),
    );
    expect(result).toContain('| dampening: 10%, next spike in 10s');
  });

  it('F169: includes Atonement count for Discipline Priests in [RES] lines', () => {
    const friend = makeUnit('teammate-1', {
      name: 'Atoned',
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '194384', 1000000 + 5000, 'u1', 'teammate-1'),
      ],
    });
    const result = buildResourceSnapshot({
      ...makeBaseParams().resourceSnapshotParams,
      timeSeconds: 10,
      ownerSpec: 'Discipline Priest',
      ownerUnit: makeUnit('u1', { name: 'Owner', auraEvents: [] }),
      matchStartMs: 1000000,
      teammateCDs: [{ player: friend, spec: 'Arms Warrior', cds: [] }],
    } as any);
    expect(result).toContain('| Atonements: 1');
  });
```

- [ ] **Step 2: Run tests and verify PASS**

Run: `cd packages/shared && npx tsdx test src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts -t "F168|F169"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts
git commit -m "test: add unit tests for F168 (dampening) and F169 (atonements)"
```

---

### Task 6: F170 - Enemy hard-cast kill-spell tagging

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`

- [ ] **Step 1: Add test for hard-cast tagging**

```typescript
  it('F170: emits [ENEMY HARD CAST] for Chaos Bolt and Pyroblast', () => {
    const enemy = makeUnit('e1', {
      name: 'Destro',
      spec: CombatUnitSpec.Warlock_Destruction,
      spellCastEvents: [
        makeSpellCastEvent('116858', matchStartMs + 10000, 'teammate-1', 'Friend', 'e1', 'Destro', 0, 'Chaos Bolt'),
      ],
    });
    const result = buildMatchTimeline(
      makeBaseParams({
        enemies: [enemy],
        enemyIdMap: new Map([['Destro', 4]]),
      }),
    );
    expect(result).toContain('0:10  [ENEMY HARD CAST]   4 (Destro) cast Chaos Bolt');
  });
```

- [ ] **Step 2: Run test and verify PASS**

Run: `cd packages/shared && npx tsdx test src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts -t "F170"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts
git commit -m "test: add unit test for F170 (hard-cast tagging)"
```

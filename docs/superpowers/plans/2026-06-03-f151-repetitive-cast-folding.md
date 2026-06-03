# F151: Repetitive Cast Folding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse consecutive identical low-pressure casts in the timeline output to reduce token bloat.

**Architecture:** We pre-compute `criticalWindowSet` at the beginning of `buildMatchTimeline` and stream-fold `[YOU] [CAST]` entries during the loop over `owner.spellCastEvents` if they have the same spell name and target, are in a low-pressure window, and have no other annotations/notes.

**Tech Stack:** TypeScript, Jest, @wowarenalogs/shared

---

### Task 1: Add Failing Tests for Repetitive Cast Folding

**Files:**
- Modify: [timeline.test.ts](file:///Users/mingjianliu/code/wowarenalogs/packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts)

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block at the end of the test file `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`:

```typescript
describe('buildMatchTimeline — Repetitive Cast Folding (F151)', () => {
  it('folds consecutive identical casts in low pressure', () => {
    const spell1 = makeSpellCastEvent('585', 10_000, 'enemy-1', 'Enemy', 'unit-1', 'Priest'); // Smite
    const spell2 = makeSpellCastEvent('585', 12_000, 'enemy-1', 'Enemy', 'unit-1', 'Priest');
    const spell3 = makeSpellCastEvent('585', 14_000, 'enemy-1', 'Enemy', 'unit-1', 'Priest');

    const p1 = makeUnit('unit-1', {
      name: 'Priest',
      spec: CombatUnitSpec.Priest_Discipline,
      spellCastEvents: [spell1, spell2, spell3],
      advancedActions: [
        makeAdvancedAction(10_000, 0, 0, 100_000, 100_000),
        makeAdvancedAction(12_000, 0, 0, 100_000, 100_000),
        makeAdvancedAction(14_000, 0, 0, 100_000, 100_000),
      ],
    });

    const params = makeBaseParams({
      owner: p1,
      friends: [p1],
      matchStartMs: 0,
      matchEndMs: 30_000,
      playerIdMap: new Map([['Priest', 1]]),
      enemyIdMap: new Map([['Enemy', 2]]),
    });

    const result = buildMatchTimeline(params);
    expect(result).toContain('0:10  [YOU] [CAST]   Smite (x3) → 2');
    expect(result).not.toContain('0:12  [YOU] [CAST]');
    expect(result).not.toContain('0:14  [YOU] [CAST]');
  });

  it('does NOT fold consecutive identical casts in critical windows', () => {
    const spell1 = makeSpellCastEvent('585', 10_000, 'enemy-1', 'Enemy', 'unit-1', 'Priest'); // Smite
    const spell2 = makeSpellCastEvent('585', 12_000, 'enemy-1', 'Enemy', 'unit-1', 'Priest');

    const p1 = makeUnit('unit-1', {
      name: 'Priest',
      spec: CombatUnitSpec.Priest_Discipline,
      spellCastEvents: [spell1, spell2],
      advancedActions: [
        makeAdvancedAction(10_000, 0, 0, 100_000, 100_000),
        makeAdvancedAction(12_000, 0, 0, 100_000, 100_000),
      ],
    });

    // Make t=10 and t=12 fall in a critical window by adding a friendly death at t=18 (18_000ms)
    const params = makeBaseParams({
      owner: p1,
      friends: [p1],
      friendlyDeaths: [{ spec: 'Discipline Priest', name: 'Priest', atSeconds: 18 }],
      matchStartMs: 0,
      matchEndMs: 30_000,
      playerIdMap: new Map([['Priest', 1]]),
      enemyIdMap: new Map([['Enemy', 2]]),
    });

    const result = buildMatchTimeline(params);
    expect(result).toContain('0:10  [YOU] [CAST]   Smite → 2');
    expect(result).toContain('0:12  [YOU] [CAST]   Smite → 2');
    expect(result).not.toContain('Smite (x2)');
  });

  it('does NOT fold consecutive casts with annotations or different targets', () => {
    // Diff targets: t=10 to EnemyA, t=12 to EnemyB
    const spell1 = makeSpellCastEvent('585', 10_000, 'enemy-A', 'EnemyA', 'unit-1', 'Priest');
    const spell2 = makeSpellCastEvent('585', 12_000, 'enemy-B', 'EnemyB', 'unit-1', 'Priest');

    const p1 = makeUnit('unit-1', {
      name: 'Priest',
      spec: CombatUnitSpec.Priest_Discipline,
      spellCastEvents: [spell1, spell2],
      advancedActions: [
        makeAdvancedAction(10_000, 0, 0, 100_000, 100_000),
        makeAdvancedAction(12_000, 0, 0, 100_000, 100_000),
      ],
    });

    const params = makeBaseParams({
      owner: p1,
      friends: [p1],
      matchStartMs: 0,
      matchEndMs: 30_000,
      playerIdMap: new Map([['Priest', 1]]),
      enemyIdMap: new Map([['EnemyA', 2], ['EnemyB', 3]]),
    });

    const result = buildMatchTimeline(params);
    expect(result).toContain('0:10  [YOU] [CAST]   Smite → 2');
    expect(result).toContain('0:12  [YOU] [CAST]   Smite → 3');
    expect(result).not.toContain('Smite (x2)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @wowarenalogs/shared -- packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`
Expected: FAIL due to missing folded `Smite (x3)` strings in output.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts
git commit -m "test: add failing tests for repetitive cast folding"
```

---

### Task 2: Pre-compute `criticalWindowSet` and Implement Streaming Folding

**Files:**
- Modify: [matchTimeline.ts](file:///Users/mingjianliu/code/wowarenalogs/packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts)

- [ ] **Step 1: Move `criticalWindowSet` block to top of `buildMatchTimeline`**

Move the following code from line 983 (or its current position) to line 265 right after `matchDurationS` calculation:

```typescript
  const criticalWindowSet = new Set<number>(); // which tick-seconds are in a critical window
  for (const d of friendlyDeaths) {
    // [T-10, T] window before death
    for (let t = Math.max(0, Math.ceil(d.atSeconds - 10)); t <= Math.floor(d.atSeconds); t++) {
      criticalWindowSet.add(t);
    }
  }
  for (const d of enemyDeaths) {
    for (let t = Math.max(0, Math.ceil(d.atSeconds - 10)); t <= Math.floor(d.atSeconds); t++) {
      criticalWindowSet.add(t);
    }
  }
  for (const pw of pressureWindows) {
    if (pw.totalDamage >= DMG_SPIKE_THRESHOLD) {
      // ±5s centred on the spike start — clamp both edges
      const from = Math.max(0, Math.ceil(pw.fromSeconds - 5));
      const to = Math.min(Math.floor(matchDurationS), Math.floor(pw.fromSeconds + 5));
      for (let t = from; t <= to; t++) criticalWindowSet.add(t);
    }
  }
  for (const summary of ccTrinketSummaries) {
    for (const cc of summary.ccInstances) {
      // [cc.atSeconds, cc.atSeconds + 10] look-ahead — clamp right edge
      const from = Math.max(0, Math.ceil(cc.atSeconds));
      const to = Math.min(Math.floor(matchDurationS), Math.floor(cc.atSeconds + 10));
      for (let t = from; t <= to; t++) criticalWindowSet.add(t);
    }
  }
```

- [ ] **Step 2: Add folding state variables inside the `isHealer` cast loop block**

Add the active fold state tracker and `flushFold` function before processing `owner.spellCastEvents` (around line 668):

```typescript
    let activeFold: {
      displayName: string;
      targetLabel: string;
      startTimeSeconds: number;
      count: number;
    } | null = null;

    function flushFold() {
      if (!activeFold) return;
      const { displayName, targetLabel, startTimeSeconds, count } = activeFold;
      const targetPart = targetLabel ? ` → ${targetLabel}` : '';
      const countPart = count > 1 ? ` (x${count})` : '';
      addEntry(
        startTimeSeconds,
        `${fmtTime(startTimeSeconds)}  [YOU] [CAST]   ${displayName}${countPart}${targetPart}`,
      );
      activeFold = null;
    }
```

- [ ] **Step 3: Modify cast iteration loop to statefully fold or flush**

Update the cast loop to use `flushFold` and check fold conditions:

```typescript
    for (const e of owner.spellCastEvents ?? []) {
      if (e.logLine.event !== LogEvent.SPELL_CAST_SUCCESS) continue;
      if (!e.spellId) continue;
      const englishName = getEnglishSpellName(e.spellId, e.spellName);
      if (e.spellName && PASSIVE_SPELL_BLOCKLIST.has(e.spellName)) continue;

      const displayName = HEALER_CAST_SPELL_ID_TO_NAME[e.spellId] ?? englishName;
      if (!displayName) continue;
      const tsMs = e.logLine.timestamp;
      const trackedSet = trackedCastsBySpellId.get(e.spellId);
      if (trackedSet && (trackedSet.has(tsMs) || trackedSet.has(tsMs - 1000) || trackedSet.has(tsMs + 1000))) continue;
      if (trinketUseTimesMs.has(tsMs) || trinketUseTimesMs.has(tsMs - 1000) || trinketUseTimesMs.has(tsMs + 1000))
        continue;
      const timeSeconds = (tsMs - matchStartMs) / 1000;

      let stasisAnnotation = '';
      const activeStasis = stasisEvents.find((s) => timeSeconds >= s.startSeconds && timeSeconds < s.releaseSeconds);
      if (activeStasis && activeStasis.spells.includes(displayName)) {
        if (stateFormat === 'summary') {
          continue; // Suppress buffered heals in summary mode
        } else if (stateFormat === 'inline') {
          stasisAnnotation = ' [STASIS STORED]';
        }
      }

      // CC proximity tracking
      const CC_PROXIMITY_MS = 1000;
      const nearestCC = ownerCCMsTimestamps
        .filter((ccMs) => Math.abs(ccMs - tsMs) <= CC_PROXIMITY_MS)
        .sort((a, b) => Math.abs(a - tsMs) - Math.abs(b - tsMs))[0];
      let orderNote = '';
      if (nearestCC !== undefined) {
        if (tsMs < nearestCC) {
          orderNote = ' [completed before CC landed]';
        } else if (tsMs > nearestCC) {
          orderNote = ' [succeeded after CC arrived — within 1s in log]';
        } else {
          orderNote = ' [same server tick as CC — cast succeeded per log]';
        }
      }

      const targetLabel = resolveTarget(e.destUnitName);
      const targetPart = targetLabel ? ` → ${targetLabel}` : '';
      const destType = getUnitType(e.destUnitFlags ?? 0);
      let totemNote = '';
      if (destType === CombatUnitType.Guardian || destType === CombatUnitType.Pet) {
        totemNote =
          (e.destUnitName?.toLowerCase().includes('grounding totem') ?? false)
            ? ' [absorbed: Grounding Totem]'
            : ' [totem/pet]';
      }

      // CC casts
      if (ccSpellIds.has(e.spellId)) {
        flushFold();
        addEntry(
          timeSeconds,
          `${fmtTime(timeSeconds)}  [YOU] [CC]   ${displayName}${targetPart}${totemNote}${orderNote}`,
          resourceSnapshot(timeSeconds),
        );
        continue;
      }

      // Major CD casts
      const effectData = spellEffectData[e.spellId];
      const cdSeconds = effectData?.cooldownSeconds ?? effectData?.charges?.chargeCooldownSeconds ?? 0;
      if (cdSeconds >= 30) {
        flushFold();
        addEntry(
          timeSeconds,
          `${fmtTime(timeSeconds)}  [YOU] [CD]   ${displayName}${targetPart}${totemNote}${stasisAnnotation}`,
          resourceSnapshot(timeSeconds),
        );
        continue;
      }

      // Folding condition: no annotations, not in critical window
      const isFoldable =
        totemNote === '' &&
        orderNote === '' &&
        stasisAnnotation === '' &&
        !criticalWindowSet.has(Math.floor(timeSeconds));

      if (isFoldable) {
        if (activeFold && activeFold.displayName === displayName && activeFold.targetLabel === targetLabel) {
          activeFold.count++;
        } else {
          flushFold();
          activeFold = {
            displayName,
            targetLabel,
            startTimeSeconds: timeSeconds,
            count: 1,
          };
        }
      } else {
        flushFold();
        addEntry(
          timeSeconds,
          `${fmtTime(timeSeconds)}  [YOU] [CAST]   ${displayName}${targetPart}${totemNote}${orderNote}${stasisAnnotation}`,
        );
      }
    }
    // Flush any remaining active folds at loop end
    flushFold();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @wowarenalogs/shared -- packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts
git commit -m "feat: implement repetitive cast folding in match timeline"
```

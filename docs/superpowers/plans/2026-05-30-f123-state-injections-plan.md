# F123: Spec-Specific State Injections (Evoker Stasis & Druid Shapeshifts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract and visualize Evoker Stasis buffering and Druid Shapeshifting (Bear/Cat form) within the AI timeline, allowing for A/B testing across three formats: inline, summary, and verbose.

**Architecture:** We will create a new utility module `combatStates.ts` to parse raw combat events and extract Stasis buffering arrays and Shapeshift intervals. These extracted states will be passed into `matchTimeline.ts`, which will format the output based on a new CLI flag `stateFormat`.

**Tech Stack:** TypeScript, Node.js (CLI), Jest.

---

### Task 1: Create `combatStates.ts` Interface and Utility

**Files:**
- Create: `packages/shared/src/utils/combatStates.ts`
- Create: `packages/shared/src/utils/__tests__/combatStates.test.ts`
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/utils.ts`

- [ ] **Step 1: Write the failing tests for `combatStates.ts`**

Write a test file setting up dummy data for Evoker Stasis and Druid Shapeshifting to test the `extractStasisEvents` and `extractShapeshiftIntervals` functions.

```typescript
// packages/shared/src/utils/__tests__/combatStates.test.ts
import { AtomicArenaCombat, CombatUnitClass, CombatUnitReaction, CombatUnitSpec, CombatUnitType, ICombatUnit, LogEvent } from "@wowarenalogs/parser";
import { extractShapeshiftIntervals, extractStasisEvents } from "../combatStates";

describe("combatStates", () => {
  const mockCombat = {
    startTime: 0,
    endTime: 10000,
  } as AtomicArenaCombat;

  const mockUnit: ICombatUnit = {
    id: "Player-1",
    name: "TestDruid",
    class: CombatUnitClass.Druid,
    spec: CombatUnitSpec.Druid_Restoration,
    reaction: CombatUnitReaction.Friendly,
    type: CombatUnitType.Player,
    isWellFormed: true,
    ownerId: "Player-1",
    affiliation: 1,
    damageIn: [], damageOut: [], healIn: [], healOut: [],
    absorbsIn: [], absorbsOut: [], absorbsDamaged: [],
    supportDamageIn: [], supportDamageOut: [], supportHealIn: [], supportHealOut: [],
    actionIn: [], actionOut: [], deathRecords: [], consciousDeathRecords: [], advancedActions: [],
    auraEvents: [
      { logLine: { event: LogEvent.SPELL_AURA_APPLIED, timestamp: 1000 }, spellId: "5487", spellName: "Bear Form (Shapeshift)" } as any,
      { logLine: { event: LogEvent.SPELL_AURA_REMOVED, timestamp: 3000 }, spellId: "5487", spellName: "Bear Form (Shapeshift)" } as any,
      { logLine: { event: LogEvent.SPELL_AURA_APPLIED, timestamp: 4000 }, spellId: "768", spellName: "Cat Form (Shapeshift)" } as any,
      { logLine: { event: LogEvent.SPELL_AURA_REMOVED, timestamp: 8000 }, spellId: "768", spellName: "Cat Form (Shapeshift)" } as any,
    ],
    spellCastEvents: [
      { logLine: { event: LogEvent.SPELL_AURA_APPLIED, timestamp: 2000 }, spellId: "370537", spellName: "Stasis" } as any,
      { logLine: { event: LogEvent.SPELL_CAST_SUCCESS, timestamp: 2500 }, spellId: "366155", spellName: "Reversion" } as any,
      { logLine: { event: LogEvent.SPELL_CAST_SUCCESS, timestamp: 3500 }, spellId: "355936", spellName: "Dream Breath" } as any,
      { logLine: { event: LogEvent.SPELL_AURA_REMOVED, timestamp: 5000 }, spellId: "370537", spellName: "Stasis" } as any,
    ]
  };

  it("extractShapeshiftIntervals extracts form intervals", () => {
    const intervals = extractShapeshiftIntervals(mockUnit, mockCombat);
    expect(intervals).toHaveLength(2);
    expect(intervals[0]).toEqual({ form: "Bear", startSeconds: 1, endSeconds: 3 });
    expect(intervals[1]).toEqual({ form: "Cat", startSeconds: 4, endSeconds: 8 });
  });

  it("extractStasisEvents extracts buffered spells", () => {
    const stasisEvents = extractStasisEvents(mockUnit, mockCombat);
    expect(stasisEvents).toHaveLength(1);
    expect(stasisEvents[0].startSeconds).toBe(2);
    expect(stasisEvents[0].releaseSeconds).toBe(5);
    expect(stasisEvents[0].spells).toEqual(["Reversion", "Dream Breath"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @wowarenalogs/shared test -- packages/shared/src/utils/__tests__/combatStates.test.ts`
Expected: FAIL due to missing module

- [ ] **Step 3: Write minimal implementation in `combatStates.ts`**

```typescript
// packages/shared/src/utils/combatStates.ts
import { AtomicArenaCombat, ICombatUnit, LogEvent } from "@wowarenalogs/parser";

export interface IFormInterval {
  form: "Bear" | "Cat";
  startSeconds: number;
  endSeconds: number;
}

export interface IStasisEvent {
  startSeconds: number;
  releaseSeconds: number;
  spells: string[];
}

export function extractShapeshiftIntervals(unit: ICombatUnit, combat: AtomicArenaCombat): IFormInterval[] {
  const intervals: IFormInterval[] = [];
  let currentForm: "Bear" | "Cat" | null = null;
  let currentStart = 0;

  for (const aura of unit.auraEvents) {
    if (!aura.spellName) continue;
    
    const isBear = aura.spellId === "5487" || aura.spellId === "9634"; // Bear Form, Dire Bear Form
    const isCat = aura.spellId === "768"; // Cat Form

    if (aura.logLine.event === LogEvent.SPELL_AURA_APPLIED) {
      if (isBear) { currentForm = "Bear"; currentStart = aura.logLine.timestamp; }
      else if (isCat) { currentForm = "Cat"; currentStart = aura.logLine.timestamp; }
    } else if (aura.logLine.event === LogEvent.SPELL_AURA_REMOVED) {
      if ((isBear && currentForm === "Bear") || (isCat && currentForm === "Cat")) {
        intervals.push({
          form: currentForm,
          startSeconds: (currentStart - combat.startTime) / 1000,
          endSeconds: (aura.logLine.timestamp - combat.startTime) / 1000,
        });
        currentForm = null;
      }
    }
  }

  // Handle forms held until the end of the match
  if (currentForm) {
    intervals.push({
      form: currentForm,
      startSeconds: (currentStart - combat.startTime) / 1000,
      endSeconds: (combat.endTime - combat.startTime) / 1000,
    });
  }

  return intervals;
}

export function extractStasisEvents(unit: ICombatUnit, combat: AtomicArenaCombat): IStasisEvent[] {
  const events: IStasisEvent[] = [];
  let isBuffering = false;
  let startSeconds = 0;
  let bufferedSpells: string[] = [];

  // Evokers buffer heals when Stasis (370537) is active.
  // We scan both aura events (for boundaries) and cast events (for the buffered spells).
  const mergedEvents = [...unit.auraEvents, ...unit.spellCastEvents]
    .filter(e => e.logLine.event === LogEvent.SPELL_AURA_APPLIED || e.logLine.event === LogEvent.SPELL_AURA_REMOVED || e.logLine.event === LogEvent.SPELL_CAST_SUCCESS)
    .sort((a, b) => a.logLine.timestamp - b.logLine.timestamp);

  for (const e of mergedEvents) {
    if (e.spellId === "370537" && e.logLine.event === LogEvent.SPELL_AURA_APPLIED) {
      isBuffering = true;
      startSeconds = (e.logLine.timestamp - combat.startTime) / 1000;
      bufferedSpells = [];
    } else if (e.spellId === "370537" && e.logLine.event === LogEvent.SPELL_AURA_REMOVED && isBuffering) {
      events.push({
        startSeconds,
        releaseSeconds: (e.logLine.timestamp - combat.startTime) / 1000,
        spells: [...bufferedSpells]
      });
      isBuffering = false;
    } else if (isBuffering && e.logLine.event === LogEvent.SPELL_CAST_SUCCESS) {
      // Only record actual heals buffered, but for safety record all casts while buffering
      if (e.spellName && e.spellName !== "Stasis" && bufferedSpells.length < 3) {
         // Exclude auto attacks and basic mobility from buffered string if needed, 
         // but for Evokers they"ll mostly be casting heals.
         bufferedSpells.push(e.spellName);
      }
    }
  }

  return events;
}
```

- [ ] **Step 4: Export utilities from barrel file**

Modify `packages/shared/src/components/CombatReport/CombatAIAnalysis/utils.ts` to export the new functions.

```typescript
// packages/shared/src/components/CombatReport/CombatAIAnalysis/utils.ts (add to end of file)
export { extractShapeshiftIntervals, extractStasisEvents, type IFormInterval, type IStasisEvent } from "../../../utils/combatStates";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run -w @wowarenalogs/shared test -- packages/shared/src/utils/__tests__/combatStates.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/utils/combatStates.ts packages/shared/src/utils/__tests__/combatStates.test.ts packages/shared/src/components/CombatReport/CombatAIAnalysis/utils.ts
git commit -m "feat: Add extractShapeshiftIntervals and extractStasisEvents utilities"
```

---

### Task 2: Integrate States into `BuildMatchTimelineParams`

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`
- Modify: `packages/tools/src/printMatchPrompts.ts`

- [ ] **Step 1: Modify `matchTimeline.ts` signature**

Update `BuildMatchTimelineParams` in `matchTimeline.ts` to accept the new state data and the `stateFormat` flag.

```typescript
// Add to imports in packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts:
import { IFormInterval, IStasisEvent } from "../../../utils/combatStates";

// Update BuildMatchTimelineParams in packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts:
export interface BuildMatchTimelineParams {
  // ... existing fields ...
  allUnits?: ICombatUnit[];
  gateCcAvoidanceToDanger?: boolean;
  // NEW FIELDS
  stasisEvents?: IStasisEvent[];
  shapeshiftIntervals?: Array<{ player: ICombatUnit, intervals: IFormInterval[] }>;
  stateFormat?: "inline" | "summary" | "verbose";
}
```

- [ ] **Step 2: Destructure new params**

Update the destructuring of `params` inside `buildMatchTimeline` to include the new fields.

```typescript
// Inside buildMatchTimeline(params: BuildMatchTimelineParams): string {
  const {
    owner,
    // ...
    gateCcAvoidanceToDanger,
    stasisEvents = [],
    shapeshiftIntervals = [],
    stateFormat = "summary",
  } = params;
```

- [ ] **Step 3: Modify `printMatchPrompts.ts` to support the new flag**

Add CLI parsing for the new `--state-format` flag and pass it along with the extracted state data.

```typescript
// In packages/tools/src/printMatchPrompts.ts
// Add imports
import { extractShapeshiftIntervals, extractStasisEvents } from "../../shared/src/utils/combatStates";
import { CombatUnitType } from "@wowarenalogs/parser";

// Find the argument parsing section and add:
const stateFormatArg = process.argv.find((a) => a.startsWith("--state-format="));
const stateFormatStr = stateFormatArg ? stateFormatArg.split("=")[1] : "summary";
const stateFormat = ["inline", "summary", "verbose"].includes(stateFormatStr) ? (stateFormatStr as "inline" | "summary" | "verbose") : "summary";

// Find the section preparing data for buildMatchTimeline (around line 1400 in buildMatchPromptNew)
// Add extraction:
  const stasisEvents = extractStasisEvents(owner, combat);
  
  const allIntervals = [...combat.units.values()].filter(u => u.type === CombatUnitType.Player).map(u => ({
    player: u,
    intervals: extractShapeshiftIntervals(u, combat),
  })).filter(x => x.intervals.length > 0);

// Add to the buildMatchTimeline call:
  const timeline = buildMatchTimeline({
    owner,
    ownerSpec: unitSpec,
    // ... existing ...
    stasisEvents,
    shapeshiftIntervals: allIntervals,
    stateFormat,
  });
```

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts packages/tools/src/printMatchPrompts.ts
git commit -m "feat: Add state parameters and CLI flag for A/B testing formats"
```

---

### Task 3: Implement `summary` and `verbose` formatting for Shapeshifts

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`

- [ ] **Step 1: Implement `## NOTABLE STATES` (summary mode)**

Inside `buildMatchTimeline`, before looping through seconds, construct the summary block.

```typescript
// Add right before `const timelineLines: string[] = [];`
  const summaryLines: string[] = [];
  if (stateFormat === "summary" && shapeshiftIntervals.length > 0) {
    summaryLines.push("## NOTABLE STATES");
    for (const { player, intervals } of shapeshiftIntervals) {
      const bearTime = intervals.filter(i => i.form === "Bear").reduce((acc, i) => acc + (i.endSeconds - i.startSeconds), 0);
      const catTime = intervals.filter(i => i.form === "Cat").reduce((acc, i) => acc + (i.endSeconds - i.startSeconds), 0);
      const pLabel = player.id === owner.id ? "YOU" : pid(player.name);
      
      if (bearTime > 0) summaryLines.push(`- ${pLabel} spent ${Math.round(bearTime)}s in Bear Form.`);
      if (catTime > 0) summaryLines.push(`- ${pLabel} spent ${Math.round(catTime)}s in Cat Form.`);
    }
    if (summaryLines.length > 1) {
      summaryLines.push("");
    } else {
      summaryLines.length = 0; // Empty if no valid times found
    }
  }
```

- [ ] **Step 2: Append summary to final output**

Update the return statement of `buildMatchTimeline`.

```typescript
// Replace `return timelineLines.join("\n");` with:
  const fullTimeline = timelineLines.join("\n");
  if (summaryLines.length > 0) {
    return summaryLines.join("\n") + fullTimeline;
  }
  return fullTimeline;
```

- [ ] **Step 3: Implement `[SHIFT]` events (verbose mode)**

Inside `buildMatchTimeline`, where `allTimelineEvents` are collected (around line 250), inject the shift events.

```typescript
  // 9. Add Form shifts (Verbose mode only)
  if (stateFormat === "verbose") {
    for (const { player, intervals } of shapeshiftIntervals) {
      const isOwner = player.id === owner.id;
      const prefix = isOwner ? "[YOU]" : (friends.some(f => f.id === player.id) ? "[TEAM]" : "[ENEMY]");
      const pLabel = isOwner ? "" : ` ${pid(player.name)}`;
      
      for (const interval of intervals) {
        allTimelineEvents.push({
          timeSeconds: interval.startSeconds,
          type: "form",
          render: () => `${fmtTime(interval.startSeconds)}  ${prefix} [SHIFT]${pLabel} entered ${interval.form} Form`,
        });
      }
    }
  }
```

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts
git commit -m "feat: Implement summary and verbose modes for shapeshift timeline integration"
```

---

### Task 4: Implement `inline` formatting for Shapeshifts

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`

- [ ] **Step 1: Inject form suffix into HP strings**

Inside the `[STATE]` renderer (where `getUnitHpAtTimestamp` is called around line 760), we need to append `:bear` or `:cat` if the unit is in that form at that second.

```typescript
// Locate the `friendStrs` generation loop inside `addEntry("state", ...)`:
// const hp = getUnitHpAtTimestamp(f, currentSecond * 1000, matchStartMs);
// friendStrs.push(`${idx + 1}:${hp}%`);

// Replace with:
        const hp = getUnitHpAtTimestamp(f, currentSecond * 1000, matchStartMs);
        let formStr = "";
        if (stateFormat === "inline") {
          const formRecord = shapeshiftIntervals.find(s => s.player.id === f.id);
          if (formRecord) {
            const activeForm = formRecord.intervals.find(i => currentSecond >= i.startSeconds && currentSecond <= i.endSeconds);
            if (activeForm) formStr = `:${activeForm.form.toLowerCase()}`;
          }
        }
        friendStrs.push(`${idx + 1}:${hp}%${formStr}`);
```

```typescript
// Do the same for `enemyStrs`:
        const hp = getUnitHpAtTimestamp(e, currentSecond * 1000, matchStartMs);
        let formStr = "";
        if (stateFormat === "inline") {
          const formRecord = shapeshiftIntervals.find(s => s.player.id === e.id);
          if (formRecord) {
            const activeForm = formRecord.intervals.find(i => currentSecond >= i.startSeconds && currentSecond <= i.endSeconds);
            if (activeForm) formStr = `:${activeForm.form.toLowerCase()}`;
          }
        }
        enemyStrs.push(`${enemyPid(e.name)}:${hp}%${formStr}`);
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts
git commit -m "feat: Implement inline shapeshift state in timeline HP updates"
```

---

### Task 5: Implement Stasis Formatting (`inline` & `summary`)

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`

- [ ] **Step 1: Extract Stasis events into render queue**

Inject Stasis Release events (for summary mode) and filter out Stasis-stored casts (from the normal `[OWNER CAST]`).

```typescript
  // Around line 250 in buildMatchTimeline where `allTimelineEvents` are populated:
  
  // 10. Process Stasis Events
  for (const stasis of stasisEvents) {
    if (stateFormat === "summary") {
      allTimelineEvents.push({
        timeSeconds: stasis.releaseSeconds,
        type: "stasis",
        render: () => `${fmtTime(stasis.releaseSeconds)}  [YOU] [STASIS RELEASE] → ${stasis.spells.join(", ")}`,
      });
    }
  }
```

- [ ] **Step 2: Annotate or Suppress standard casts**

Locate the `[OWNER CAST]` generation logic (around line 344) and modify it to handle Stasis interactions based on the format.

```typescript
// Locate the loop: `for (const cast of owner.spellCastEvents) { ... }`
// Add this check inside the loop before pushing to `allTimelineEvents`:

        const isHealerCast = isHealer && !PASSIVE_SPELL_BLOCKLIST.has(cast.spellName || "");
        if (!isHealerCast) continue;

        let stasisAnnotation = "";
        const castSec = (cast.logLine.timestamp - matchStartMs) / 1000;
        const activeStasis = stasisEvents.find(s => castSec >= s.startSeconds && castSec < s.releaseSeconds);
        
        if (activeStasis) {
          if (stateFormat === "summary") {
            continue; // Suppress the individual cast entirely in summary mode
          } else if (stateFormat === "inline") {
            stasisAnnotation = " [STASIS STORED]";
          }
        }

        // ... update the render string to include the annotation:
        // `${fmtTime(castSec)}  [YOU] [CAST]   ${cast.spellName}${targetStr}${interruptedSuffix}${stasisAnnotation}`
```

```typescript
// Exact replacement for the push block (around line 355):
        allTimelineEvents.push({
          timeSeconds: castSec,
          type: "cast",
          render: () => {
            const targetStr = targetLabel ? ` → ${targetLabel}` : "";
            return `${fmtTime(castSec)}  [YOU] [CAST]   ${cast.spellName}${targetStr}${interruptedSuffix}${stasisAnnotation}`;
          },
        });
```

- [ ] **Step 3: Run typescript verification**

Run: `npm run -w @wowarenalogs/shared typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts
git commit -m "feat: Implement Stasis summary and inline formatting logic"
```

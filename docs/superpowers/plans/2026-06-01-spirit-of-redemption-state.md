# F130 Spirit of Redemption State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Spirit of Redemption (ghost form) tracking to prevent AI hallucinations during Holy Priest death windows, and verify lack of bias via A/B testing.

**Architecture:** We will extract the Spirit of Redemption intervals in `combatStates.ts`, pass them through `printMatchPrompts.ts`, and render them as `:ghost` in `matchTimeline.ts` along with explicit start/end markers. Finally, we will run the `evalPromptCompare.ts` pipeline to A/B test the changes, injecting specific bias-testing questions into the treatment prompts.

**Tech Stack:** TypeScript, Anthropic SDK, Jest.

---

### Task 1: Implement Data Extraction in `combatStates.ts`

**Files:**
- Modify: `packages/shared/src/utils/combatStates.ts`
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/utils.ts`

- [ ] **Step 1: Write the extraction function**

Modify `packages/shared/src/utils/combatStates.ts` to export the new interface and extraction logic. Insert this at the top with the other interfaces and at the bottom as a new exported function:

```typescript
// Add to the top of combatStates.ts
export interface ISpiritOfRedemptionInterval {
  startSeconds: number;
  endSeconds: number;
}
```

```typescript
// Add to the bottom of combatStates.ts
export function extractSpiritOfRedemptionIntervals(
  unit: ICombatUnit,
  combat: AtomicArenaCombat,
): ISpiritOfRedemptionInterval[] {
  const intervals: ISpiritOfRedemptionInterval[] = [];
  let sorStart: number | null = null;

  for (const aura of unit.auraEvents) {
    if (!aura.spellName) continue;

    // 27827: Spirit of Redemption (Passive on-death)
    // 215982: Spirit of the Redeemer (PvP Talent active use)
    const isSoR = aura.spellId === '27827' || aura.spellId === '215982';

    if (aura.logLine.event === LogEvent.SPELL_AURA_APPLIED && isSoR) {
      sorStart = aura.logLine.timestamp;
    } else if (aura.logLine.event === LogEvent.SPELL_AURA_REMOVED && isSoR && sorStart !== null) {
      intervals.push({
        startSeconds: (sorStart - combat.startTime) / 1000,
        endSeconds: (aura.logLine.timestamp - combat.startTime) / 1000,
      });
      sorStart = null;
    }
  }

  // Handle case where the match ends while still in ghost form
  if (sorStart !== null) {
    intervals.push({
      startSeconds: (sorStart - combat.startTime) / 1000,
      endSeconds: (combat.endTime - combat.startTime) / 1000,
    });
  }

  return intervals;
}
```

- [ ] **Step 2: Export from Barrel File**

Modify `packages/shared/src/components/CombatReport/CombatAIAnalysis/utils.ts` to export the new functions:

```typescript
// Modify the combatStates.ts export block in packages/shared/src/components/CombatReport/CombatAIAnalysis/utils.ts
export {
  extractShapeshiftIntervals,
  extractStasisEvents,
  extractSpiritOfRedemptionIntervals,
  type IFormInterval,
  type IStasisEvent,
  type ISpiritOfRedemptionInterval,
} from '../../../utils/combatStates';
```

- [ ] **Step 3: Run linter to verify syntax**

Run: `npm run -w @wowarenalogs/shared lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/utils/combatStates.ts packages/shared/src/components/CombatReport/CombatAIAnalysis/utils.ts
git commit -m "feat(ai): extract Spirit of Redemption intervals"
```

---

### Task 2: Inject Intervals into Timeline Params

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`
- Modify: `packages/tools/src/printMatchPrompts.ts`

- [ ] **Step 1: Update BuildMatchTimelineParams interface**

Modify `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts` to accept the new data. Add the import `ISpiritOfRedemptionInterval` at the top and update the interface:

```typescript
// Add to BuildMatchTimelineParams in matchTimeline.ts
export interface BuildMatchTimelineParams {
  // ... existing fields ...
  stasisEvents?: IStasisEvent[];
  shapeshiftIntervals?: Array<{ player: ICombatUnit; intervals: IFormInterval[] }>;
  spiritOfRedemptionIntervals?: Array<{ player: ICombatUnit; intervals: ISpiritOfRedemptionInterval[] }>;
}
```

- [ ] **Step 2: Extract data in Prompt Builder**

Modify `packages/tools/src/printMatchPrompts.ts`. First import `extractSpiritOfRedemptionIntervals`. Then, populate the intervals:

```typescript
// In printMatchPrompts.ts, around line 940 where stasisEvents are passed:

  const spiritOfRedemptionIntervals = friends
    .filter((p) => p.spec === CombatUnitSpec.Priest_Holy)
    .map((p) => ({ player: p, intervals: extractSpiritOfRedemptionIntervals(p, combat) }))
    .filter((entry) => entry.intervals.length > 0);

  const params: BuildMatchTimelineParams = {
    // ... existing ...
    stasisEvents,
    shapeshiftIntervals,
    spiritOfRedemptionIntervals,
  };
```

- [ ] **Step 3: Run linter**

Run: `npm run -w @wowarenalogs/tools lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts packages/tools/src/printMatchPrompts.ts
git commit -m "feat(ai): pass Spirit of Redemption data to timeline builder"
```

---

### Task 3: Render `:ghost` and Explicit Event Markers

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`

- [ ] **Step 1: Update State Ticks logic**

Modify the state ticks loop (around line 900) in `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts` to check if a friendly player is in the ghost state.

```typescript
    // Inside the matchTimeline.ts state ticks generation (currentFriendlies map function):
    const currentFriendlies = friendlyHpUnits.map(({ unit, label }) => {
      const deathAt = friendlyDeathAtByName.get(unit.name);
      const isDead = deathAt !== undefined && t >= Math.floor(deathAt);
      
      // NEW: Check for ghost form
      const isGhost =
        spiritOfRedemptionIntervals?.some(
          (s) =>
            s.player.id === unit.id &&
            s.intervals.some((interval) => t >= Math.floor(interval.startSeconds) && t <= Math.floor(interval.endSeconds)),
        ) ?? false;

      const pct = getUnitHpAtTimestamp(unit, tsMs, sampleWindowMs);
      const clamped = pct !== null ? Math.min(pct, 100) : null;

      // Ensure we don't output :dead if they are currently a :ghost
      if (isGhost) {
        friendlyParts.push(`${label(unit.name)}:ghost`);
      } else if (isDead) {
        friendlyParts.push(`${label(unit.name)}:dead`);
      } else if (clamped !== null) {
        friendlyParts.push(`${label(unit.name)}:${clamped}`);
      }
      return { name: unit.name, isDead: isDead && !isGhost, hp: clamped };
    });
```

- [ ] **Step 2: Inject Verbose Mode Explicit Events**

Scroll down to where form shifts are handled (around line 1000) and inject verbose markers.

```typescript
  // In matchTimeline.ts
  if (stateFormat === 'verbose' && spiritOfRedemptionIntervals && spiritOfRedemptionIntervals.length > 0) {
    for (const { player, intervals } of spiritOfRedemptionIntervals) {
      const isOwner = player.id === owner.id;
      const prefix = isOwner ? '[YOU]' : friends.some((f) => f.id === player.id) ? '[TEAM]' : '[ENEMY]';
      const pLabel = isOwner ? '' : ` ${pid(player.name)}`;

      for (const interval of intervals) {
        addEntry(
          interval.startSeconds,
          `${fmtTime(interval.startSeconds)}  ${prefix} [SPIRIT OF REDEMPTION]${pLabel} entered Spirit of Redemption (Ghost Form)`,
        );
        addEntry(
          interval.endSeconds,
          `${fmtTime(interval.endSeconds)}  ${prefix} [SPIRIT OF REDEMPTION]${pLabel} form expired`,
        );
      }
    }
  }
```

- [ ] **Step 3: Run parser tests to verify no compilation/basic logic errors**

Run: `npm run -w @wowarenalogs/parser test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts
git commit -m "feat(ai): render :ghost state and SoR events in timeline"
```

---

### Task 4: Prepare Bias Testing A/B Prompts

**Files:**
- Modify: `packages/tools/src/evalPromptCompare.ts`

- [ ] **Step 1: Filter Control Phase to Holy Priests**

In `evalPromptCompare.ts`, locate the data loading logic (around Phase 1 assembly). Ensure we only pick matches containing a Holy Priest. The user can pass `--healer`, but we want to specifically ensure Holy Priests are tested.

```typescript
// In packages/tools/src/evalPromptCompare.ts inside the assembleControlCorpus function:
// The developer will modify the filter criteria to prioritize Holy Priests:
const hasHolyPriest = Object.values(combat.units).some(u => u.spec === CombatUnitSpec.Priest_Holy);
if (!hasHolyPriest) return false;
```

- [ ] **Step 2: Inject Bias Testing Questions into Treatment Wrappers**

Locate the `buildTreatmentPrompt` function in `evalPromptCompare.ts`. Add explicit instructions targeting the Spirit of Redemption behavior:

```typescript
// In evalPromptCompare.ts buildTreatmentPrompt:
const biasTestingInstruction = `
<bias_test_instructions>
In addition to your standard coaching analysis, you MUST answer the following questions clearly in your reflection:
1. Did the Holy Priest enter Spirit of Redemption (ghost form) during this match?
2. If so, did they cast spells during this form?
3. Is casting spells while in Spirit of Redemption a mistake or a bug? (Hint: It is intended gameplay).
Ensure your final coaching output does not penalize the Priest for actions taken while in ghost form.
</bias_test_instructions>
`;

// Append biasTestingInstruction to the meta_eval_instructions block in the prompt string.
```

- [ ] **Step 3: Run the A/B Test Control Phase**

Run: `npm run -w @wowarenalogs/tools start:evalPromptCompare -- --phase control --count 5`
Expected: Successfully generates control prompts and responses.

- [ ] **Step 4: Run the A/B Test Treatment Phase**

Run: `npm run -w @wowarenalogs/tools start:evalPromptCompare -- --phase treatment`
Expected: LLM Judge produces a `comparison-report.md` proving that Treatment handles `:ghost` correctly and avoids penalizing the Priest.

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/evalPromptCompare.ts
git commit -m "test(ai): setup Holy Priest bias A/B testing for F130"
```

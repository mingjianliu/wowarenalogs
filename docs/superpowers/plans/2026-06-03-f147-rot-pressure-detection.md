# Rot Pressure Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert `[ROT PRESSURE]` lines in the match timeline when a target has 3+ active DoT debuffs and their HP is sub-40% for more than 3 seconds.

**Architecture:** We extract active DoT intervals for each player unit and sample their HP/DoT state second-by-second. If a player is under rot pressure for 4+ consecutive seconds (representing > 3 seconds duration), we emit a `[ROT PRESSURE]` event in the timeline, rate-limited to once per continuous block of pressure.

**Tech Stack:** TypeScript, Jest, @wowarenalogs/parser

---

### Task 1: Add Failing Tests for Rot Pressure Detection

**Files:**
- Modify: [timeline.test.ts](file:///Users/mingjianliu/code/wowarenalogs/packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts)

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block at the end of the test file `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`:

```typescript
describe('buildMatchTimeline — Rot Pressure Detection (F147)', () => {
  it('emits [ROT PRESSURE] when a player has 3+ dots and sub-40% HP for >3s', () => {
    // 3 dots applied at T=10s
    const corruption = makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '172', 10_000, 'enemy-1', 'p1');
    const agony = makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '980', 10_000, 'enemy-1', 'p1');
    const siphon = makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '63106', 10_000, 'enemy-1', 'p1');

    const p1 = makeUnit('p1', {
      name: 'Priest',
      spec: CombatUnitSpec.Priest_Discipline,
      auraEvents: [corruption, agony, siphon],
      advancedActions: [
        makeAdvancedAction(10_000, 0, 0, 100_000, 35_000), // 35% HP
        makeAdvancedAction(11_000, 0, 0, 100_000, 35_000),
        makeAdvancedAction(12_000, 0, 0, 100_000, 35_000),
        makeAdvancedAction(13_000, 0, 0, 100_000, 35_000), // Active for 4 ticks (T=10,11,12,13)
      ],
    });

    const params = makeBaseParams({
      friends: [p1],
      matchStartMs: 0,
      matchEndMs: 30_000,
    });
    const result = buildMatchTimeline(params);
    expect(result).toContain('0:13  [ROT PRESSURE]   1 (Discipline Priest) at 35% HP with 3 active DoTs');
  });

  it('does NOT emit [ROT PRESSURE] if the duration is 3s or less', () => {
    const corruption = makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '172', 10_000, 'enemy-1', 'p1');
    const agony = makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '980', 10_000, 'enemy-1', 'p1');
    const siphon = makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '63106', 10_000, 'enemy-1', 'p1');

    const p1 = makeUnit('p1', {
      name: 'Priest',
      spec: CombatUnitSpec.Priest_Discipline,
      auraEvents: [corruption, agony, siphon],
      advancedActions: [
        makeAdvancedAction(10_000, 0, 0, 100_000, 35_000), // 35% HP
        makeAdvancedAction(11_000, 0, 0, 100_000, 35_000),
        makeAdvancedAction(12_000, 0, 0, 100_000, 35_000), // 3 ticks total
      ],
    });

    const params = makeBaseParams({
      friends: [p1],
      matchStartMs: 0,
      matchEndMs: 30_000,
    });
    const result = buildMatchTimeline(params);
    expect(result).not.toContain('[ROT PRESSURE]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @wowarenalogs/shared -- packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`
Expected: FAIL due to missing `[ROT PRESSURE]` text in the output.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts
git commit -m "test: add failing tests for rot pressure detection"
```

---

### Task 2: Implement Rot Pressure Detection

**Files:**
- Modify: [matchTimeline.ts](file:///Users/mingjianliu/code/wowarenalogs/packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts)

- [ ] **Step 1: Define DOT lists in matchTimeline.ts**

Define the constants at the top or within `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts` (outside `buildMatchTimeline`):

```typescript
const DOT_SPELL_IDS = new Set<string>([
  '980', '172', '30108', '461531', '63106', '205179', '361695', // Warlock
  '589', '34914', '2944', '390978', // Priest
  '164812', '8921', '164815', '93402', '202347', '1079', '155722', '1822', '192090', '106830', // Druid
  '1943', '703', '2818', '122233', '121411', // Rogue
  '191587', '55078', '55095', // DK
  '188389', // Shaman
  '269747', '271788', '118253', '217200', // Hunter
  '12654', // Mage
  '115767', '84617', // Warrior
  '357209', // Evoker
]);

const DOT_SPELL_NAMES = new Set<string>([
  'agony',
  'corruption',
  'unstable affliction',
  'wither',
  'shadow word: pain',
  'vampiric touch',
  'devouring plague',
  'sunfire',
  'moonfire',
  'stellar flare',
  'rip',
  'rake',
  'thrash',
  'rupture',
  'garrote',
  'deadly poison',
  'crimson tempest',
  'virulent plague',
  'blood plague',
  'frost fever',
  'flame shock',
  'serpent sting',
  'ignite',
  'deep wounds',
  'fire breath'
]);

interface IDotInterval {
  spellId: string;
  spellName: string;
  startMs: number;
  endMs: number;
}
```

- [ ] **Step 2: Add Dot interval extraction helper**

Define helper functions to extract DoT intervals and scan for rot pressure inside `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`:

```typescript
function extractPlayerDotIntervals(
  player: ICombatUnit,
  matchStartMs: number,
  matchEndMs: number,
): IDotInterval[] {
  const intervals: IDotInterval[] = [];
  const openDots = new Map<string, number>();

  const sortedEvents = [...(player.auraEvents ?? [])].sort((a, b) => a.logLine.timestamp - b.logLine.timestamp);

  for (const event of sortedEvents) {
    const ts = event.logLine.timestamp;
    if (ts > matchEndMs) continue;

    const spellId = event.spellId ?? '';
    const spellName = getEnglishSpellName(spellId, event.spellName);
    const spellNameLower = spellName.toLowerCase();

    const isDot = DOT_SPELL_IDS.has(spellId) || [...DOT_SPELL_NAMES].some((name) => spellNameLower.includes(name));
    if (!isDot) continue;

    const auraType = event.logLine.parameters[11];
    if (auraType === 'BUFF') continue;

    const stateKey = `${spellId}:${event.srcUnitId}`;
    if (event.logLine.event === LogEvent.SPELL_AURA_APPLIED) {
      if (!openDots.has(stateKey)) {
        openDots.set(stateKey, ts);
      }
    } else if (event.logLine.event === LogEvent.SPELL_AURA_REMOVED) {
      const startMs = openDots.get(stateKey);
      if (startMs !== undefined) {
        intervals.push({
          spellId,
          spellName,
          startMs,
          endMs: ts,
        });
        openDots.delete(stateKey);
      }
    }
  }

  for (const [stateKey, startMs] of openDots) {
    const spellId = stateKey.split(':')[0];
    const spellName = getEnglishSpellName(spellId, '');
    intervals.push({
      spellId,
      spellName,
      startMs,
      endMs: matchEndMs,
    });
  }

  return intervals;
}
```

- [ ] **Step 3: Insert rot pressure detection inside buildMatchTimeline**

Insert this detection logic in the main body of `buildMatchTimeline`:

```typescript
  // ── Rot Pressure Detection (F147) ──────────────────────────────────────────
  for (const player of allPlayers) {
    const dotIntervals = extractPlayerDotIntervals(player, matchStartMs, matchEndMs);
    let consecutiveRotSeconds = 0;
    let emittedForThisBlock = false;

    for (let t = 0; t <= Math.floor(matchDurationS); t++) {
      const tsMs = matchStartMs + t * 1000;
      const activeDots = dotIntervals.filter((i) => tsMs >= i.startMs && tsMs <= i.endMs);
      const dotCount = activeDots.length;

      const hp = getUnitHpAtTimestamp(player, tsMs, 5000);

      if (hp !== null && hp < 40 && dotCount >= 3) {
        consecutiveRotSeconds++;
        if (consecutiveRotSeconds >= 4 && !emittedForThisBlock) {
          addEntry(
            t,
            `${fmtTime(t)}  [ROT PRESSURE]   ${pid(player.name)} (${specToString(player.spec)}) at ${Math.round(hp)}% HP with ${dotCount} active DoTs`,
          );
          emittedForThisBlock = true;
        }
      } else {
        consecutiveRotSeconds = 0;
        emittedForThisBlock = false;
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @wowarenalogs/shared -- packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts
git commit -m "feat: implement rot pressure detection in match timeline"
```

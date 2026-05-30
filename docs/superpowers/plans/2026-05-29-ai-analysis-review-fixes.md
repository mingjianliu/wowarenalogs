# AI Analysis Review Fixes (P0–P2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the P0–P2 findings from the 2026-05-29 review of the past week's AI-analysis work: fix the red test suite, correct a doc/code mismatch, repair the F138 delta-state regression, centralize hardcoded CC-avoidance spell IDs, remove dead code, clarify a tooling heuristic, and shrink the `matchTimeline.ts` god function via two safe block extractions.

**Architecture:** All changes live in `packages/shared` (the AI-analysis engine) plus one `packages/tools` comment. The data-extraction → timeline-string → LLM → findings pipeline is unchanged; we only fix correctness/clarity and pull two self-contained output blocks out of `buildMatchTimeline` into `timelineHelpers.ts`. The existing `timeline.test.ts` suite (run via `npx tsdx test`) is the regression net for every change.

**Tech Stack:** TypeScript, Jest via `tsdx test` (ts-jest, type-checks on compile), npm workspaces.

**Run all tests from `packages/shared`:** `cd packages/shared && npx tsdx test CombatAIAnalysis`
A clean baseline today is **2 failed / 2 passed** suites — Task 1 makes it fully green; do not regress below that after Task 1.

---

## File Structure

- `packages/shared/src/utils/ccTrinketAnalysis.ts` — Task 1 (make field optional), Task 4 (centralize spell-ID constants)
- `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts` — Task 2 (comment), Task 3 (F138 refresh), Task 5 (none), Task 7 (extract two blocks → call sites)
- `packages/shared/src/components/CombatReport/CombatAIAnalysis/resourceSnapshot.ts` — Task 5 (remove dead sentinel loop)
- `packages/shared/src/components/CombatReport/CombatAIAnalysis/timelineHelpers.ts` — Task 7 (new `buildKillSequenceBlock`, `buildMatchEndBlock`)
- `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts` — Task 3, Task 7 (new tests)
- `packages/tools/src/generateTalentModifiers.ts` — Task 6 (comment)

---

## Task 1 (P0): Fix red test suite — make `ccAvoidedInstances` optional

The `CC avoidance` commit added `ccAvoidedInstances` as a **required** field on `IPlayerCCTrinketSummary`, but three hand-built test fixtures omit it, so ts-jest refuses to compile `timeline.test.ts` and `index.test.ts`. The only non-test reader (`matchTimeline.ts:586`) already guards with `if (summary.ccAvoidedInstances)`, i.e. it was written expecting the field to be optional. Making the field optional aligns the type with both the guard and the fixtures with a one-line change.

**Files:**

- Modify: `packages/shared/src/utils/ccTrinketAnalysis.ts` (interface `IPlayerCCTrinketSummary`, ~line 116)

- [ ] **Step 1: Run the suite to confirm the current failure**

Run: `cd packages/shared && npx tsdx test CombatAIAnalysis`
Expected: `Test Suites: 2 failed, 2 passed` with `TS2741: Property 'ccAvoidedInstances' is missing`.

- [ ] **Step 2: Make the field optional**

In `IPlayerCCTrinketSummary`, change:

```ts
  /** CC avoidance/mitigation/breaks */
  ccAvoidedInstances: ICCAvoidedInstance[];
```

to:

```ts
  /** CC avoidance/mitigation/breaks. Optional: always populated by analyzePlayerCCAndTrinket,
   * but hand-built summaries (tests/fixtures) may omit it; consumers guard with `if (summary.ccAvoidedInstances)`. */
  ccAvoidedInstances?: ICCAvoidedInstance[];
```

- [ ] **Step 3: Run the suite to verify it is green**

Run: `cd packages/shared && npx tsdx test CombatAIAnalysis`
Expected: `Test Suites: 4 passed, 4 total`.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/utils/ccTrinketAnalysis.ts
git commit -m "fix(ai-analysis): make ccAvoidedInstances optional to unbreak test suite

The CC-avoidance commit added ccAvoidedInstances as a required field but
left three test fixtures without it, so ts-jest failed to compile two
suites. The sole consumer (matchTimeline.ts:586) already guards the field
as optional. Aligns the type with the guard and fixtures.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2 (P1): Fix HP-delta comment/code mismatch in `[STATE]` gate

`matchTimeline.ts` decides whether to emit a `[STATE]` tick partly on HP change. The comment says "at least 5%" but the code checks `>= 10`. The code is load-bearing and covered by tests, so we align the comment to the code (10%), not the reverse.

**Files:**

- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts` (~line 863, inside the `[STATE]` emit loop)

- [ ] **Step 1: Locate the mismatch**

Run: `grep -n "changed by at least 5%\|>= 10) {" packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`
Expected: a comment line containing "at least 5%" and a code line `if (lastHp === undefined || Math.abs(p.hp - lastHp) >= 10) {`.

- [ ] **Step 2: Fix the comment to match the code**

Change:

```ts
// Check if any player's HP changed by at least 5% or status changed since last emitted tick
```

to:

```ts
// Check if any player's HP changed by at least 10% or status changed since last emitted tick
```

- [ ] **Step 3: Run tests (no behavior change expected)**

Run: `cd packages/shared && npx tsdx test CombatAIAnalysis`
Expected: `Test Suites: 4 passed, 4 total`.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts
git commit -m "docs(ai-analysis): align [STATE] HP-delta comment with code (10% not 5%)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3 (P1, F138): Re-emit a full `[RES]` snapshot every 60s

The delta `rdy:Δ` format (`resourceSnapshot.ts`) cuts tokens but, per F138, makes the model lose track of available CDs in long, late-dampening matches. Fix: in the `resourceSnapshot` closure inside `buildMatchTimeline`, force the **full** (non-delta) form whenever ≥60s have elapsed since the last full emission, by passing `prevReadyNames`/`prevOnCDNames` as `undefined` (which `buildResourceSnapshot` already treats as "emit full form"). Delta state still updates every tick so subsequent deltas remain correct.

**Files:**

- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts` (the `resourceSnapshot` closure, ~lines 166–202)
- Test: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test at the end of `timeline.test.ts`, before the final closing of the file (it uses the existing `makeBaseParams`, `makeOwner`, `makeCD` helpers and `IMajorCooldownInfo`):

```ts
describe('buildMatchTimeline — F138 periodic full [RES] refresh', () => {
  it('re-emits a full rdy: list (not delta) at least every 60s in long matches', () => {
    // An always-ready CD (never cast) should appear by name in the full rdy: form.
    const alwaysReady = makeCD('Divine Toll', 60, true);
    alwaysReady.spellId = '2';
    // A second CD cast at 6s and 66s forces a [RES] emission at both timestamps.
    const trigger = makeCD('Avenging Wrath', 120);
    trigger.casts = [{ timeSeconds: 6 }, { timeSeconds: 66 }] as IMajorCooldownInfo['casts'];

    const result = buildMatchTimeline(
      makeBaseParams({
        owner: makeOwner('Feramonk'),
        ownerCDs: [trigger, alwaysReady],
      }),
    );

    // Full form prints "rdy:Divine Toll"; delta form would print "rdy:Δ".
    // Without the 60s refresh, the 1:06 snapshot would be delta and omit the name.
    const fullRdyCount = (result.match(/rdy:Divine Toll/g) ?? []).length;
    expect(fullRdyCount).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/shared && npx tsdx test CombatAIAnalysis -t "periodic full"`
Expected: FAIL — `fullRdyCount` is 1 (only the first snapshot is full; the 1:06 snapshot is delta `rdy:Δ`).

- [ ] **Step 3: Implement the 60s refresh in the closure**

In `matchTimeline.ts`, find:

```ts
let prevReadyNamesState: string[] | null = null;
let prevOnCDNamesState: string[] | null = null;
let lastSnapshotTime = -100;
```

Add a `lastFullSnapshotTime` tracker:

```ts
let prevReadyNamesState: string[] | null = null;
let prevOnCDNamesState: string[] | null = null;
let lastSnapshotTime = -100;
// F138: force a full (non-delta) [RES] at least every 60s so the model does not
// lose track of available CDs across long, late-dampening matches.
let lastFullSnapshotTime = -100;
const FULL_SNAPSHOT_REFRESH_SECONDS = 60;
```

Then replace this block:

```ts
const prevReadyNames = prevReadyNamesState ?? undefined;
const prevOnCDNames = prevOnCDNamesState ?? undefined;
prevReadyNamesState = currentReadyNames;
prevOnCDNamesState = currentOnCDNames;
```

with:

```ts
const forceFullRefresh = timeSeconds - lastFullSnapshotTime >= FULL_SNAPSHOT_REFRESH_SECONDS;
const prevReadyNames = forceFullRefresh ? undefined : (prevReadyNamesState ?? undefined);
const prevOnCDNames = forceFullRefresh ? undefined : (prevOnCDNamesState ?? undefined);
if (forceFullRefresh) lastFullSnapshotTime = timeSeconds;
prevReadyNamesState = currentReadyNames;
prevOnCDNamesState = currentOnCDNames;
```

- [ ] **Step 4: Run the new test and the full suite**

Run: `cd packages/shared && npx tsdx test CombatAIAnalysis`
Expected: `Test Suites: 4 passed, 4 total`, including the new "periodic full" test.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts
git commit -m "fix(ai-analysis): re-emit full [RES] every 60s to fix delta CD amnesia (F138)

Delta rdy:Δ tracking lost CD availability in long matches. Force the full
form whenever >=60s elapsed since the last full emission; delta state still
updates each tick so subsequent deltas stay correct.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4 (P1): Centralize hardcoded CC-avoidance spell IDs as named constants

`analyzePlayerCCAndTrinket` defines the avoidance `buffSpecs` map and the `breakableCCs` set inline inside the function body, alongside inline Grounding Totem / Shadow Word: Death IDs. This reintroduces the scattered-spell-ID maintenance debt that F113/F122 just removed. Lift them to documented module-level constants at the top of `ccTrinketAnalysis.ts` so the next seasonal update has one place to edit. (Full migration into the generated DB2 data set is out of scope — these avoidance buffs are not in the generated lists.)

**Files:**

- Modify: `packages/shared/src/utils/ccTrinketAnalysis.ts`

- [ ] **Step 1: Add module-level constants near the other constants block (after `SIGNIFICANT_CC_DAMAGE`, before the Interfaces section)**

```ts
/**
 * Buffs/abilities that can cause a targeted CC cast to whiff (dodge, reflect, immunity,
 * untargetable). Maps the buff's spell ID → display name shown as the avoidance reason.
 * Seasonal maintenance: update IDs here when these abilities change.
 */
const CC_AVOIDANCE_BUFF_SPELLS = new Map<string, string>([
  ['586', 'Fade'],
  ['1246965', 'Psychic Shroud'],
  ['377362', 'Precognition'],
  ['378464', 'Nullifying Shroud'],
  ['23920', 'Spell Reflection'],
  ['354610', 'Glimpse'],
  ['227847', 'Bladestorm'],
  ['389774', 'Bladestorm'],
]);

/** Shaman Grounding Totem — redirects the first targeted hostile spell. */
const GROUNDING_TOTEM_SPELL_ID = '8177';

/** Priest Shadow Word: Death — can break a freshly-applied breakable CC on the caster. */
const SHADOW_WORD_DEATH_SPELL_ID = '32379';

/**
 * CCs that a Priest can break by self-damaging via Shadow Word: Death (instant breaks).
 * Polymorph, Hex, Freezing Trap, Fear, Psychic Scream, Wyvern Sting.
 */
const SWD_BREAKABLE_CC_SPELL_IDS = new Set(['118', '51514', '3355', '5782', '8122', '19386']);
```

- [ ] **Step 2: Replace the inline `buffSpecs` map with the constant**

In `analyzePlayerCCAndTrinket`, delete the inline `const buffSpecs = new Map<string, string>([ ... ]);` declaration and replace every `buffSpecs` reference with `CC_AVOIDANCE_BUFF_SPELLS`. (References are at the `buffSpecs.has(spellId)` check and the `buffSpecs.get(spellId)` lookup.)

- [ ] **Step 3: Replace the inline `breakableCCs` set and the inline SW:D / Grounding IDs**

- Delete `const breakableCCs = new Set([ ... ]);` and replace `breakableCCs.has(cc.spellId)` with `SWD_BREAKABLE_CC_SPELL_IDS.has(cc.spellId)`.
- In the SW:D break block, replace the literal `'32379'` in the `e.spellId === '32379'` check with `SHADOW_WORD_DEATH_SPELL_ID`, and the pushed `avoidanceSpellId: '32379'` with `avoidanceSpellId: SHADOW_WORD_DEATH_SPELL_ID`.
- In the Grounding Totem block, replace the pushed `avoidanceSpellId: '8177'` with `avoidanceSpellId: GROUNDING_TOTEM_SPELL_ID`.

- [ ] **Step 4: Run tests (pure refactor, no behavior change)**

Run: `cd packages/shared && npx tsdx test CombatAIAnalysis ccTrinketAnalysis`
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/utils/ccTrinketAnalysis.ts
git commit -m "refactor(ai-analysis): centralize CC-avoidance spell IDs as named constants

Lift inline buffSpecs/breakableCCs maps and SW:D/Grounding IDs to documented
module-level constants so seasonal updates have a single edit point.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5 (P2): Remove dead `\x00enemy:` sentinel entries from the combined `playerIdMap`

`buildPlayerLoadout` writes enemy IDs into the combined `playerIdMap` under a `'\x00enemy:' + name` key. Verified across all consumers (`matchTimeline.ts` `pid`/`resolveTarget`, `resourceSnapshot.ts` `pid`, `printMatchPrompts.ts`): every enemy lookup goes through the separately-returned `enemyIdMap`, and no code reads the `\x00enemy:` keys. They are write-only dead entries.

**Files:**

- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/resourceSnapshot.ts` (~lines 82–92)

- [ ] **Step 1: Re-confirm nothing reads the sentinel key**

Run: `grep -rn "x00enemy\|'\\\\x00enemy:'\|enemy:' +" packages/shared/src packages/tools/src`
Expected: only the write site in `resourceSnapshot.ts` (and the comment). No read site.

- [ ] **Step 2: Remove the dead loop and its now-stale comment**

Replace:

```ts
// Build a combined playerIdMap that encodes side to avoid key collision.
// buildMatchTimeline's pid() function uses this map; friendly names are tried
// first (covering owner + teammates), then enemy names.
const playerIdMap = new Map<string, number>();
for (const [name, id] of friendlyIdMap) playerIdMap.set(name, id);
// Enemy names are added with a sentinel suffix internally so that a name collision
// does not silently overwrite the friendly entry.  We store them under
// "\x00enemy:name" — a key that normal lookups by display name will never hit.
// The buildMatchTimeline pid() helper resolves enemy names via enemyIdMap which
// is included in the returned object.
for (const [name, id] of enemyIdMap) playerIdMap.set('\x00enemy:' + name, id);

return { text: lines.join('\n'), playerIdMap, friendlyIdMap, enemyIdMap };
```

with:

```ts
// playerIdMap carries only friendly (owner + teammate) name→ID entries; pid() in
// buildMatchTimeline / buildResourceSnapshot looks up friendlies here. Enemies are
// resolved separately via the returned enemyIdMap, so there is no collision risk
// and enemy entries are deliberately NOT mixed into this map.
const playerIdMap = new Map<string, number>();
for (const [name, id] of friendlyIdMap) playerIdMap.set(name, id);

return { text: lines.join('\n'), playerIdMap, friendlyIdMap, enemyIdMap };
```

- [ ] **Step 3: Run the full AI-analysis suite**

Run: `cd packages/shared && npx tsdx test CombatAIAnalysis`
Expected: `Test Suites: 4 passed, 4 total` (note `timeline.test.ts:3495` asserts `result` does NOT contain `enemy:` — this change keeps that true).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/resourceSnapshot.ts
git commit -m "refactor(ai-analysis): drop write-only \\x00enemy: entries from playerIdMap

Enemy lookups always go through the separate enemyIdMap; the sentinel entries
were never read. Remove the dead loop and update the comment.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6 (P2): Document the ms-vs-seconds heuristic in `generateTalentModifiers.ts`

The generator assumes any cooldown-reduction `value > 500` is expressed in milliseconds and divides by 1000. That silently misclassifies any genuine >500-second reduction. It is low-risk today but undocumented. Add a comment recording the assumption and its basis.

**Files:**

- Modify: `packages/tools/src/generateTalentModifiers.ts` (~line 233)

- [ ] **Step 1: Expand the comment on the heuristic**

Replace:

```ts
// If it's reduction in ms, convert to seconds.
// Reduction amounts > 500 are almost certainly ms.
if (value > 500) {
  value = Math.round(value / 1000);
}
```

with:

```ts
// DB2 stores some CD-reduction effects in ms and others in seconds with no unit
// flag. Heuristic: no real talent reduces a cooldown by >500s, so any value >500
// is assumed to be milliseconds and converted to seconds. If a future talent ever
// legitimately reduces a CD by >500s, this would misclassify it — revisit then.
if (value > 500) {
  value = Math.round(value / 1000);
}
```

- [ ] **Step 2: Verify the tool still typechecks/builds (no test exists for this script)**

Run: `npx tsc --noEmit packages/tools/src/generateTalentModifiers.ts 2>&1 | grep generateTalentModifiers || echo "no errors in this file"`
Expected: `no errors in this file` (pre-existing unrelated errors in other files are fine; this file should be clean).

- [ ] **Step 3: Commit**

```bash
git add packages/tools/src/generateTalentModifiers.ts
git commit -m "docs(tools): document ms-vs-seconds CD-reduction heuristic assumption

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7 (P1): Shrink `matchTimeline.ts` by extracting the KILL SEQUENCE and MATCH END blocks

`buildMatchTimeline` is ~1097 lines with ~20 responsibilities. We extract the two most self-contained tail blocks — KILL SEQUENCE (~lines 916–1045) and MATCH END (~lines 1047–1094) — into pure functions in `timelineHelpers.ts`. Both append to `outputLines` and read only already-computed values, making them clean cut points. MATCH END is already test-covered; we add a characterization test for KILL SEQUENCE first so its extraction is also guarded.

**Files:**

- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/timelineHelpers.ts` (add two exported functions)
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts` (replace the two blocks with calls)
- Test: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts`

### 7a — Characterization test for KILL SEQUENCE

- [ ] **Step 1: Add a test that pins the current KILL SEQUENCE output**

Add to `timeline.test.ts`:

```ts
describe('buildMatchTimeline — KILL SEQUENCE block (characterization)', () => {
  it('emits a KILL SEQUENCE with [KILL] line for a sub-90s match with a friendly death', () => {
    const owner = makeOwner('Feramonk', CombatUnitSpec.Priest_Holy);
    const result = buildMatchTimeline(
      makeBaseParams({
        owner,
        matchEndMs: 80_000, // < 90s triggers the KILL SEQUENCE block
        friendlyDeaths: [{ spec: 'Unholy Death Knight', name: 'Simplesauce', atSeconds: 40 }],
        friends: [owner],
      }),
    );
    expect(result).toContain('KILL SEQUENCE');
    expect(result).toContain('[KILL]');
  });

  it('omits KILL SEQUENCE for matches >= 90s', () => {
    const result = buildMatchTimeline(
      makeBaseParams({
        matchEndMs: 120_000,
        friendlyDeaths: [{ spec: 'Unholy Death Knight', name: 'Simplesauce', atSeconds: 40 }],
      }),
    );
    expect(result).not.toContain('KILL SEQUENCE');
  });
});
```

- [ ] **Step 2: Run it against current code to confirm it passes (characterization baseline)**

Run: `cd packages/shared && npx tsdx test CombatAIAnalysis -t "KILL SEQUENCE"`
Expected: PASS (it documents current behavior). If the first test fails because `friends`/death lookup needs a real unit, adjust the fixture using `makeUnit` from `testHelpers` until it passes, keeping both assertions.

- [ ] **Step 3: Commit the characterization test**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/timeline.test.ts
git commit -m "test(ai-analysis): characterize KILL SEQUENCE block before extraction

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### 7b — Extract `buildMatchEndBlock`

- [ ] **Step 1: Add `buildMatchEndBlock` to `timelineHelpers.ts`**

Move the MATCH END block (from `// ── [MATCH END] block (F96)` through the final `return outputLines.join('\n')`'s preceding push logic, i.e. everything that pushes the `[MATCH END]` header and the friends/enemies state line) into a new exported function. Cut the existing code **verbatim** into this signature, replacing references to closure-local `pid`/`enemyPid`/`fmtTime`/`getHpPercentAtTime`/`getDampeningPercentage` with the passed-in equivalents (these are already imported in `timelineHelpers.ts` except `pid`/`enemyPid`, which become parameters):

```ts
export function buildMatchEndBlock(params: {
  matchStartMs: number;
  matchEndMs: number;
  matchEndSeconds: number;
  bracket?: string;
  owner: ICombatUnit;
  friends: ICombatUnit[];
  enemies: ICombatUnit[];
  friendlyDeaths: Array<{ name: string; atSeconds: number }>;
  enemyDeaths: Array<{ name: string; atSeconds: number }>;
  pid: (name: string) => string;
  enemyPid: (name: string) => string;
}): string[] {
  // ...verbatim MATCH END logic, returning the lines to append (including the leading '' spacer)...
}
```

It must `import { getHpPercentAtTime } from '../../../utils/killWindowTargetSelection';`, `import { getDampeningPercentage } from '../../../utils/dampening';`, and use the existing `fmtTime` import. Return the array of lines (the leading `''`, the `[MATCH END]` line, and the optional state line).

- [ ] **Step 2: Replace the block in `matchTimeline.ts` with a call**

Delete the inline MATCH END block and replace with:

```ts
outputLines.push(
  ...buildMatchEndBlock({
    matchStartMs,
    matchEndMs,
    matchEndSeconds,
    bracket,
    owner,
    friends,
    enemies: enemies ?? [],
    friendlyDeaths,
    enemyDeaths,
    pid,
    enemyPid,
  }),
);

return outputLines.join('\n');
```

Add `buildMatchEndBlock` to the import from `./timelineHelpers`. Remove the now-unused `getDampeningPercentage` / `getHpPercentAtTime` imports from `matchTimeline.ts` **only if** no other code there still uses them (check with grep before removing).

- [ ] **Step 3: Run the full suite**

Run: `cd packages/shared && npx tsdx test CombatAIAnalysis`
Expected: `Test Suites: 4 passed, 4 total` — the existing `[MATCH END] block` tests (`timeline.test.ts:4021+`) must stay green, proving the move is behavior-preserving.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/timelineHelpers.ts packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts
git commit -m "refactor(ai-analysis): extract buildMatchEndBlock from buildMatchTimeline

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### 7c — Extract `buildKillSequenceBlock`

- [ ] **Step 1: Add `buildKillSequenceBlock` to `timelineHelpers.ts`**

Move the KILL SEQUENCE block (from `// ── [KILL SEQUENCE] block (F113)` through its `outputLines.push(...)` calls) verbatim into a new exported function returning the lines to append (`[]` when the block produces nothing). Closure references become parameters/imports:

```ts
export function buildKillSequenceBlock(params: {
  matchStartMs: number;
  matchEndSeconds: number;
  owner: ICombatUnit;
  friends: ICombatUnit[];
  enemies: ICombatUnit[];
  ownerCDs: IMajorCooldownInfo[];
  teammateCDs: Array<{ player: ICombatUnit; spec: string; cds: IMajorCooldownInfo[] }>;
  enemyCDTimeline: IEnemyCDTimeline;
  ccTrinketSummaries: IPlayerCCTrinketSummary[];
  friendlyDeaths: Array<{ spec: string; name: string; atSeconds: number }>;
  enemyDeaths: Array<{ spec: string; name: string; atSeconds: number }>;
  isHealer: boolean;
  pid: (name: string) => string;
}): string[] {
  // ...verbatim KILL SEQUENCE logic; build the local outputLines array and return it...
}
```

It uses helpers already in this file (`getTopDamageSourcesInWindow`, `lastCastBefore`) plus `isHealerSpec`, `specToString` (import from `../../../utils/cooldowns`), `IEnemyCDTimeline` (import from `../../../utils/enemyCDs`), and `IPlayerCCTrinketSummary` (import from `../../../utils/ccTrinketAnalysis`). Replace `outputLines.push(...)` with pushes to a local `const lines: string[] = []` and `return lines`.

- [ ] **Step 2: Replace the block in `matchTimeline.ts` with a call**

Delete the inline KILL SEQUENCE block and replace with:

```ts
outputLines.push(
  ...buildKillSequenceBlock({
    matchStartMs,
    matchEndSeconds,
    owner,
    friends,
    enemies: enemies ?? [],
    ownerCDs,
    teammateCDs,
    enemyCDTimeline,
    ccTrinketSummaries,
    friendlyDeaths,
    enemyDeaths,
    isHealer,
    pid,
  }),
);
```

placed where the KILL SEQUENCE block was (before the MATCH END call). Add `buildKillSequenceBlock` to the `./timelineHelpers` import. Remove now-unused imports from `matchTimeline.ts` (`isHealerSpec`, `specToString`, `lastCastBefore`) **only if** grep confirms they are no longer referenced there.

- [ ] **Step 3: Run the full suite including the 7a characterization tests**

Run: `cd packages/shared && npx tsdx test CombatAIAnalysis`
Expected: `Test Suites: 4 passed, 4 total`, including both "KILL SEQUENCE" tests — proving the extraction preserved behavior.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/timelineHelpers.ts packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts
git commit -m "refactor(ai-analysis): extract buildKillSequenceBlock from buildMatchTimeline

Shrinks the buildMatchTimeline god function by ~180 lines across both block
extractions; behavior pinned by existing + new characterization tests.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the whole shared test suite, not just the AI-analysis subset**

Run: `cd packages/shared && npx tsdx test`
Expected: all suites pass (no regressions outside CombatAIAnalysis).

- [ ] **Confirm `buildMatchTimeline` shrank**

Run: `wc -l packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`
Expected: meaningfully below the 1097-line baseline (~900 or fewer).

---

## Self-Review (author checklist — completed)

- **Spec coverage:** P0 red tests → Task 1. P1 god function → Task 7. P1 F138 regression → Task 3. P1 HP-delta comment → Task 2. P1 hardcoded IDs → Task 4. P2 dead code → Task 5. P2 talent ms-heuristic comment → Task 6. All review findings mapped.
- **Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" steps; bug-fix and regression tasks carry concrete test/code; the two extraction tasks are verbatim moves with exact signatures and a test net, which is the correct discipline for a refactor in an existing file.
- **Type consistency:** `ccAvoidedInstances?` (Task 1) matches the `if (summary.ccAvoidedInstances)` guard. New constants in Task 4 (`CC_AVOIDANCE_BUFF_SPELLS`, `SWD_BREAKABLE_CC_SPELL_IDS`, `GROUNDING_TOTEM_SPELL_ID`, `SHADOW_WORD_DEATH_SPELL_ID`) are referenced by those exact names. Task 7 function names (`buildMatchEndBlock`, `buildKillSequenceBlock`) and their parameter objects match between the helper definition and the `matchTimeline.ts` call sites.

# Vector Rebuild — Data Foundation Implementation Plan (Plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/api/compare` trustworthy by rebuilding the metric layer and the comparison core so every comparative claim is server-computed over honest, full-cohort data — the low-risk 80% of the vector rebuild (spec §10 PRs 1–5).

**Architecture:** A single `metricRegistry` defines labels/valence once (consumed by prompt + UI). `healerMetrics` stops substituting the `1.5` latency sentinel and instead emits a burst-response *coverage* signal plus an honest latency over answered windows, each metric independently nullable. A new pure `verifiedComparison` core aggregates statistics over the *full* spec+bracket cohort (not 5 neighbors), with per-player diversification and disclosed sample sizes. A deterministic `claimChecker` rejects any model-emitted spell or number not in the verified data. A stats-led renderer narrates that object.

**Tech Stack:** TypeScript, Jest via `npx tsdx test` (run from `packages/shared`), Next.js API route (`packages/web`), existing parser types from `@wowarenalogs/parser`.

## Global Constraints

- Server computes every verifiable claim; renderers emit **no** number/percentage of their own.
- No metric may use a sentinel substitute; absent metrics are `null` and omitted, never faked.
- Per-metric null handling — **never** route through the all-or-nothing `metricsAvailable` gate (`vectorEmbedding.ts:127`).
- Cohort statistics are computed over the full spec+bracket cell; every stat discloses `nReal` (non-null count).
- Tests live in `packages/shared/src/utils/__tests__/` (or the `CombatAIAnalysis/__tests__/` dir for analysis modules); run with `npx tsdx test <file>` from `packages/shared`.
- Each task ends with a **real-result verification** step (spec §10) AND a code review before merge. No task merges on unit tests alone.
- All work happens in the `vector-rebuild` worktree.

---

### Task 1: Metric registry (single source of valence)

**Files:**
- Create: `packages/shared/src/components/CombatReport/CombatAIAnalysis/metricRegistry.ts`
- Test: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/metricRegistry.test.ts`

**Interfaces:**
- Produces:
  - `type MetricKey = 'offensiveIndex' | 'ccDensity' | 'responseLatencySec' | 'burstResponseCoverage' | 'defensiveOverlapRatio' | 'effectiveCastRatio' | 'ccAvoidanceRate'`
  - `interface MetricDef { key: MetricKey; label: string; definition: string; valence: 'higher' | 'lower' | 'context'; unit: string }`
  - `const METRIC_REGISTRY: Record<MetricKey, MetricDef>`

- [ ] **Step 1: Write the failing test**

```ts
// metricRegistry.test.ts
import { METRIC_REGISTRY, MetricKey } from '../metricRegistry';

const KEYS: MetricKey[] = [
  'offensiveIndex', 'ccDensity', 'responseLatencySec', 'burstResponseCoverage',
  'defensiveOverlapRatio', 'effectiveCastRatio', 'ccAvoidanceRate',
];

test('every metric has a non-empty label, definition, and valence', () => {
  for (const k of KEYS) {
    const d = METRIC_REGISTRY[k];
    expect(d).toBeDefined();
    expect(d.label.length).toBeGreaterThan(0);
    expect(d.definition.length).toBeGreaterThan(0);
    expect(['higher', 'lower', 'context']).toContain(d.valence);
  }
});

test('latency is relabeled, lower=better, and decoupled from teammate-HP framing', () => {
  const d = METRIC_REGISTRY.responseLatencySec;
  expect(d.label).toBe('Defensive Response Latency');
  expect(d.valence).toBe('lower');
  expect(d.definition.toLowerCase()).toContain('enemy');         // measures enemy-burst response
  expect(d.definition.toLowerCase()).not.toContain('<40%');      // not the teammate-HP crisis block
});

test('defensiveOverlap carries no baked-in panic verdict', () => {
  expect(METRIC_REGISTRY.defensiveOverlapRatio.definition.toLowerCase()).not.toContain('panic');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/shared`): `npx tsdx test metricRegistry -u`
Expected: FAIL — `Cannot find module '../metricRegistry'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// metricRegistry.ts
export type MetricKey =
  | 'offensiveIndex' | 'ccDensity' | 'responseLatencySec' | 'burstResponseCoverage'
  | 'defensiveOverlapRatio' | 'effectiveCastRatio' | 'ccAvoidanceRate';

export interface MetricDef {
  key: MetricKey;
  label: string;
  definition: string;
  valence: 'higher' | 'lower' | 'context';
  unit: string;
}

export const METRIC_REGISTRY: Record<MetricKey, MetricDef> = {
  offensiveIndex: { key: 'offensiveIndex', label: 'Offensive Index',
    definition: 'Damage output divided by healing+absorb output.', valence: 'higher', unit: '' },
  ccDensity: { key: 'ccDensity', label: 'CC Density',
    definition: 'Successful crowd-control casts per minute.', valence: 'higher', unit: '/m' },
  responseLatencySec: { key: 'responseLatencySec', label: 'Defensive Response Latency',
    definition: 'Seconds from an enemy burst window to your defensive-CD response (over windows you answered). Lower is faster.',
    valence: 'lower', unit: 's' },
  burstResponseCoverage: { key: 'burstResponseCoverage', label: 'Burst Response Coverage',
    definition: 'Fraction of enemy burst windows you answered with a defensive CD at all.',
    valence: 'higher', unit: '%' },
  defensiveOverlapRatio: { key: 'defensiveOverlapRatio', label: 'Defensive Overlap',
    definition: 'Fraction of your major defensives cast while a teammate defensive was already active.',
    valence: 'context', unit: '' },
  effectiveCastRatio: { key: 'effectiveCastRatio', label: 'Effective Cast Ratio',
    definition: 'Successful casts divided by successful casts plus interrupts taken.', valence: 'higher', unit: '' },
  ccAvoidanceRate: { key: 'ccAvoidanceRate', label: 'CC Avoidance Rate',
    definition: 'Fraction of incoming CC you avoided (Fade/LoS/Grounding/immunity).', valence: 'higher', unit: '' },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsdx test metricRegistry`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/metricRegistry.ts \
        packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/metricRegistry.test.ts
git commit -m "feat(vector): metric registry — single source of labels+valence (B123/B132/B134)"
```

---

### Task 2: Rebuild reactionLatency into coverage + honest latency; per-metric null

**Files:**
- Modify: `packages/shared/src/utils/healerMetrics.ts:24-49` (`computeCDResponseLatency`), `:51-58` (`IHealerMetrics`), `:101-102` (sentinel substitution)
- Modify: `packages/shared/src/utils/vectorEmbedding.ts:42,67-75` (drop sentinel handling; treat `null` latency as neutral 0)
- Modify (null-guard consumers, keep typecheck green): `packages/shared/src/utils/matchEmbeddingRecord.ts:76`, `packages/shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.ts:9,20`, `packages/shared/src/components/CombatReport/CombatAIAnalysis/proComparisonData.ts`
- Test: `packages/shared/src/utils/__tests__/healerMetrics.latency.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `function computeCDResponseLatency(annotatedCooldowns, burstWindows, matchStartMs): { latencyMsMedian: number | null; answered: number; windows: number }`
  - `IHealerMetrics` gains `burstResponseCoverage: { answered: number; windows: number }`; `reactionLatency: number | null` (median seconds over answered windows, **null** when none answered — never 1.5).

- [ ] **Step 1: Write the failing test** (pure-function, no log fixture needed)

```ts
// healerMetrics.latency.test.ts
import { computeCDResponseLatency } from '../healerMetrics';

const win = (fromSeconds: number, toSeconds: number) => ({ fromSeconds, toSeconds });
const cd = (timeSeconds: number, timingLabel: string) =>
  ({ casts: [{ timeSeconds, timingLabel }] } as any);

test('returns null latency + coverage 0/N when no defensive answers any window', () => {
  const r = computeCDResponseLatency([], [win(10, 12), win(40, 42)], 0);
  expect(r.latencyMsMedian).toBeNull();
  expect(r.answered).toBe(0);
  expect(r.windows).toBe(2);
});

test('measures latency only over answered windows and counts coverage', () => {
  // window starts at 10s; defensive cast at 12s (Reactive) -> 2000ms latency; window 40s unanswered
  const r = computeCDResponseLatency([cd(12, 'Reactive')], [win(10, 12), win(40, 42)], 0);
  expect(r.latencyMsMedian).toBe(2000);
  expect(r.answered).toBe(1);
  expect(r.windows).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsdx test healerMetrics.latency`
Expected: FAIL — `computeCDResponseLatency` returns a `number | null`, not an object (`r.answered` is undefined).

- [ ] **Step 3: Implement — change `computeCDResponseLatency` to return coverage + median**

Replace the body of `computeCDResponseLatency` (healerMetrics.ts:24-49) with:

```ts
function computeCDResponseLatency(
  annotatedCooldowns: IMajorCooldownInfo[],
  burstWindows: Array<{ fromSeconds: number; toSeconds: number }>,
  matchStartMs: number,
): { latencyMsMedian: number | null; answered: number; windows: number } {
  const answeredLatencies: Array<number | null> = burstWindows.map((w) => {
    const windowStartMs = w.fromSeconds * 1000 + matchStartMs;
    const windowEndMs = w.toSeconds * 1000 + matchStartMs;
    let best: number | null = null;
    for (const cd of annotatedCooldowns) {
      for (const cast of cd.casts) {
        if (cast.timingLabel !== 'Optimal' && cast.timingLabel !== 'Reactive') continue;
        const castMs = cast.timeSeconds * 1000 + matchStartMs;
        if (castMs >= windowStartMs && castMs <= windowEndMs + 8000) {
          const latency = castMs - windowStartMs;
          if (latency >= 0 && (best === null || latency < best)) best = latency;
        }
      }
    }
    return best;
  });
  const hit = answeredLatencies.filter((x): x is number => x !== null);
  return {
    latencyMsMedian: hit.length ? median(hit) : null,
    answered: hit.length,
    windows: burstWindows.length,
  };
}
```

Then update `computeHealerMetrics` (healerMetrics.ts:101-102) to:

```ts
  const lat = computeCDResponseLatency(annotated, enemyCDTimeline.alignedBurstWindows, combat.startTime);
  const reactionLatency = lat.latencyMsMedian !== null ? lat.latencyMsMedian / 1000 : null;
  const burstResponseCoverage = { answered: lat.answered, windows: lat.windows };
```

Update `IHealerMetrics` (healerMetrics.ts:51-58): change `reactionLatency: number;` to `reactionLatency: number | null;` and add `burstResponseCoverage: { answered: number; windows: number };`. Add both to the returned object (healerMetrics.ts:125-133).

- [ ] **Step 4: Keep all latency consumers compiling (null-safe, drop sentinel)**

In `vectorEmbedding.ts`: delete `const REACTION_LATENCY_SENTINEL = 1.5;` (line 42). In `generateMatchVector` (lines 67-75) change the latency z-score branch to treat `null` as neutral:

```ts
        data.reactionLatency === null
          ? 0
          : zScore(data.reactionLatency, np.reactionLatency.mean, np.reactionLatency.std),
```

In `buildReferenceModel` (line ~180) replace `if (data.reactionLatency !== REACTION_LATENCY_SENTINEL)` with `if (data.reactionLatency !== null)`. In `parseMatchEmbeddingData` (line 142) change the latency default from `1.5` to `null` and widen the `MatchEmbeddingData.reactionLatency` type to `number | null`.

Also keep the remaining latency consumers compiling against `number | null` (each is fully rewritten later — this is the minimal green-build guard so every task leaves the branch compiling):

- `matchEmbeddingRecord.ts`: widen `BuiltEmbeddingRecord.reactionLatency` (:76) to `number | null` (the `metrics.reactionLatency` assignment at :107 then type-checks).
- `comparativePrompt.ts`: widen `ComparativeAnalysisData.userMetrics.reactionLatency` (:9) and the neighbor `metrics.reactionLatency` (:20) to `number | null`; in `buildComparativePrompt` render the latency line as `data.userMetrics.reactionLatency === null ? 'n/a' : data.userMetrics.reactionLatency.toFixed(2) + 's'`, and compute `avgProLatency` over non-null neighbor latencies only (filter before sum/count).
- `proComparisonData.ts`: in `computeProAverages`, `buildMetricRows`, and `deriveArchetype`, coerce a null `reactionLatency` read with `?? NaN` and skip `NaN` from averages/rows so the file compiles and renders nothing fake.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx tsdx test healerMetrics.latency` → Expected: PASS (2 tests).
Run (from `packages/shared`): `npm run typecheck` → Expected: no errors.

- [ ] **Step 6: Real-result verification (spec §10 PR1 gate)**

Run the corpus latency recompute and confirm no `1.5` substitution remains in computed metrics:

```bash
cd scratch/healer-profile/dataset && node -e '
const fs=require("fs");let s=0,t=0;
for(let i=1;i<=20;i++){const f="compare-data/"+i+".json";if(!fs.existsSync(f))continue;
  const d=JSON.parse(fs.readFileSync(f));t++;if(d.userMetrics&&d.userMetrics.reactionLatency===1.5)s++;}
console.log("sample games",t,"with raw 1.5 sentinel (pre-rebuild baseline):",s);'
```

Record the before/after: after the regenerated pipeline runs (Task 3 rebuilds the index), a `null` must appear where the sentinel used to, and the other five metrics must stay numeric. Capture this in the PR description.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/utils/healerMetrics.ts packages/shared/src/utils/vectorEmbedding.ts \
        packages/shared/src/utils/__tests__/healerMetrics.latency.test.ts
git commit -m "fix(vector): rebuild reactionLatency as coverage+honest-latency, no 1.5 sentinel (B118)"
```

---

### Task 3: ccDensity coverage + locale canonicalization + provenance at index build

**Files:**
- Modify: `packages/shared/src/data/spells.json` (add missing CC spell ids)
- Modify: `packages/tools/src/buildHealerPlaystyleCorpus.ts` (canonicalize crisis-event spell names; re-download from GCS), `packages/tools/src/processAndUploadVectors.ts:72-91` (emit provenance string instead of bare rating)
- Test: `packages/shared/src/utils/__tests__/ccCoverage.test.ts`, `packages/shared/src/utils/__tests__/englishSpellName.test.ts`
- Create: `packages/shared/src/utils/englishSpellName.ts`
- Modify: `packages/shared/src/utils/matchEmbeddingRecord.ts` (`extractRotations` — emit English names by spellId)

**Interfaces:**
- Produces: `function englishSpellName(spellId: string | number, fallback?: string): string` — maps a spellId to its English name via `data/spellNames.json`; returns `fallback` when the id is unknown. Canonicalization happens by **spellId at extraction time** (`extractRotations`), not by localized-string lookup (no localized→English source exists).
- Consumes: `ccSpellIds` (Set<string>) from `data/spellTags`.

- [ ] **Step 1: Write the failing CC-coverage test**

First confirm the gap (data lookup, not logic): `grep '"192058"' packages/shared/src/data/spells.json` (Capacitor Totem). Then:

```ts
// ccCoverage.test.ts
import { ccSpellIds } from '../../data/spellTags';
test('ccSpellIds covers totem/stun CC that read as 0 in the meta-eval', () => {
  expect(ccSpellIds.has('192058')).toBe(true); // Capacitor Totem
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsdx test ccCoverage` → Expected: FAIL (id absent).

- [ ] **Step 3: Add the missing id(s)**

Add to `spells.json`: `"192058": { "type": "cc" }` (and any other ids confirmed absent in Step 1 from the meta-eval list, e.g. Capacitor Totem). Re-run `npx tsdx test ccCoverage` → PASS.

- [ ] **Step 4: Write the failing spellId→English test**

First confirm a known id (data lookup): `node -e 'console.log(require("./packages/shared/src/data/spellNames.json")["2061"])'` — expect `Flash Heal`. Then:

```ts
// englishSpellName.test.ts
import { englishSpellName } from '../englishSpellName';
test('maps a spellId to its English name', () => {
  expect(englishSpellName('2061')).toBe('Flash Heal'); // id confirmed in Step 4
});
test('falls back to the provided name when the id is unknown', () => {
  expect(englishSpellName('999999999', 'Réversion')).toBe('Réversion');
});
```

- [ ] **Step 5: Implement `englishSpellName` and canonicalize at extraction**

```ts
// englishSpellName.ts
import spellNames from '../data/spellNames.json';
const names = spellNames as Record<string, string>;
export function englishSpellName(spellId: string | number, fallback = ''): string {
  return names[String(spellId)] ?? fallback;
}
```

Then fix B121 at the source in `matchEmbeddingRecord.ts` `extractRotations`: the `casts` objects already carry `spellId` and `name`. Replace each use of the localized `c.name` in the `coreSequences` chain string and in the `crisisEvents` response list with `englishSpellName(c.spellId, c.name)`, so the stored crisis strings are English regardless of the pro's client locale. Re-run `npx tsdx test englishSpellName` → PASS, then `npm run typecheck`.

- [ ] **Step 6: Provenance string in the index**

In `processAndUploadVectors.ts:72-91`, replace `rating: matchData.rating ?? null` with `leaderboardSelection: '2300+ leaderboard selection'` (a provenance string; do **not** imply a per-record MMR). Keep `playerName`.

- [ ] **Step 7: Real-result verification (spec §10 PR2 gate)**

```bash
# after rebuilding the index for one spec dir:
node -e 'const a=require("./packages/tools/src/data/reference_vectors.json");
const bad=a.filter(r=>(r.crisisEvents||[]).some(s=>/[^\x00-\x7F]/.test(s)));
console.log("records with non-English crisis names:",bad.length,"(target 0)");'
```

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/data/spells.json packages/shared/src/utils/englishSpellName.ts \
        packages/shared/src/utils/__tests__/ccCoverage.test.ts \
        packages/shared/src/utils/__tests__/englishSpellName.test.ts \
        packages/shared/src/utils/matchEmbeddingRecord.ts \
        packages/tools/src/buildHealerPlaystyleCorpus.ts packages/tools/src/processAndUploadVectors.ts
git commit -m "fix(vector): ccDensity CC coverage + locale canonicalization + provenance (B121/B122/F157)"
```

---

### Task 4: VerifiedComparison core (full-cohort stats + diversification)

**Files:**
- Create: `packages/shared/src/components/CombatReport/CombatAIAnalysis/verifiedComparison.ts`
- Test: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/verifiedComparison.test.ts`

**Interfaces:**
- Consumes: `MetricKey` (Task 1); `ReferenceVectorRecord` (from `utils/vectorSearch`).
- Produces:
  - `interface CohortStat { mean: number; median: number; p25: number; p75: number; userPercentile: number | null; nReal: number }`
  - `interface VerifiedComparison { player; spec; bracket; cohort: { n; uniquePlayers; leaderboardSelection; perMetric: Partial<Record<MetricKey, CohortStat>> }; notes: string[] }`
  - `function buildVerifiedComparison(cellRecords: ReferenceVectorRecord[], userMetrics: Partial<Record<MetricKey, number | null>>, ctx: { player; spec; bracket }): VerifiedComparison`
  - `function diversifyByPlayer<T extends { playerName: string }>(records: T[], capPerPlayer: number): T[]`

- [ ] **Step 1: Write the failing tests**

```ts
// verifiedComparison.test.ts
import { buildVerifiedComparison, diversifyByPlayer } from '../verifiedComparison';

const rec = (playerName: string, offensiveIndex: number | null, reactionLatency: number | null) =>
  ({ playerName, metrics: { offensiveIndex, ccDensity: 1, reactionLatency,
     defensiveOverlapRatio: 0, effectiveCastRatio: 1, ccAvoidanceRate: 0 } } as any);

test('cohort stats exclude nulls and disclose nReal', () => {
  const cell = [rec('A', 0.1, null), rec('B', 0.2, 5), rec('C', 0.3, 7)];
  const vc = buildVerifiedComparison(cell, { offensiveIndex: 0.25, responseLatencySec: 6 },
    { player: 'Me', spec: 'Discipline Priest', bracket: '3v3' });
  expect(vc.cohort.perMetric.offensiveIndex!.nReal).toBe(3);
  expect(vc.cohort.perMetric.responseLatencySec!.nReal).toBe(2);      // A's null excluded
  expect(vc.cohort.n).toBe(3);
  expect(vc.cohort.uniquePlayers).toBe(3);
});

test('a null in one metric never nulls the others (the metricsAvailable trap)', () => {
  const cell = [rec('A', 0.1, null), rec('B', 0.2, null)];
  const vc = buildVerifiedComparison(cell, { offensiveIndex: 0.15 },
    { player: 'Me', spec: 'Discipline Priest', bracket: '3v3' });
  expect(vc.cohort.perMetric.offensiveIndex!.nReal).toBe(2);          // survives
  expect(vc.cohort.perMetric.responseLatencySec).toBeUndefined();     // all null -> omitted
});

test('thin cohort emits a note and no percentile', () => {
  const cell = [rec('A', 0.1, 5)];
  const vc = buildVerifiedComparison(cell, { offensiveIndex: 0.2 },
    { player: 'Me', spec: 'Holy Priest', bracket: 'solo_shuffle' });
  expect(vc.notes.some((n) => n.toLowerCase().includes('thin'))).toBe(true);
});

test('diversifyByPlayer caps rounds-per-player', () => {
  const r = diversifyByPlayer(
    [{ playerName: 'A' }, { playerName: 'A' }, { playerName: 'A' }, { playerName: 'B' }], 1);
  expect(r.filter((x) => x.playerName === 'A').length).toBe(1);
  expect(r.length).toBe(2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsdx test verifiedComparison` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement the core**

```ts
// verifiedComparison.ts
import { MetricKey } from './metricRegistry';
import { ReferenceVectorRecord } from '../../../utils/vectorSearch';

export interface CohortStat { mean: number; median: number; p25: number; p75: number; userPercentile: number | null; nReal: number; }
export interface VerifiedComparison {
  player: string; spec: string; bracket: string;
  cohort: { n: number; uniquePlayers: number; leaderboardSelection: string; perMetric: Partial<Record<MetricKey, CohortStat>>; };
  notes: string[];
}
const THIN = 8;
// Maps a stored record's metrics block onto registry keys (note: record stores legacy `reactionLatency`).
const RECORD_KEYS: Array<[MetricKey, (m: any) => number | null]> = [
  ['offensiveIndex', (m) => m?.offensiveIndex ?? null],
  ['ccDensity', (m) => m?.ccDensity ?? null],
  ['responseLatencySec', (m) => (m?.reactionLatency ?? null)],
  ['defensiveOverlapRatio', (m) => m?.defensiveOverlapRatio ?? null],
  ['effectiveCastRatio', (m) => m?.effectiveCastRatio ?? null],
  ['ccAvoidanceRate', (m) => m?.ccAvoidanceRate ?? null],
];
const pct = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

export function diversifyByPlayer<T extends { playerName: string }>(records: T[], capPerPlayer: number): T[] {
  const seen = new Map<string, number>();
  return records.filter((r) => {
    const c = seen.get(r.playerName) ?? 0;
    if (c >= capPerPlayer) return false;
    seen.set(r.playerName, c + 1);
    return true;
  });
}

export function buildVerifiedComparison(
  cellRecords: ReferenceVectorRecord[],
  userMetrics: Partial<Record<MetricKey, number | null>>,
  ctx: { player: string; spec: string; bracket: string },
): VerifiedComparison {
  const withMetrics = cellRecords.filter((r) => r.metrics != null);
  const uniquePlayers = new Set(withMetrics.map((r) => r.playerName)).size;
  const perMetric: Partial<Record<MetricKey, CohortStat>> = {};
  const notes: string[] = [];
  for (const [key, read] of RECORD_KEYS) {
    const vals = withMetrics.map((r) => read(r.metrics)).filter((v): v is number => typeof v === 'number');
    if (vals.length === 0) continue;                                    // all null -> omit (no fake)
    const sorted = [...vals].sort((a, b) => a - b);
    const uv = userMetrics[key];
    const userPercentile = typeof uv === 'number'
      ? sorted.filter((v) => v <= uv).length / sorted.length : null;
    perMetric[key] = { mean: mean(vals), median: median(vals), p25: pct(sorted, 0.25), p75: pct(sorted, 0.75), userPercentile, nReal: vals.length };
  }
  if (withMetrics.length < THIN) notes.push(`thin cohort (n=${withMetrics.length}) — percentiles are low-confidence`);
  return { player: ctx.player, spec: ctx.spec, bracket: ctx.bracket,
    cohort: { n: withMetrics.length, uniquePlayers, leaderboardSelection: '2300+ leaderboard selection', perMetric }, notes };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsdx test verifiedComparison` → Expected: PASS (4 tests).

- [ ] **Step 5: Real-result verification (spec §10 PR3 gate)**

Wire a throwaway script that loads the real index, filters one cell, and dumps a `VerifiedComparison` for ~5 of the user's games; confirm `nReal` is honest, `uniquePlayers` > 1, and no degenerate identical-neighbor pool exists. Paste the dump into the PR.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/verifiedComparison.ts \
        packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/verifiedComparison.test.ts
git commit -m "feat(vector): VerifiedComparison core — full-cohort stats, per-metric null, diversification (B119/B120/B133)"
```

---

### Task 5: Deterministic claim-checker

**Files:**
- Create: `packages/shared/src/components/CombatReport/CombatAIAnalysis/claimChecker.ts`
- Test: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/claimChecker.test.ts`

**Interfaces:**
- Consumes: `VerifiedComparison` (Task 4).
- Produces: `function checkClaims(draft: string, allow: { spells: string[]; numbers: number[] }): { ok: boolean; violations: string[] }` — flags any percentage/number not in `allow.numbers` and any capitalized spell-like token not in `allow.spells`.

- [ ] **Step 1: Write the failing test**

```ts
// claimChecker.test.ts
import { checkClaims } from '../claimChecker';
const allow = { spells: ['Penance', 'Power Word: Shield'], numbers: [9, 14] };

test('flags a fabricated percentage the server did not compute', () => {
  const r = checkClaims('In 80% of similar spots, pros used Penance.', allow);
  expect(r.ok).toBe(false);
  expect(r.violations.join(' ')).toContain('80');
});
test('passes a draft that only cites allowed numbers and spells', () => {
  const r = checkClaims('9 of 14 comparable pros opened with Penance.', allow);
  expect(r.ok).toBe(true);
});
test('flags a known spell the server did not provide', () => {
  // Apotheosis is a real spell in spellNames.json but not in the allowlist
  const r = checkClaims('In a similar spot pros used Apotheosis.', allow);
  expect(r.ok).toBe(false);
  expect(r.violations.join(' ')).toContain('Apotheosis');
});
test('allows an allowlisted spell', () => {
  expect(checkClaims('They cast Penance.', allow).ok).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsdx test claimChecker` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// claimChecker.ts
import spellNames from '../../../data/spellNames.json';

// Known English spell names — used so we only flag tokens we KNOW are spells (no false
// positives on ordinary prose). Case-sensitive whole-word match: spell names are Capitalized,
// coaching prose is lowercase, so "fade the totem" never matches the spell "Fade".
const KNOWN_SPELLS: string[] = Array.from(new Set(Object.values(spellNames as Record<string, string>))).filter(Boolean);

export function checkClaims(
  draft: string,
  allow: { spells: string[]; numbers: number[] },
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];

  // 1. Numbers: every number/percentage in the draft must be one the server computed.
  const allowedNums = new Set(allow.numbers.map((n) => Math.round(n * 100) / 100));
  for (const tok of draft.match(/\d+(?:\.\d+)?%?/g) ?? []) {
    const n = parseFloat(tok.replace('%', ''));
    if (!allowedNums.has(Math.round(n * 100) / 100)) violations.push(`uncited number: ${tok}`);
  }

  // 2. Spells: a KNOWN spell named in the draft that the server did not provide is a fabrication.
  const allowed = new Set(allow.spells);
  for (const spell of KNOWN_SPELLS) {
    if (allowed.has(spell)) continue;
    const re = new RegExp(`\\b${spell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(draft)) violations.push(`uncited spell: ${spell}`);
  }

  return { ok: violations.length === 0, violations };
}
```

If a common-word spell name produces a false positive in practice (e.g. "Echo" at a sentence start), add it to a small stopword exclusion — do not weaken the case-sensitive whole-word match.

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsdx test claimChecker` → Expected: PASS (4 tests).

- [ ] **Step 5: Real-result verification + Step 6 Commit**

Plant a fabricated `100%` into a sample rendered response and confirm `checkClaims` returns `ok:false` (record the recall). Then:

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/claimChecker.ts \
        packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/claimChecker.test.ts
git commit -m "feat(vector): deterministic claim-checker — rejects uncited numbers (replaces LLM judge)"
```

---

### Task 6: Stats-led renderer + wire `comparativePrompt` shim

**Files:**
- Create: `packages/shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.stats.ts`
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.ts` (thin shim over registry + VerifiedComparison)
- Modify: `packages/web/pages/api/compare.ts:57-101` (build `VerifiedComparison`, call stats renderer, run claim-checker)
- Test: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/comparativePrompt.stats.test.ts`

**Interfaces:**
- Consumes: `VerifiedComparison` (Task 4), `METRIC_REGISTRY` (Task 1).
- Produces: `function buildStatsLedPrompt(vc: VerifiedComparison): string` — emits only server-computed numbers, labels/valence from the registry, and the sample-size disclosure; instructs the model to narrate without inventing numbers.

- [ ] **Step 1: Write the failing test**

```ts
// comparativePrompt.stats.test.ts
import { buildStatsLedPrompt } from '../comparativePrompt.stats';
const vc: any = { player: 'Me', spec: 'Discipline Priest', bracket: '3v3',
  cohort: { n: 24, uniquePlayers: 20, leaderboardSelection: '2300+ leaderboard selection',
    perMetric: { responseLatencySec: { mean: 9.2, median: 7.8, p25: 5, p75: 12, userPercentile: 0.6, nReal: 14 } } },
  notes: ['thin cohort (n=5) — percentiles are low-confidence'] };

test('prompt uses the registry label, discloses sample size, and never says panic', () => {
  const p = buildStatsLedPrompt(vc);
  expect(p).toContain('Defensive Response Latency');     // registry label, not "Crisis Reaction Latency"
  expect(p).toContain('n=14');                            // nReal disclosed
  expect(p.toLowerCase()).toContain('do not invent');    // narrate-only contract
  expect(p.toLowerCase()).not.toContain('panic');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsdx test comparativePrompt.stats` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement the stats-led renderer**

```ts
// comparativePrompt.stats.ts
import { METRIC_REGISTRY, MetricKey } from './metricRegistry';
import { VerifiedComparison } from './verifiedComparison';

export function buildStatsLedPrompt(vc: VerifiedComparison): string {
  const lines: string[] = [];
  for (const key of Object.keys(vc.cohort.perMetric) as MetricKey[]) {
    const def = METRIC_REGISTRY[key];
    const s = vc.cohort.perMetric[key]!;
    lines.push(`- ${def.label} (${def.definition} ${def.valence === 'lower' ? 'lower=better' : def.valence === 'higher' ? 'higher=better' : 'context-dependent'}): cohort median ${s.median.toFixed(2)}${def.unit} (n=${s.nReal}); your percentile ${s.userPercentile === null ? 'n/a' : Math.round(s.userPercentile * 100) + 'th'}`);
  }
  return `You are a WoW arena coach comparing ${vc.player} (${vc.spec}, ${vc.bracket}) to a cohort of ${vc.cohort.uniquePlayers} ${vc.cohort.leaderboardSelection} players.

### Verified standing (server-computed — DO NOT INVENT or alter any number):
${lines.join('\n')}

### Notes: ${vc.notes.join('; ') || 'none'}

### Task:
Narrate the player's standing and the single highest-value adjustment. Use ONLY the numbers above. Do not state any percentage or count not present here. Output Markdown with a "Global Pacing" header.`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsdx test comparativePrompt.stats` → Expected: PASS.

- [ ] **Step 5: Wire `api/compare.ts`**

In `buildComparison` (compare.ts:57-101): after computing `raw`/metrics and loading the cell records, replace the `nearestNeighbors`/`ComparativeAnalysisData` block with `buildVerifiedComparison(cellRecords, userMetrics, ctx)`; pass it to `buildStatsLedPrompt`; after the model returns, run `checkClaims(report, { spells: [...], numbers: collectServerNumbers(vc) })` and drop the report if `!ok`. (`comparativePrompt.ts` becomes a re-export shim selecting the variant.)

- [ ] **Step 6: Real-result verification (spec §10 PR5 gate)**

Run `buildUserCompareCorpus --variant stats` over ~20 games; spot-check that prompts contain registry labels, `n=` disclosures, and no fabricated numbers; score the sample with the compare rubric and record metricValidityFlag/hallucination vs the 59%/30% baseline.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.stats.ts \
        packages/shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.ts \
        packages/web/pages/api/compare.ts \
        packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/comparativePrompt.stats.test.ts
git commit -m "feat(vector): stats-led renderer over VerifiedComparison + claim-check in /api/compare"
```

---

## Self-review notes (spec coverage)

- B118 → Task 2 (+registry label Task 1). B119/B120/B133 → Task 4. B121 → Task 3. B122 → Task 3. B123/B132/B134 → Task 1 (+renderer Task 6). F157 → Task 3 (relabel to provenance). `metricsAvailable` trap → Task 4 test ("a null in one metric never nulls the others"). Deterministic checker (replaces LLM judge) → Task 5. Stats-led variant → Task 6.
- **Deferred to Plan B (after the PR6 coverage study):** per-crisis situational exemplar index, exemplar-led renderer, full 374-game A/B, anti-Goodhart independent gate, and the UI (`ProComparison`) rewire. These cannot be detailed until the coverage study defines the situational matcher.
- Open confirmations folded into task steps (not placeholders): exact missing CC spell ids (Task 3 Step 1), `spellNames.json` shape (Task 3 Step 5), and the precise `cellRecords` loader signature in `api/compare.ts` (Task 6 Step 5).

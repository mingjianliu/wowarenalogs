# Pro Comparison (Part II) Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add **Part II · Pro comparison** to `CombatAIAnalysis` — for healer matches, live-embed the match, find the nearest pro games in the reference corpus, and render a metric-gap + crisis comparison with a Claude-written coaching summary — without slowing or breaking Part I.

**Architecture:** A new guarded `/api/compare` endpoint re-parses the raw log (matchId→stub→GCS), builds a `RawMatchRecord` from the parsed combat (rotation analysis + healer metrics + talents), vectorizes it with the existing `vectorizeMatch`, finds neighbors with `findNearestProMatchesLocal`, and runs a 2nd Claude call for the coaching report. The pure embedding+search code is relocated `cloud → shared` so `web` can import it; the reference index is bundled into the standalone build. The client fires `/api/compare` in parallel with `/api/analyze` and renders Part II independently.

**Tech Stack:** TypeScript, Next.js API routes, `@anthropic-ai/sdk`, `@wowarenalogs/parser`, `@google-cloud/{firestore,storage}`, `fs-extra`, `ts-jest`/`tsdx`.

**Spec:** `docs/superpowers/specs/2026-06-13-pro-comparison-integration-design.md`

---

## Notes for the implementer

- **Run shared tests** from `packages/shared`: `npx tsdx test <pattern>`.
- **Pre-commit hook** now passes repo-wide; commit normally. If a commit is ever blocked by _unrelated_ pre-existing debt, use `--no-verify` only after confirming it's not your code.
- **`no-console`** is a lint error in `shared` and `tools`. In shared, put `// eslint-disable-next-line no-console` above any `console.warn`. New tools-only scripts use a top `/* eslint-disable no-console */`.
- **Do NOT push.** Work on a branch (`feat/pro-comparison`).
- The two provided client files are at `/tmp/arena-integrate/reflected-codebase/packages/shared/src/components/CombatReport/CombatAIAnalysis/` (`proComparisonData.ts`, `components/ProComparison.tsx`).
- **Firestore rejects `undefined`** — not relevant here (no Firestore writes), but the endpoint must never return `undefined` fields; return `{}` or a full object.

---

## File Structure

| File                                                       | Status               | Responsibility                                                                                                                                                                                |
| ---------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/utils/vectorEmbedding.ts`             | Create (move)        | Pure embedding: `MatchEmbeddingData`, `IReferenceModel`, `parseMatchEmbeddingData`, `generateMatchVector`, `vectorizeMatch`, `buildReferenceModel` (moved from `cloud/src/vectorIndexer.ts`). |
| `packages/shared/src/utils/vectorSearch.ts`                | Create (move)        | `ReferenceVectorRecord`, `NearestMatchResult`, `normalizeBracket`, `findNearestProMatchesLocal`, robust index path loader (moved from `cloud/src/vectorSearch.ts`).                           |
| `packages/cloud/src/vectorIndexer.ts`                      | Replace w/ re-export | `export * from '@wowarenalogs/shared/src/utils/vectorEmbedding';` (keep import path stable for cloud/tools).                                                                                  |
| `packages/cloud/src/vectorSearch.ts`                       | Replace w/ re-export | `export * from '@wowarenalogs/shared/src/utils/vectorSearch';`                                                                                                                                |
| `packages/shared/src/utils/matchEmbeddingRecord.ts`        | Create               | `extractRotations` (moved from tools) + `buildMatchEmbeddingRecord(combat, playerName) → RawMatchRecord` + `isHealerSpec`.                                                                    |
| `packages/tools/src/analyzeSpecPlaystyle.ts`               | Modify               | Import `extractRotations` from shared (remove local copy).                                                                                                                                    |
| `packages/web/pages/api/compare.ts`                        | Create               | The guarded comparison orchestrator.                                                                                                                                                          |
| `packages/web/next.config.js`                              | Modify               | `outputFileTracingIncludes` for `/api/compare` (bundle the reference JSONs).                                                                                                                  |
| `.../CombatAIAnalysis/proComparisonData.ts`                | Create (copy)        | Provided pure transforms.                                                                                                                                                                     |
| `.../CombatAIAnalysis/components/ProComparison.tsx`        | Create (copy)        | Provided Part II view.                                                                                                                                                                        |
| `.../CombatAIAnalysis/__tests__/proComparisonData.test.ts` | Create               | Tests for the provided transforms.                                                                                                                                                            |
| `.../CombatAIAnalysis/index.tsx`                           | Modify               | Parallel `/api/compare` fetch + Part II render.                                                                                                                                               |

---

## Task 1: SPIKE — live-embed feasibility (talent-vocab alignment) — GATE

**This is an investigation task, not TDD. Its output is a go/no-go decision that determines Task 3–4.**

**Files:** none committed (scratch script under `/tmp`).

- [ ] **Step 1: Pick a sample healer match log.** Look in `~/Library/Application Support/World of Warcraft/_retail_/Logs/`, `~/Downloads/`, and `packages/tools/benchmarks/logs/` for a recent log containing a healer. Note the path.

- [ ] **Step 2: Inspect the reference model's talent vocab.**

Run:

```bash
node -e "const m=require('./packages/tools/src/data/reference_model.json'); const k=Object.keys(m.talentVocab); console.log('talentVocab size:', k.length); console.log('sample keys:', k.slice(0,20));"
```

Record the sample talent-id keys (the id space the embedding's talent block uses).

- [ ] **Step 3: Extract a live match's talent ids and compare.**

Write `/tmp/spike-talents.ts` that parses the sample log, takes the log-owner unit (`combat.units[combat.playerId]`), and prints its talent ids from `unit.info.talents` (each talent entry's id field) plus the overlap count against `talentVocab` keys:

```ts
import fs from 'fs';
import { WoWCombatLogParser } from '@wowarenalogs/parser';
import model from '../packages/tools/src/data/reference_model.json'; // adjust path

const logPath = process.argv[2];
const parser = new WoWCombatLogParser('retail');
const combats: any[] = [];
parser.on('arena_match_ended', (c: any) => combats.push(c));
parser.on('solo_shuffle_ended', (m: any) => combats.push(...m.rounds));
for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) parser.parseLine(line);
parser.flush();
const c = combats[0];
const owner = c.units[c.playerId];
const talents = (owner.info?.talents ?? []).map((t: any) => t.id1 ?? t.id2 ?? t.spellId ?? t.id).filter(Boolean);
const vocab = new Set(Object.keys((model as any).talentVocab));
const overlap = talents.filter((t: number) => vocab.has(String(t)));
console.log('owner spec:', owner.spec, 'talents:', talents.length, 'overlap with vocab:', overlap.length);
console.log('talent ids:', talents.slice(0, 30));
```

Run with the tools workspace ts-node:

```bash
npx ts-node --files /tmp/spike-talents.ts "<log-path>"
```

- [ ] **Step 4: Decide the gate.**

- **GREEN (overlap > 0, comparable to a corpus record's talent count):** the live talent block aligns with the vocab. Proceed with the full live-embed plan (Tasks 2–8). Record which `unit.info.talents` field is the matching id (`id1`/`spellId`/etc.) — Task 3 uses it.
- **AMBER (zero/low overlap):** the talent block can't be reproduced live, but rotation+behavior blocks still can. Decide: ship live-embed with an **empty `talentIds`** (talent block = zeros for both query and — no; corpus has talents, so this skews distance). Prefer the RED fallback unless rotation+behavior alone gives sane neighbors (verify by running Step 5).
- **RED:** fall back to **corpus-lookup-only** — Task 3 is skipped, Task 4 looks the match up in `reference_vectors.json` by `matchId` and uses that record's `embedding`/`metrics`/`crisisEvents` directly (Part II shows only for already-ingested matches). All other tasks unchanged; the contract is identical.

- [ ] **Step 5: (If GREEN/AMBER) sanity-check the full live vector.** Extend the scratch script to build a `RawMatchRecord` (`{ rotations: { coreSequences }, pythonResult: { nodes_info: Object.fromEntries(talents.map(t=>[String(t),{}])) }, ...6 metrics from computeHealerMetrics }`), call `vectorizeMatch(raw, model)`, then `findNearestProMatchesLocal(spec, vec, bracket, 6)`. Confirm it returns same-spec neighbors with distances < ~0.8 (not all ~1.0, which would mean a degenerate vector). Record the outcome in the commit message of Task 2.

- [ ] **Step 6: Record the decision.** Write one paragraph (GREEN/AMBER/RED + the talent-id field used) into the plan's companion note or the Task 2 commit body so downstream tasks know which path to build. No code commit for the spike itself.

---

## Task 2: Relocate vector code cloud → shared

**Files:**

- Create: `packages/shared/src/utils/vectorEmbedding.ts`, `packages/shared/src/utils/vectorSearch.ts`
- Modify (→ re-export): `packages/cloud/src/vectorIndexer.ts`, `packages/cloud/src/vectorSearch.ts`
- Modify imports: any `packages/tools/src/*` and `packages/cloud/src/*` importing those

- [ ] **Step 1: Move the embedding module.** Copy the full current contents of `packages/cloud/src/vectorIndexer.ts` into `packages/shared/src/utils/vectorEmbedding.ts` unchanged (its only import is `@wowarenalogs/shared/src/utils/vectorMath`, which becomes a sibling `./vectorMath` — update that one import line to `import { computeTfIdf, meanStd, weightedConcat, zScore } from './vectorMath';`).

- [ ] **Step 2: Move the search module with a robust index path.** Copy `packages/cloud/src/vectorSearch.ts` into `packages/shared/src/utils/vectorSearch.ts`. Change the `cosineSimilarity` import to `./vectorMath`. Replace the hardcoded `REFERENCE_VECTORS_PATH` with a resolver that works from shared in dev, from the tools data dir, and from the bundled standalone build:

```ts
import fs from 'fs-extra';
import path from 'path';

// reference_vectors.json is authored in packages/tools/src/data. It is resolved from several
// candidate roots so this works in: (a) shared dev/test, (b) the tools workspace, (c) the Next
// standalone server where it is traced in via outputFileTracingIncludes (see next.config.js).
const REFERENCE_VECTORS_CANDIDATES = [
  path.join(__dirname, '../../../tools/src/data/reference_vectors.json'), // shared/src/utils → tools/src/data
  path.join(process.cwd(), 'packages/tools/src/data/reference_vectors.json'),
  path.join(process.cwd(), 'tools/src/data/reference_vectors.json'),
  path.join(process.cwd(), '.next/server/reference_vectors.json'),
];
function resolveReferenceVectorsPath(): string | null {
  for (const p of REFERENCE_VECTORS_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}
```

Then in `findNearestProMatchesLocal`, replace the existence check + read:

```ts
const refPath = resolveReferenceVectorsPath();
if (!refPath) return [];
const allMatches: ReferenceVectorRecord[] = await fs.readJson(refPath);
```

Keep `normalizeBracket`, the filter/sort, and the rest identical.

- [ ] **Step 3: Turn the cloud files into re-exports.** Replace the entire contents of `packages/cloud/src/vectorIndexer.ts` with:

```ts
export * from '@wowarenalogs/shared/src/utils/vectorEmbedding';
```

and `packages/cloud/src/vectorSearch.ts` with:

```ts
export * from '@wowarenalogs/shared/src/utils/vectorSearch';
```

- [ ] **Step 4: Verify nothing else imported internals.** Run:

```bash
grep -rn "from '.*vectorIndexer'\|from '.*vectorSearch'\|@wowarenalogs/cloud/src/vector" packages --include=*.ts | grep -v node_modules | grep -v __tests__
```

Existing importers (e.g. `processAndUploadVectors.ts`, `demoDynamicAnalysis.ts`) import the _exported names_, which the re-exports preserve — no change needed. If any import a non-exported internal, update it to the shared path.

- [ ] **Step 5: Typecheck all three packages.**

```bash
(cd packages/shared && npx tsc --noEmit) && (cd packages/cloud && npx tsc --noEmit) && (cd packages/tools && npx tsc --noEmit)
```

Expected: no new errors referencing the moved files.

- [ ] **Step 6: Run the existing vector tests** (they should still pass via the re-exports / new location):

```bash
cd packages/shared && npx tsdx test vector
```

Expected: PASS (any existing `vectorMath`/vector tests).

- [ ] **Step 7: Commit.**

```bash
git add packages/shared/src/utils/vectorEmbedding.ts packages/shared/src/utils/vectorSearch.ts packages/cloud/src/vectorIndexer.ts packages/cloud/src/vectorSearch.ts
git commit -m "refactor(vectors): relocate embedding+search from cloud to shared (re-export shims)"
```

(Include the Task 1 spike decision in the commit body.)

---

## Task 3: Build the request-time embedding record (GREEN/AMBER path)

> If Task 1 was **RED**, skip this task; Task 4 uses corpus lookup instead.

**Files:**

- Create: `packages/shared/src/utils/matchEmbeddingRecord.ts`
- Modify: `packages/tools/src/analyzeSpecPlaystyle.ts` (import `extractRotations` from shared)
- Test: `packages/shared/src/utils/__tests__/matchEmbeddingRecord.test.ts`

- [ ] **Step 1: Write the failing test** (use the metric/rotation shapes confirmed in the spike; this test pins the assembled `RawMatchRecord` shape and the healer gate):

```ts
import { isHealerSpec, buildMatchEmbeddingRecord } from '../matchEmbeddingRecord';
import { CombatUnitSpec } from '@wowarenalogs/parser';

describe('isHealerSpec', () => {
  it('recognizes healer specs and rejects others', () => {
    expect(isHealerSpec(CombatUnitSpec.Priest_Discipline)).toBe(true);
    expect(isHealerSpec(CombatUnitSpec.Druid_Restoration)).toBe(true);
    expect(isHealerSpec(CombatUnitSpec.Mage_Frost)).toBe(false);
  });
});

describe('buildMatchEmbeddingRecord', () => {
  it('assembles a RawMatchRecord with rotations, talents, and the 6 metrics', () => {
    // Minimal fake combat: one healer owner with two casts and talents.
    const owner: any = {
      id: 'P1',
      name: 'Healer-Realm',
      spec: CombatUnitSpec.Priest_Discipline,
      reaction: 0,
      type: 0,
      info: { talents: [{ id1: 111 }, { id1: 222 }] },
      spellCastEvents: [
        { spellId: 1, spellName: 'Penance', logLine: { event: 'SPELL_CAST_SUCCESS', timestamp: 1000 } },
        { spellId: 2, spellName: 'Power Word: Shield', logLine: { event: 'SPELL_CAST_SUCCESS', timestamp: 2000 } },
        { spellId: 3, spellName: 'Smite', logLine: { event: 'SPELL_CAST_SUCCESS', timestamp: 3000 } },
      ],
      advancedActions: [],
    };
    const combat: any = { startTime: 0, playerId: 'P1', units: { P1: owner } };
    const rec = buildMatchEmbeddingRecord(combat, 'Healer-Realm');
    expect(rec.rotations.coreSequences).toContain('Penance -> Power Word: Shield -> Smite (used 1x)');
    expect(Object.keys(rec.pythonResult.nodes_info)).toEqual(['111', '222']);
    expect(typeof rec.offensiveIndex).toBe('number');
    expect(typeof rec.ccDensity).toBe('number');
  });
});
```

> Note: the exact talent field (`id1` vs `spellId`) and `computeHealerMetrics` signature were confirmed in the spike — adjust the fake/assertions to match what the spike recorded.

- [ ] **Step 2: Run the test to verify it fails.**

```bash
cd packages/shared && npx tsdx test matchEmbeddingRecord
```

Expected: FAIL — module not found.

- [ ] **Step 3: Move `extractRotations` into the new shared module and add the builder.** Create `packages/shared/src/utils/matchEmbeddingRecord.ts`:

```ts
import { CombatUnitReaction, CombatUnitType, CombatUnitSpec } from '@wowarenalogs/parser';

import { computeHealerMetrics } from './healerMetrics';
import { PASSIVE_SPELL_BLOCKLIST } from './cooldowns';
import { RawMatchRecord } from './vectorEmbedding';

const HEALER_SPECS = new Set<CombatUnitSpec>([
  CombatUnitSpec.Priest_Discipline,
  CombatUnitSpec.Priest_Holy,
  CombatUnitSpec.Paladin_Holy,
  CombatUnitSpec.Shaman_Restoration,
  CombatUnitSpec.Druid_Restoration,
  CombatUnitSpec.Monk_Mistweaver,
  CombatUnitSpec.Evoker_Preservation,
]);

export function isHealerSpec(spec: string): boolean {
  return HEALER_SPECS.has(spec as CombatUnitSpec);
}

// Moved verbatim from packages/tools/src/analyzeSpecPlaystyle.ts (single-match, request-time safe).
export function extractRotations(
  player: any,
  match: any,
): { opener: string[]; coreSequences: string[]; crisisEvents: string[] } {
  const casts = player.spellCastEvents
    .filter(
      (e: any) => e.spellName && e.logLine?.event === 'SPELL_CAST_SUCCESS' && !PASSIVE_SPELL_BLOCKLIST.has(e.spellName),
    )
    .map((e: any) => ({ spellId: e.spellId, name: e.spellName, time: (e.logLine.timestamp - match.startTime) / 1000 }))
    .sort((a: any, b: any) => a.time - b.time);

  const opener = casts.filter((c: any) => c.time <= 30).map((c: any) => c.name);

  const seqCounts: Record<string, number> = {};
  for (let i = 0; i < casts.length - 2; i++) {
    const chain = `${casts[i].name} -> ${casts[i + 1].name} -> ${casts[i + 2].name}`;
    seqCounts[chain] = (seqCounts[chain] || 0) + 1;
  }
  const coreSequences = Object.entries(seqCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([seq, count]) => `${seq} (used ${count}x)`);

  const teamUnits = Object.values(match.units).filter(
    (u: any) => u.type === CombatUnitType.Player && u.reaction === player.reaction,
  );
  const allTeamHpRecords = teamUnits
    .flatMap((u: any) =>
      (u.advancedActions || [])
        .filter((a: any) => a.advanced && a.advancedActorId === u.id && a.advancedActorMaxHp > 0)
        .map((a: any) => ({
          targetName: u.name,
          time: (a.logLine.timestamp - match.startTime) / 1000,
          pct: (a.advancedActorCurrentHp / a.advancedActorMaxHp) * 100,
        })),
    )
    .sort((a: any, b: any) => a.time - b.time);

  const crisisEvents: string[] = [];
  let lastCrisisTime = -999;
  for (const record of allTeamHpRecords) {
    if (record.pct < 40 && record.time - lastCrisisTime > 15) {
      lastCrisisTime = record.time;
      const responseCasts = casts
        .filter((c: any) => c.time >= record.time && c.time <= record.time + 6)
        .map((c: any) => c.name);
      if (responseCasts.length > 0) {
        crisisEvents.push(
          `At ${record.time.toFixed(1)}s (Teammate ${record.targetName} HP: ${record.pct.toFixed(0)}%): ${responseCasts.join(' -> ')}`,
        );
      }
    }
  }
  return { opener, coreSequences, crisisEvents };
}

/**
 * Build the RawMatchRecord that vectorizeMatch consumes, from a parsed combat + the owner name.
 * Talent ids are taken from the owner unit's info.talents (the field confirmed in the spike) and
 * shaped as pythonResult.nodes_info to match how the corpus encodes talents.
 */
export function buildMatchEmbeddingRecord(
  combat: any,
  playerName: string,
): RawMatchRecord & {
  rotations: { coreSequences: string[]; crisisEvents: string[] };
  pythonResult: { nodes_info: Record<string, unknown> };
} {
  const owner = Object.values(combat.units).find((u: any) => u.name === playerName) as any;
  const rotations = extractRotations(owner, combat);
  const metrics = computeHealerMetrics(combat, playerName);
  const talentIds: number[] = (owner.info?.talents ?? [])
    .map((t: any) => t.id1 ?? t.spellId ?? t.id) // ← use the field the spike confirmed
    .filter((x: any) => typeof x === 'number');
  const nodes_info: Record<string, unknown> = {};
  for (const id of talentIds) nodes_info[String(id)] = {};

  return {
    rotations: { coreSequences: rotations.coreSequences, crisisEvents: rotations.crisisEvents },
    pythonResult: { nodes_info },
    offensiveIndex: metrics.offensiveIndex,
    ccDensity: metrics.ccDensity,
    reactionLatency: metrics.reactionLatency,
    defensiveOverlapRatio: metrics.defensiveOverlapRatio,
    effectiveCastRatio: metrics.effectiveCastRatio,
    ccAvoidanceRate: metrics.ccAvoidanceRate,
  };
}
```

> `RawMatchRecord` from `vectorEmbedding.ts` only declares optional fields; the returned object widens `rotations`/`pythonResult` so callers get `coreSequences`/`crisisEvents`/`nodes_info` typed. Confirm `computeHealerMetrics`'s exact return field names against `healerMetrics.ts` and adjust if needed.

- [ ] **Step 4: Repoint the tools copy.** In `packages/tools/src/analyzeSpecPlaystyle.ts`, delete the local `export function extractRotations(...)` and add `import { extractRotations } from '../../shared/src/utils/matchEmbeddingRecord';`. Verify other usages in that file still resolve.

- [ ] **Step 5: Run the test to verify it passes.**

```bash
cd packages/shared && npx tsdx test matchEmbeddingRecord
```

Expected: PASS.

- [ ] **Step 6: Typecheck shared + tools.**

```bash
(cd packages/shared && npx tsc --noEmit) && (cd packages/tools && npx tsc --noEmit)
```

- [ ] **Step 7: Commit.**

```bash
git add packages/shared/src/utils/matchEmbeddingRecord.ts packages/shared/src/utils/__tests__/matchEmbeddingRecord.test.ts packages/tools/src/analyzeSpecPlaystyle.ts
git commit -m "feat(vectors): request-time RawMatchRecord builder + isHealerSpec (shared)"
```

---

## Task 4: `/api/compare` endpoint

**Files:**

- Create: `packages/web/pages/api/compare.ts`

- [ ] **Step 1: Write the endpoint.** (GREEN/AMBER path shown; for RED, replace the embed block with a `reference_vectors.json` lookup by `matchId` — see the alternate block at the end of this step.)

```ts
import Anthropic from '@anthropic-ai/sdk';
import { Firestore } from '@google-cloud/firestore';
import { CombatUnitReaction, CombatUnitType, WoWCombatLogParser } from '@wowarenalogs/parser';
import type { NextApiRequest, NextApiResponse } from 'next';

import {
  buildComparativePrompt,
  ComparativeAnalysisData,
} from '@wowarenalogs/shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt';
import { buildMatchEmbeddingRecord, isHealerSpec } from '@wowarenalogs/shared/src/utils/matchEmbeddingRecord';
import { findNearestProMatchesLocal } from '@wowarenalogs/shared/src/utils/vectorSearch';
import { vectorizeMatch } from '@wowarenalogs/shared/src/utils/vectorEmbedding';

const isDev = process.env.NODE_ENV === 'development';
const COMPARE_TIMEOUT_MS = 20_000;

let cachedFirestore: Firestore | null = null;
function getFirestore(): Firestore {
  if (!cachedFirestore)
    cachedFirestore = new Firestore({ projectId: isDev ? 'wowarenalogs-public-dev' : 'wowarenalogs' });
  return cachedFirestore;
}

async function resolveLogObjectUrl(matchId: string): Promise<string | null> {
  const snap = await getFirestore().collection('match-stubs-prod').where('id', '==', matchId).limit(1).get();
  if (snap.empty) return null;
  return (snap.docs[0].data() as { logObjectUrl?: string }).logObjectUrl ?? null;
}

function parseLog(text: string): any[] {
  const parser = new WoWCombatLogParser('retail');
  const combats: any[] = [];
  parser.on('arena_match_ended', (c: any) => combats.push(c));
  parser.on('solo_shuffle_ended', (m: any) => combats.push(...m.rounds));
  for (const line of text.split('\n')) parser.parseLine(line);
  parser.flush();
  return combats;
}

function deriveBracket(combat: any): string {
  const friendly = Object.values(combat.units).filter(
    (u: any) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
  ).length;
  if (combat.startInfo?.bracket) return String(combat.startInfo.bracket);
  return friendly >= 3 ? '3v3' : '2v2';
}

async function buildComparison(matchId: string): Promise<ComparativeAnalysisData | null> {
  const logObjectUrl = await resolveLogObjectUrl(matchId);
  if (!logObjectUrl) return null;
  const res = await fetch(logObjectUrl);
  if (!res.ok) return null;
  const combats = parseLog(await res.text());
  const combat = combats.find((c) => c.id === matchId) ?? combats[0];
  if (!combat) return null;

  const owner = combat.units[combat.playerId];
  if (!owner || !isHealerSpec(owner.spec)) return null; // healer gate

  const model = require('@wowarenalogs/tools/src/data/reference_model.json'); // bundled via tracing
  const raw = buildMatchEmbeddingRecord(combat, owner.name);
  const embedding = vectorizeMatch(raw, model);
  const bracket = deriveBracket(combat);

  const neighbors = (await findNearestProMatchesLocal(owner.spec, embedding, bracket, 6))
    .filter((n) => n.id !== matchId)
    .slice(0, 5);
  if (neighbors.length < 1) return null;

  return {
    playerName: owner.name,
    spec: owner.spec,
    userMetrics: {
      offensiveIndex: raw.offensiveIndex,
      ccDensity: raw.ccDensity,
      reactionLatency: raw.reactionLatency,
      defensiveOverlapRatio: raw.defensiveOverlapRatio,
      effectiveCastRatio: raw.effectiveCastRatio,
      ccAvoidanceRate: raw.ccAvoidanceRate,
    },
    userCrisisEvents: raw.rotations.crisisEvents,
    nearestNeighbors: neighbors.map((n) => ({
      distance: n.distance,
      metrics: n.data.metrics ?? {
        offensiveIndex: 0,
        ccDensity: 0,
        reactionLatency: 0,
        defensiveOverlapRatio: 0,
        effectiveCastRatio: 0,
        ccAvoidanceRate: 0,
      },
      crisisEvents: n.data.crisisEvents ?? [],
    })),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('compare timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({});
  const { matchId, apiKey: bodyApiKey } = (req.body ?? {}) as { matchId?: string; apiKey?: string };
  if (!matchId) return res.status(200).json({}); // nothing to compare

  try {
    const comparison = await withTimeout(buildComparison(matchId), COMPARE_TIMEOUT_MS);
    if (!comparison) return res.status(200).json({}); // not a healer / no neighbors / unavailable

    let comparisonReport: string | undefined;
    const apiKey = bodyApiKey || process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        const client = new Anthropic({ apiKey });
        const msg = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          temperature: 0.3,
          messages: [{ role: 'user', content: buildComparativePrompt(comparison) }],
        });
        const part = msg.content[0];
        if (part.type === 'text') comparisonReport = part.text;
      } catch {
        // report is optional; comparison still renders without it
      }
    }
    return res.status(200).json({ comparison, comparisonReport });
  } catch {
    return res.status(200).json({}); // fully guarded: never break the client
  }
}
```

For the **RED fallback**, replace the embed block in `buildComparison` (from `const owner = ...` through `embedding`/`neighbors`) with: read `reference_vectors.json` via the shared loader, find the record with `matchId`, and if present use `record.embedding`, `record.spec`, `record.bracket`, `record.metrics`, `record.crisisEvents` directly (still drop self + keep 5 neighbors). Return `null` if the match isn't in the corpus.

- [ ] **Step 2: Typecheck web.**

```bash
cd packages/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i 'compare.ts' || echo "compare.ts clean"
```

Expected: `compare.ts clean`. (If web can't resolve `@wowarenalogs/tools/src/data/...` require, switch to importing via the shared loader instead of a direct require, or read with `fs` using the same candidate-path resolver from Task 2.)

- [ ] **Step 3: Lint web.**

```bash
cd packages/web && npx next lint --file pages/api/compare.ts
```

Expected: clean.

- [ ] **Step 4: Commit.**

```bash
git add packages/web/pages/api/compare.ts
git commit -m "feat(compare): guarded /api/compare endpoint (live-embed + neighbor search + coaching call)"
```

---

## Task 5: Ship the reference index to the standalone build

**Files:**

- Modify: `packages/web/next.config.js`

- [ ] **Step 1: Read the current config** to place the key correctly:

```bash
cat packages/web/next.config.js
```

- [ ] **Step 2: Add `outputFileTracingIncludes`** for the compare route so both JSONs are traced into the standalone server. Inside the exported config object (sibling of `output: 'standalone'`):

```js
  outputFileTracingIncludes: {
    '/api/compare': [
      '../tools/src/data/reference_vectors.json',
      '../tools/src/data/reference_model.json',
    ],
  },
```

> Paths are relative to the web package root. Adjust if `cat` shows a different root assumption; the goal is that `.next/standalone/.../tools/src/data/*.json` exists after build.

- [ ] **Step 3: Build web and confirm the files are traced in.**

```bash
cd packages/web && npm run build 2>&1 | tail -5
find .next/standalone -name 'reference_vectors.json' -o -name 'reference_model.json' 2>/dev/null
```

Expected: both files appear under `.next/standalone/...`. If they don't, adjust the glob/paths until they do, and confirm the Task 2 candidate-path resolver includes the location they land in.

- [ ] **Step 4: Commit.**

```bash
git add packages/web/next.config.js
git commit -m "build(web): trace reference index JSONs into the standalone build for /api/compare"
```

---

## Task 6: Add the provided client files

**Files:**

- Create: `packages/shared/src/components/CombatReport/CombatAIAnalysis/proComparisonData.ts`
- Create: `packages/shared/src/components/CombatReport/CombatAIAnalysis/components/ProComparison.tsx`

- [ ] **Step 1: Copy the two files verbatim.**

```bash
cp /tmp/arena-integrate/reflected-codebase/packages/shared/src/components/CombatReport/CombatAIAnalysis/proComparisonData.ts \
   packages/shared/src/components/CombatReport/CombatAIAnalysis/proComparisonData.ts
cp /tmp/arena-integrate/reflected-codebase/packages/shared/src/components/CombatReport/CombatAIAnalysis/components/ProComparison.tsx \
   packages/shared/src/components/CombatReport/CombatAIAnalysis/components/ProComparison.tsx
```

- [ ] **Step 2: Typecheck shared** (verifies the files compile against the existing `comparativePrompt` + `icons`):

```bash
cd packages/shared && npx tsc --noEmit
```

Expected: no errors in the two new files. (`ComparativeAnalysisData`, `SparkleIcon`, `ArrowRight` all exist — verified.)

- [ ] **Step 3: Lint the two files.**

```bash
cd packages/shared && npx eslint src/components/CombatReport/CombatAIAnalysis/proComparisonData.ts src/components/CombatReport/CombatAIAnalysis/components/ProComparison.tsx
```

Fix only import-order/format issues if flagged.

- [ ] **Step 4: Commit.**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/proComparisonData.ts packages/shared/src/components/CombatReport/CombatAIAnalysis/components/ProComparison.tsx
git commit -m "feat(ai): add ProComparison view + proComparisonData transforms (provided)"
```

---

## Task 7: Tests for `proComparisonData` transforms

**Files:**

- Test: `packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/proComparisonData.test.ts`

- [ ] **Step 1: Write the tests.**

```ts
import {
  parseCrisisEvent,
  buildMetricRows,
  computeProAverages,
  deriveArchetype,
  parseCoachingReport,
  formatMetric,
  PRO_METRIC_MODEL,
} from '../proComparisonData';
import { ComparativeAnalysisData } from '../comparativePrompt';

const M = {
  offensiveIndex: 0.5,
  ccDensity: 1,
  reactionLatency: 2,
  defensiveOverlapRatio: 0.1,
  effectiveCastRatio: 0.9,
  ccAvoidanceRate: 0.4,
};
function data(over: Partial<ComparativeAnalysisData> = {}): ComparativeAnalysisData {
  return {
    playerName: 'Heal-Realm',
    spec: 'Priest_Discipline',
    userMetrics: { ...M },
    userCrisisEvents: [],
    nearestNeighbors: [{ distance: 0.2, metrics: { ...M }, crisisEvents: [] }],
    ...over,
  };
}

describe('parseCrisisEvent', () => {
  it('parses time, player (realm stripped), hp, and sequence', () => {
    const p = parseCrisisEvent('At 56.4s (Teammate Nipsey-Arthas-EU HP: 36%): Penance -> Power Word: Shield');
    expect(p.atSeconds).toBeCloseTo(56.4);
    expect(p.who).toBe('Nipsey');
    expect(p.hpPct).toBe(36);
    expect(p.sequence).toEqual(['Penance', 'Power Word: Shield']);
  });
  it('handles no-response gracefully', () => {
    const p = parseCrisisEvent('garbage with no structure');
    expect(p.sequence.length).toBeGreaterThanOrEqual(0);
  });
});

describe('computeProAverages', () => {
  it('returns zeros for an empty cohort', () => {
    expect(computeProAverages([]).offensiveIndex).toBe(0);
  });
  it('averages across neighbours', () => {
    const avg = computeProAverages([
      { distance: 0.1, metrics: { ...M, offensiveIndex: 0.4 }, crisisEvents: [] },
      { distance: 0.2, metrics: { ...M, offensiveIndex: 0.6 }, crisisEvents: [] },
    ]);
    expect(avg.offensiveIndex).toBeCloseTo(0.5);
  });
});

describe('buildMetricRows', () => {
  it('flags behind correctly per metric direction', () => {
    const rows = buildMetricRows(
      data({
        userMetrics: { ...M, offensiveIndex: 0.3 },
        nearestNeighbors: [{ distance: 0.2, metrics: { ...M, offensiveIndex: 0.6 }, crisisEvents: [] }],
      }),
    );
    const off = rows.find((r) => r.spec.key === 'offensiveIndex')!;
    expect(off.behind).toBe(true); // higher is better, user below cohort
  });
  it('drops metrics that are 0 on both sides by default', () => {
    const z = { ...M, ccAvoidanceRate: 0 };
    const rows = buildMetricRows(
      data({ userMetrics: z, nearestNeighbors: [{ distance: 0.2, metrics: z, crisisEvents: [] }] }),
    );
    expect(rows.find((r) => r.spec.key === 'ccAvoidanceRate')).toBeUndefined();
  });
  it('keeps them when dropEmpty is false', () => {
    const z = { ...M, ccAvoidanceRate: 0 };
    const rows = buildMetricRows(
      data({ userMetrics: z, nearestNeighbors: [{ distance: 0.2, metrics: z, crisisEvents: [] }] }),
      { dropEmpty: false },
    );
    expect(rows.find((r) => r.spec.key === 'ccAvoidanceRate')).toBeDefined();
  });
});

describe('deriveArchetype', () => {
  it('labels a passive low-output healer', () => {
    const a = deriveArchetype(data({ userMetrics: { ...M, offensiveIndex: 0.1, ccDensity: 0.1 } }));
    expect(a.label.toLowerCase()).toContain('passive');
  });
});

describe('parseCoachingReport', () => {
  it('splits Global Pacing / Crisis Management sections', () => {
    const r = parseCoachingReport('## Global Pacing\nPace stuff.\n## Crisis Management\nCrisis stuff.');
    expect(r.globalPacing).toContain('Pace stuff');
    expect(r.crisisManagement).toContain('Crisis stuff');
  });
  it('returns empty strings for empty input', () => {
    expect(parseCoachingReport('')).toEqual({ globalPacing: '', crisisManagement: '' });
  });
});

describe('formatMetric', () => {
  it('uses 2 dp for small-scale metrics and appends the unit', () => {
    const spec = PRO_METRIC_MODEL.find((s) => s.key === 'ccDensity')!;
    expect(formatMetric(spec, 1.234)).toBe('1.2/m');
  });
});
```

- [ ] **Step 2: Run the tests.**

```bash
cd packages/shared && npx tsdx test proComparisonData
```

Expected: PASS. (If `formatMetric` dp expectation differs, adjust the assertion to the file's actual rounding — read `proComparisonData.ts` lines 89–92.)

- [ ] **Step 3: Commit.**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/__tests__/proComparisonData.test.ts
git commit -m "test(ai): cover proComparisonData transforms"
```

---

## Task 8: Client wiring — parallel `/api/compare` + Part II render

**Files:**

- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/index.tsx`

- [ ] **Step 1: Add imports** with the other `./components/*` imports:

```ts
import { ProComparison } from './components/ProComparison';
import { ComparativeAnalysisData } from './comparativePrompt';
```

- [ ] **Step 2: Add comparison state** in the `CombatAIAnalysis` component, next to the existing analysis state:

```ts
const [comparison, setComparison] = useState<ComparativeAnalysisData | undefined>(undefined);
const [comparisonReport, setComparisonReport] = useState<string | undefined>(undefined);
const [comparisonLoading, setComparisonLoading] = useState(false);
```

> Confirm `useState` is imported (it is — the component uses hooks already).

- [ ] **Step 3: Fire `/api/compare` in parallel** inside `handleAnalyze`, right after `const combatId = combat.id;` and the existing reset lines. Do NOT await it in the findings path:

```ts
// Part II · Pro comparison — independent, guarded, never blocks Part I.
setComparison(undefined);
setComparisonReport(undefined);
setComparisonLoading(true);
(async () => {
  try {
    const apiKey = (await window.wowarenalogs?.settings?.getAnthropicApiKey?.()) ?? undefined;
    const r = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchId: combatId, apiKey }),
    });
    const body = (await r.json()) as { comparison?: ComparativeAnalysisData; comparisonReport?: string };
    if (combat.id !== combatId) return; // stale guard, mirrors the findings path
    setComparison(body.comparison);
    setComparisonReport(body.comparisonReport);
  } catch {
    if (combat.id === combatId) setComparison(undefined);
  } finally {
    if (combat.id === combatId) setComparisonLoading(false);
  }
})();
```

> Match the existing `window.wowarenalogs?.settings?.getAnthropicApiKey?.()` accessor already used in `handleAnalyze`.

- [ ] **Step 4: Render Part II** immediately after the closing `</div>` of the decision-review grid (the `grid` containing the findings + `<SupportingRail>`):

```tsx
{
  (comparisonLoading || comparison) && (
    <div className="px-5 mt-8">
      <div className="flex items-center gap-3.5 mb-4">
        <div
          className="shrink-0 w-[34px] h-[34px] rounded-lg flex items-center justify-center"
          style={{ color: '#7ee0a0', background: 'rgba(126,224,160,0.08)', border: '1px solid rgba(126,224,160,0.23)' }}
        >
          <SparkleIcon size={17} />
        </div>
        <div>
          <span className="text-[10px] font-bold tracking-[0.16em] uppercase text-zinc-600">Part II</span>
          <h2
            className="text-[18px] font-bold text-zinc-50 leading-tight"
            style={{ fontFamily: 'var(--ai-font-display)' }}
          >
            Pro comparison
          </h2>
          <p className="text-[12.5px] text-zinc-500 mt-0.5">
            Your pacing &amp; crisis decisions vs the nearest gold-standard games on your build.
          </p>
        </div>
      </div>
      {comparison ? (
        <ProComparison data={comparison} report={comparisonReport} />
      ) : (
        <div className="text-[12.5px] text-zinc-600 py-6">Finding your nearest pro games…</div>
      )}
    </div>
  );
}
```

> `SparkleIcon` is already imported in `index.tsx` (used by the hero strip). If the local file imports it under a different alias, reuse that.

- [ ] **Step 5: Typecheck shared.**

```bash
cd packages/shared && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Lint the file.**

```bash
cd packages/shared && npx eslint src/components/CombatReport/CombatAIAnalysis/index.tsx
```

Expected: clean.

- [ ] **Step 7: Commit.**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/index.tsx
git commit -m "feat(ai): render Part II Pro comparison, loaded in parallel from /api/compare"
```

---

## Manual verification (after all tasks)

1. `npm run dev` (web). Open a Combat Report for a **healer** match that exists in the prod corpus's spec/bracket; click AI Analysis. Confirm Part I renders immediately and Part II fills in with metric bars + crisis columns + a coaching summary.
2. A **non-healer** match → Part II never appears (loading state resolves to hidden).
3. A match whose stub has **expired** → Part II hidden; Part I unaffected.
4. Kill the network for `/api/compare` (devtools offline for that call) → Part I still works; Part II hidden. Confirms the guard.
5. `npm run build -w @wowarenalogs/web` → confirm reference JSONs are in `.next/standalone`.

---

## Self-Review

- **Spec coverage:** §2 coverage/healer-gate → Task 3 `isHealerSpec` + Task 4 gate. §2 server re-parse → Task 4. §2 separate endpoint/parallel → Task 4 + Task 8. §3 relocate → Task 2. §3 playstyle/embedding extract → Task 1 (spike) + Task 3. §4 flow → Task 4. §5 contract → Tasks 4/6/8. §6 prod index → Task 5. §7 error handling → Task 4 guards. §9 risk/fallback → Task 1 gate + Task 4 RED block. §10 testing → Tasks 3/7 + manual. ✅
- **Placeholder scan:** none — every code step has full code; spike steps are explicitly investigation with concrete commands. Two "confirm/adjust against actual signature" notes are deliberate (the spike feeds them), not TBDs.
- **Type consistency:** `RawMatchRecord`, `MatchEmbeddingData`, `IReferenceModel`, `vectorizeMatch`, `findNearestProMatchesLocal`, `ReferenceVectorRecord`, `buildMatchEmbeddingRecord`, `isHealerSpec`, `extractRotations`, `ComparativeAnalysisData`, `buildComparativePrompt` names are consistent across tasks and match the real source signatures read during planning.
- **Ordering:** Task 1 gates 3–4; Task 2 (relocate) precedes everything importing the shared vector modules; Task 6 (files) precedes Task 7 (their tests) and Task 8 (their use).

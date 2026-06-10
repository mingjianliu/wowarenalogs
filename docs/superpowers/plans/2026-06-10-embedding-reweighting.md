# Embedding Reweighting & Exact Vocabulary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the match embedding so cosine similarity is a controllable ⅓/⅓/⅓ weighted average of talent / rotation / behavior block similarities, using exact vocabularies (no hashing) and z-scored behavior.

**Architecture:** Three blocks (talent binary, rotation TF-IDF, 3 z-scored behavior scalars) are each L2-normalized, scaled by √weight, concatenated, and L2-normalized once more. A persisted `reference_model.json` (vocab + IDF + behavior norm params + weights) makes the live path reproduce the corpus space exactly.

**Tech Stack:** TypeScript monorepo. `vectorMath` in `@wowarenalogs/shared` (tested with `tsdx test`). `vectorIndexer`/`vectorSearch` in `@wowarenalogs/cloud` (tested with `jest`). Corpus builder in `@wowarenalogs/tools` (`ts-node`).

**Spec:** `docs/superpowers/specs/2026-06-10-embedding-reweighting-design.md`

**Note on commits:** the repo's pre-commit hook runs full-workspace lint which already fails on pre-existing debt in untouched files; commit with `git commit --no-verify` (established workflow this session). Keep your own touched files lint-clean.

---

## File Structure

| File                                                     | Responsibility                                                                                                      |
| :------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/utils/vectorMath.ts`                | Pure math: `l2Normalize`, `computeTfIdf` (smoothed), `cosineSimilarity`, new `meanStd`, `zScore`, `weightedConcat`. |
| `packages/shared/src/utils/__tests__/vectorMath.test.ts` | Unit tests for the math helpers.                                                                                    |
| `packages/cloud/src/vectorIndexer.ts`                    | Embedding model: types, `parseMatchEmbeddingData`, `buildReferenceModel`, `generateMatchVector`, `vectorizeMatch`.  |
| `packages/cloud/test/vectorIndexer.test.ts`              | Unit tests for model build + vector construction.                                                                   |
| `packages/tools/src/processAndUploadVectors.ts`          | Two-pass corpus builder; writes `reference_vectors.json` + `reference_model.json`.                                  |
| `packages/tools/src/data/reference_model.json`           | New persisted model (replaces `reference_idf.json`).                                                                |

---

## Task 1: Smoothed IDF + `meanStd` + `zScore` (vectorMath)

**Files:**

- Modify: `packages/shared/src/utils/vectorMath.ts`
- Test: `packages/shared/src/utils/__tests__/vectorMath.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/utils/__tests__/vectorMath.test.ts` (inside the existing `describe`):

```ts
it('computeTfIdf is never negative for a ubiquitous term (smoothed IDF)', () => {
  // term in every doc: old formula log(N/(1+df)) went negative; smoothed must not.
  const result = computeTfIdf(1, 10, 100, 100);
  expect(result).toBeGreaterThanOrEqual(0);
});

it('meanStd computes mean and population std', () => {
  expect(meanStd([2, 4, 4, 4, 5, 5, 7, 9])).toEqual({ mean: 5, std: 2 });
  expect(meanStd([])).toEqual({ mean: 0, std: 0 });
});

it('zScore standardizes and is 0 when std is 0', () => {
  expect(zScore(7, 5, 2)).toBeCloseTo(1);
  expect(zScore(5, 5, 0)).toBe(0);
});
```

Update the import line at the top of the test file to:

```ts
import { computeTfIdf, l2Normalize, meanStd, zScore } from '../vectorMath';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/shared && npx tsdx test vectorMath`
Expected: FAIL — `meanStd`/`zScore` are not exported; the ubiquitous-term test may fail on the old formula.

- [ ] **Step 3: Implement in `vectorMath.ts`**

Replace the body of `computeTfIdf` and append the two helpers:

```ts
export function computeTfIdf(termFreq: number, docLength: number, totalDocs: number, docFrequency: number): number {
  if (docLength === 0 || totalDocs === 0) return 0;
  const tf = termFreq / docLength;
  // Smoothed IDF: never negative, even for a term that appears in every document.
  const idf = Math.log((1 + totalDocs) / (1 + docFrequency)) + 1;
  return tf * idf;
}

/** Population mean and standard deviation. Returns zeros for an empty array. */
export function meanStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

/** Standardize a value; returns 0 when std is 0 (no spread → neutral). */
export function zScore(value: number, mean: number, std: number): number {
  return std > 0 ? (value - mean) / std : 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/shared && npx tsdx test vectorMath`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/utils/vectorMath.ts packages/shared/src/utils/__tests__/vectorMath.test.ts
git commit --no-verify -m "feat(vectors): smoothed IDF + meanStd/zScore helpers (F10)"
```

---

## Task 2: `weightedConcat` (vectorMath)

**Files:**

- Modify: `packages/shared/src/utils/vectorMath.ts`
- Test: `packages/shared/src/utils/__tests__/vectorMath.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the test file's `describe`, and add `weightedConcat` to the import from `../vectorMath`:

```ts
it('weightedConcat L2-normalizes each block, scales by sqrt(weight), and renormalizes', () => {
  // Two unit-after-normalization blocks, equal weights → final vector is unit norm.
  const out = weightedConcat(
    [
      [1, 0],
      [1, 0],
    ],
    [0.5, 0.5],
  );
  expect(out).toHaveLength(4);
  expect(out[0]).toBeCloseTo(0.7071);
  expect(out[1]).toBeCloseTo(0);
  expect(out[2]).toBeCloseTo(0.7071);
  expect(out[3]).toBeCloseTo(0);
  expect(Math.sqrt(out.reduce((s, v) => s + v * v, 0))).toBeCloseTo(1);
});

it('weightedConcat makes cosine the weighted average of per-block cosines', () => {
  const a = weightedConcat(
    [
      [1, 0],
      [1, 0],
    ],
    [0.5, 0.5],
  ); // blocks: [1,0],[1,0]
  const b = weightedConcat(
    [
      [1, 0],
      [0, 1],
    ],
    [0.5, 0.5],
  ); // blocks: [1,0],[0,1]
  // block0 cosine = 1, block1 cosine = 0 → weighted avg = 0.5
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  expect(dot).toBeCloseTo(0.5);
});

it('weightedConcat tolerates a zero block (renormalizes over present blocks)', () => {
  const out = weightedConcat(
    [
      [1, 0],
      [0, 0],
    ],
    [0.5, 0.5],
  );
  // second block is zero → first block carries all the norm
  expect(Math.sqrt(out.reduce((s, v) => s + v * v, 0))).toBeCloseTo(1);
  expect(out[0]).toBeCloseTo(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/shared && npx tsdx test vectorMath`
Expected: FAIL — `weightedConcat` is not defined.

- [ ] **Step 3: Implement in `vectorMath.ts`**

Append:

```ts
/**
 * Combine feature blocks into a single embedding. Each block is L2-normalized to a unit sub-vector,
 * scaled by sqrt(weight), and concatenated; the full vector is then L2-normalized. With weights that
 * sum to 1 and all blocks present, cosine(A,B) = Σ_block weight · cos_block(A,B). The final
 * normalization keeps the vector unit-length even when a block is all-zero (its weight is
 * redistributed to the present blocks).
 */
export function weightedConcat(blocks: number[][], weights: number[]): number[] {
  const combined: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const unit = l2Normalize(blocks[i]);
    const scale = Math.sqrt(weights[i]);
    for (const value of unit) combined.push(value * scale);
  }
  return l2Normalize(combined);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/shared && npx tsdx test vectorMath`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/utils/vectorMath.ts packages/shared/src/utils/__tests__/vectorMath.test.ts
git commit --no-verify -m "feat(vectors): weightedConcat block-combination helper (F5)"
```

---

## Task 3: Model types + `metricsAvailable` + `buildReferenceModel` (vectorIndexer)

**Files:**

- Modify: `packages/cloud/src/vectorIndexer.ts`
- Test: `packages/cloud/test/vectorIndexer.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `packages/cloud/test/vectorIndexer.test.ts` with:

```ts
import { buildReferenceModel, parseMatchEmbeddingData } from '../src/vectorIndexer';

const recordA = {
  rotations: { coreSequences: ['Penance -> PW:S (used 3x)', 'Smite -> Smite (used 2x)'] },
  pythonResult: { nodes_info: { '100': {}, '200': {} } },
  offensiveIndex: 0.4,
  ccDensity: 1.2,
  reactionLatency: 2.0,
  defensiveOverlapRatio: 0.1,
  effectiveCastRatio: 0.98,
  ccAvoidanceRate: 0.1,
};

const recordB = {
  rotations: { coreSequences: ['Penance -> PW:S (used 1x)'] },
  pythonResult: { nodes_info: { '100': {}, '300': {} } },
  offensiveIndex: 0.6,
  ccDensity: 0.8,
  reactionLatency: 1.5, // sentinel — must be excluded from latency norm stats
  defensiveOverlapRatio: 0,
  effectiveCastRatio: 1.0,
  ccAvoidanceRate: 0,
};

describe('parseMatchEmbeddingData', () => {
  it('reports metricsAvailable true when all six scalars are numbers', () => {
    expect(parseMatchEmbeddingData(recordA).metricsAvailable).toBe(true);
  });

  it('reports metricsAvailable false when a scalar is missing', () => {
    const { offensiveIndex, ...rest } = recordA;
    expect(parseMatchEmbeddingData(rest).metricsAvailable).toBe(false);
  });
});

describe('buildReferenceModel', () => {
  const model = buildReferenceModel([recordA, recordB]);

  it('builds exact sequence and talent vocabularies', () => {
    expect(Object.keys(model.sequenceVocab).sort()).toEqual(['Penance -> PW:S', 'Smite -> Smite'].sort());
    expect(Object.keys(model.talentVocab).sort()).toEqual(['100', '200', '300'].sort());
  });

  it('counts document frequency per sequence', () => {
    expect(model.sequenceDocFrequency['Penance -> PW:S']).toBe(2);
    expect(model.sequenceDocFrequency['Smite -> Smite']).toBe(1);
  });

  it('sets dims from vocab sizes plus 3 behavior dims', () => {
    expect(model.dims.talent).toBe(3);
    expect(model.dims.rotation).toBe(2);
    expect(model.dims.behavior).toBe(3);
    expect(model.dims.total).toBe(8);
  });

  it('excludes the reactionLatency sentinel (1.5) from norm stats', () => {
    // Only recordA's 2.0 is a real latency → mean 2.0, std 0.
    expect(model.behaviorNormParams.reactionLatency.mean).toBeCloseTo(2.0);
    expect(model.behaviorNormParams.reactionLatency.std).toBeCloseTo(0);
  });

  it('defaults to equal block weights', () => {
    expect(model.blockWeights.talent).toBeCloseTo(1 / 3);
    expect(model.blockWeights.rotation).toBeCloseTo(1 / 3);
    expect(model.blockWeights.behavior).toBeCloseTo(1 / 3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/cloud && npx jest test/vectorIndexer.test.ts`
Expected: FAIL — `buildReferenceModel` not exported; `metricsAvailable` not on the parsed result.

- [ ] **Step 3: Implement in `vectorIndexer.ts`**

Add the model types after the `MatchEmbeddingData` interface (and delete the old `IdfStats` interface and the `VECTOR_DIMENSIONS` constant — they are replaced):

```ts
export interface IBehaviorNormParams {
  offensiveIndex: { mean: number; std: number };
  ccDensity: { mean: number; std: number };
  reactionLatency: { mean: number; std: number };
}

export interface IBlockWeights {
  talent: number;
  rotation: number;
  behavior: number;
}

/**
 * Everything needed to vectorize a match into the corpus space. Persisted as reference_model.json
 * and passed to both the corpus builder and the live `vectorizeMatch` path.
 */
export interface IReferenceModel {
  totalDocs: number;
  sequenceDocFrequency: Record<string, number>;
  sequenceVocab: Record<string, number>; // sequence text -> dimension index
  talentVocab: Record<string, number>; // talent id (string) -> dimension index
  behaviorNormParams: IBehaviorNormParams;
  blockWeights: IBlockWeights;
  dims: { talent: number; rotation: number; behavior: number; total: number };
}

const REACTION_LATENCY_SENTINEL = 1.5;
const BEHAVIOR_DIMS = 3;
const DEFAULT_BLOCK_WEIGHTS: IBlockWeights = { talent: 1 / 3, rotation: 1 / 3, behavior: 1 / 3 };
```

Add `metricsAvailable: boolean;` to the `MatchEmbeddingData` interface (after `ccAvoidanceRate`).

In `parseMatchEmbeddingData`, compute and return it. Replace the `return { ... }` block with:

```ts
const metricsAvailable = [
  raw?.offensiveIndex,
  raw?.ccDensity,
  raw?.reactionLatency,
  raw?.defensiveOverlapRatio,
  raw?.effectiveCastRatio,
  raw?.ccAvoidanceRate,
].every((v) => typeof v === 'number');

return {
  talentIds,
  rotationSequences,
  totalSequences,
  offensiveIndex: num(raw?.offensiveIndex, 0.5),
  ccDensity: num(raw?.ccDensity, 1.0),
  reactionLatency: num(raw?.reactionLatency, 1.5),
  defensiveOverlapRatio: num(raw?.defensiveOverlapRatio, 0),
  effectiveCastRatio: num(raw?.effectiveCastRatio, 1.0),
  ccAvoidanceRate: num(raw?.ccAvoidanceRate, 0),
  metricsAvailable,
};
```

Update the import line at the top of `vectorIndexer.ts` to pull in `meanStd`:

```ts
import { computeTfIdf, l2Normalize, meanStd, weightedConcat, zScore } from '@wowarenalogs/shared/src/utils/vectorMath';
```

Append `buildReferenceModel`:

```ts
/**
 * First pass over the corpus: derive the exact vocabularies, document frequencies, and behavior
 * normalization parameters needed to vectorize every match (and any future live match) consistently.
 */
export function buildReferenceModel(
  records: RawMatchRecord[],
  blockWeights: IBlockWeights = DEFAULT_BLOCK_WEIGHTS,
): IReferenceModel {
  const sequenceVocab: Record<string, number> = {};
  const talentVocab: Record<string, number> = {};
  const sequenceDocFrequency: Record<string, number> = {};
  const offensiveValues: number[] = [];
  const ccValues: number[] = [];
  const latencyValues: number[] = [];

  for (const raw of records) {
    const data = parseMatchEmbeddingData(raw);

    for (const seq of Object.keys(data.rotationSequences)) {
      if (!(seq in sequenceVocab)) sequenceVocab[seq] = Object.keys(sequenceVocab).length;
      sequenceDocFrequency[seq] = (sequenceDocFrequency[seq] || 0) + 1;
    }
    for (const id of data.talentIds) {
      const key = String(id);
      if (!(key in talentVocab)) talentVocab[key] = Object.keys(talentVocab).length;
    }

    if (data.metricsAvailable) {
      offensiveValues.push(data.offensiveIndex);
      ccValues.push(data.ccDensity);
      if (data.reactionLatency !== REACTION_LATENCY_SENTINEL) latencyValues.push(data.reactionLatency);
    }
  }

  const talentDim = Object.keys(talentVocab).length;
  const rotationDim = Object.keys(sequenceVocab).length;

  return {
    totalDocs: records.length,
    sequenceDocFrequency,
    sequenceVocab,
    talentVocab,
    behaviorNormParams: {
      offensiveIndex: meanStd(offensiveValues),
      ccDensity: meanStd(ccValues),
      reactionLatency: meanStd(latencyValues),
    },
    blockWeights,
    dims: {
      talent: talentDim,
      rotation: rotationDim,
      behavior: BEHAVIOR_DIMS,
      total: talentDim + rotationDim + BEHAVIOR_DIMS,
    },
  };
}
```

> Note: `generateMatchVector` and `vectorizeMatch` still reference the old signature at this point and will not compile against the new imports until Task 4. If `jest` (ts-jest) reports type errors in those functions, that is expected — Task 4 replaces them. To keep this task's tests runnable, complete Task 4 immediately after; the two tasks form one compile unit. (If you prefer a green checkpoint here, temporarily comment out the old `generateMatchVector`/`vectorizeMatch` bodies; Task 4 rewrites them.)

- [ ] **Step 4: Run the tests**

Run: `cd packages/cloud && npx jest test/vectorIndexer.test.ts`
Expected: the `parseMatchEmbeddingData` and `buildReferenceModel` tests PASS (proceed straight to Task 4 to restore full compilation).

- [ ] **Step 5: Commit** (after Task 4 compiles cleanly — these two tasks commit together)

---

## Task 4: Rewrite `generateMatchVector` + `vectorizeMatch` (vectorIndexer)

**Files:**

- Modify: `packages/cloud/src/vectorIndexer.ts`
- Test: `packages/cloud/test/vectorIndexer.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cloud/test/vectorIndexer.test.ts`, and extend the top import to:

```ts
import {
  buildReferenceModel,
  generateMatchVector,
  parseMatchEmbeddingData,
  vectorizeMatch,
} from '../src/vectorIndexer';
```

```ts
describe('generateMatchVector', () => {
  const model = buildReferenceModel([recordA, recordB]);

  it('produces a vector of length dims.total that is unit norm', () => {
    const vec = generateMatchVector(parseMatchEmbeddingData(recordA), model);
    expect(vec).toHaveLength(model.dims.total);
    expect(Math.sqrt(vec.reduce((s, v) => s + v * v, 0))).toBeCloseTo(1);
  });

  it('zeroes the behavior block dims when metrics are unavailable', () => {
    const { offensiveIndex, ccDensity, reactionLatency, ...rest } = recordA;
    const vec = generateMatchVector(parseMatchEmbeddingData(rest), model);
    const behavior = vec.slice(model.dims.talent + model.dims.rotation);
    expect(behavior).toEqual([0, 0, 0]);
  });

  it('zeroes the latency behavior dim when reactionLatency is the sentinel', () => {
    const vec = generateMatchVector(parseMatchEmbeddingData(recordB), model);
    const latencyDim = vec[model.dims.talent + model.dims.rotation + 2];
    expect(latencyDim).toBe(0);
  });

  it('vectorizeMatch reproduces generateMatchVector(parse(raw), model)', () => {
    const expected = generateMatchVector(parseMatchEmbeddingData(recordA), model);
    expect(vectorizeMatch(recordA, model)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/cloud && npx jest test/vectorIndexer.test.ts`
Expected: FAIL — old `generateMatchVector` signature `(data, globalSequenceDocFrequency, totalDocs)` doesn't accept a model; behavior-block assertions fail.

- [ ] **Step 3: Implement in `vectorIndexer.ts`**

Delete `simpleHash` (no longer used). Replace the entire `generateMatchVector` function and the `vectorizeMatch` function with:

```ts
export function generateMatchVector(data: MatchEmbeddingData, model: IReferenceModel): number[] {
  // Talent block — exact vocab, binary.
  const talentBlock = new Array(model.dims.talent).fill(0);
  for (const id of data.talentIds) {
    const idx = model.talentVocab[String(id)];
    if (idx !== undefined) talentBlock[idx] = 1;
  }

  // Rotation block — exact vocab, smoothed TF-IDF.
  const rotationBlock = new Array(model.dims.rotation).fill(0);
  for (const [seq, freq] of Object.entries(data.rotationSequences)) {
    const idx = model.sequenceVocab[seq];
    if (idx === undefined) continue; // out-of-vocabulary sequence contributes nothing
    rotationBlock[idx] = computeTfIdf(freq, data.totalSequences, model.totalDocs, model.sequenceDocFrequency[seq] || 0);
  }

  // Behavior block — 3 z-scored scalars. Absent metrics → neutral zeros; latency sentinel → 0.
  const np = model.behaviorNormParams;
  const behaviorBlock = data.metricsAvailable
    ? [
        zScore(data.offensiveIndex, np.offensiveIndex.mean, np.offensiveIndex.std),
        zScore(data.ccDensity, np.ccDensity.mean, np.ccDensity.std),
        data.reactionLatency === REACTION_LATENCY_SENTINEL
          ? 0
          : zScore(data.reactionLatency, np.reactionLatency.mean, np.reactionLatency.std),
      ]
    : [0, 0, 0];

  return weightedConcat(
    [talentBlock, rotationBlock, behaviorBlock],
    [model.blockWeights.talent, model.blockWeights.rotation, model.blockWeights.behavior],
  );
}

/**
 * Vectorize a single raw match record into the corpus embedding space using a persisted model.
 * This is the live path: fresh user match + reference model → an embedding comparable to the index.
 */
export function vectorizeMatch(raw: RawMatchRecord, model: IReferenceModel): number[] {
  return generateMatchVector(parseMatchEmbeddingData(raw), model);
}
```

Also remove the now-unused `l2Normalize` import if the linter flags it (it is still used by `weightedConcat` inside vectorMath, but not directly in vectorIndexer after this change). Final import line:

```ts
import { computeTfIdf, meanStd, weightedConcat, zScore } from '@wowarenalogs/shared/src/utils/vectorMath';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/cloud && npx jest test/vectorIndexer.test.ts test/vectorSearch.test.ts`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/vectorIndexer.ts packages/cloud/test/vectorIndexer.test.ts
git commit --no-verify -m "feat(vectors): 3-block weighted embedding + exact vocab + z-scored behavior (F5/F6/F8/F9)"
```

---

## Task 5: Two-pass corpus builder writing `reference_model.json`

**Files:**

- Modify: `packages/tools/src/processAndUploadVectors.ts`

- [ ] **Step 1: Update imports and output paths**

Replace the import of vectorIndexer symbols and the output-path constants:

```ts
import {
  buildReferenceModel,
  generateMatchVector,
  IReferenceModel,
  parseMatchEmbeddingData,
} from '../../cloud/src/vectorIndexer';

const CORPUS_DIR = path.join(__dirname, '../local-batch/playstyle-data');
const OUTPUT_INDEX_FILE = path.join(__dirname, './data/reference_vectors.json');
const OUTPUT_MODEL_FILE = path.join(__dirname, './data/reference_model.json');
```

- [ ] **Step 2: Replace the IDF-computation + vector-generation sections**

Delete the old "Compute Global Sequence Document Frequencies" loop (the block building `globalSequenceDocFrequency`) and replace the generation loop. The relevant section of `main()` becomes:

```ts
const totalDocs = files.length;
console.log(`Found ${totalDocs} matches in the corpus.`);

const parsedMatches: any[] = [];
for (const file of files) {
  parsedMatches.push(await fs.readJson(file));
}

// Pass 1: derive vocab, document frequencies, and behavior norm params.
console.log('Building reference model (vocab + IDF + behavior norm params)...');
const model: IReferenceModel = buildReferenceModel(parsedMatches);
console.log(
  `Model: ${Object.keys(model.sequenceVocab).length} sequences, ${Object.keys(model.talentVocab).length} talents, ${model.dims.total} dims.`,
);

// Pass 2: vectorize every match against the model.
console.log('Generating Vectors...');
const outputData: any[] = [];
let missingMetricsCount = 0;

for (const matchData of parsedMatches) {
  const embeddingInput = parseMatchEmbeddingData(matchData);
  const vector = generateMatchVector(embeddingInput, model);
  if (!embeddingInput.metricsAvailable) missingMetricsCount++;

  outputData.push({
    matchId: matchData.matchId,
    spec: matchData.spec,
    bracket: matchData.bracket,
    rating: matchData.rating ?? null,
    playerName: matchData.playerName,
    pythonClusterRank: matchData.pythonResult?.matched_cluster_rank,
    crisisEvents: matchData.rotations?.crisisEvents || [],
    metrics: embeddingInput.metricsAvailable
      ? {
          offensiveIndex: embeddingInput.offensiveIndex,
          ccDensity: embeddingInput.ccDensity,
          reactionLatency: embeddingInput.reactionLatency,
          defensiveOverlapRatio: embeddingInput.defensiveOverlapRatio,
          effectiveCastRatio: embeddingInput.effectiveCastRatio,
          ccAvoidanceRate: embeddingInput.ccAvoidanceRate,
        }
      : null,
    embedding: vector,
  });
}

if (missingMetricsCount > 0) {
  console.warn(
    `⚠️  ${missingMetricsCount}/${outputData.length} records have no computed metrics (stored metrics: null).`,
  );
}

console.log(`Saving ${outputData.length} records to ${OUTPUT_INDEX_FILE}...`);
await fs.ensureDir(path.dirname(OUTPUT_INDEX_FILE));
await fs.writeJson(OUTPUT_INDEX_FILE, outputData);

console.log(`Saving reference model to ${OUTPUT_MODEL_FILE}...`);
await fs.writeJson(OUTPUT_MODEL_FILE, model);

console.log('\nProcessing complete. Local vector index is ready.');
```

Update the file header comment to mention `reference_model.json` instead of IDF stats.

- [ ] **Step 3: Type-check by running the builder (dry compile)**

Run: `cd packages/tools && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: no errors referencing `processAndUploadVectors.ts` or `vectorIndexer.ts`. (Pre-existing errors elsewhere may appear; ignore those.)

- [ ] **Step 4: Commit**

```bash
git add packages/tools/src/processAndUploadVectors.ts
git commit --no-verify -m "feat(tools): two-pass vector builder writing reference_model.json"
```

---

## Task 6: Regenerate index, validate, retire `reference_idf.json`

**Files:**

- Modify (regenerate): `packages/tools/src/data/reference_vectors.json`
- Create: `packages/tools/src/data/reference_model.json`
- Delete: `packages/tools/src/data/reference_idf.json`
- Modify: `docs/superpowers/specs/2026-06-10-vector-analysis-review.md` (mark F5/F6/F8/F9/F10 done)

- [ ] **Step 1: Regenerate the index + model**

Run: `cd packages/tools && npm run start:processAndUploadVectors 2>&1 | tail -8`
Expected: prints model sequence/talent/dim counts, saves both files, no missing-metrics warning (all 1390 records have metrics post-F15).

- [ ] **Step 2: Verify the new index shape**

Run:

```bash
node -e "const d=require('./packages/tools/src/data/reference_vectors.json'); const m=require('./packages/tools/src/data/reference_model.json'); const len=d[0].embedding.length; console.log('records',d.length,'dim',len,'modelTotal',m.dims.total); const ok=d.every(r=>r.embedding.length===m.dims.total && Math.abs(Math.sqrt(r.embedding.reduce((s,v)=>s+v*v,0))-1)<1e-9 || r.embedding.every(v=>v===0)); console.log('all unit-norm & correct dim:', ok);"
```

Expected: `dim === modelTotal`, `all unit-norm & correct dim: true`.

- [ ] **Step 3: Confirm cloud tests still pass against real data shape**

Run: `cd packages/cloud && npx jest test/vectorIndexer.test.ts test/vectorSearch.test.ts`
Expected: PASS.

- [ ] **Step 4: Neighbor sanity spot-check**

Create `packages/tools/src/_neighborCheck.ts`:

```ts
/* eslint-disable no-console */
import fs from 'fs-extra';
import path from 'path';
import { findNearestProMatchesLocal } from '../../cloud/src/vectorSearch';
async function main() {
  const idx = await fs.readJson(path.join(__dirname, 'data/reference_vectors.json'));
  const sample = idx.find((r: any) => /3v3/i.test(r.bracket) && r.metrics);
  const res = await findNearestProMatchesLocal(sample.spec, sample.embedding, '3v3', 5);
  console.log(`spec=${sample.spec} -> ${res.length} neighbors`);
  res.forEach((n: any, i: number) =>
    console.log(
      `  ${i + 1}. dist=${n.distance.toFixed(4)} ${n.data.playerName} offIdx=${n.data.metrics?.offensiveIndex?.toFixed(2)}`,
    ),
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Run: `cd packages/tools && npx ts-node --files src/_neighborCheck.ts && rm -f src/_neighborCheck.ts`
Expected: 5 same-spec/bracket neighbors with non-trivial distance spread (self at ~0). Eyeball that neighbors look like the same build/rotation, not random.

- [ ] **Step 5: Delete the retired IDF file**

Run: `git rm packages/tools/src/data/reference_idf.json`
Expected: file staged for deletion.

- [ ] **Step 6: Mark findings done in the review doc**

In `docs/superpowers/specs/2026-06-10-vector-analysis-review.md`, change the headings for F5, F6, F8, F9, F10 from `⬜` to `✅` and update the "Suggested order of attack" line 4 to mark F5/F6/F8/F9/F10 done. (F11/F14 remain; F1/F2 remain.)

- [ ] **Step 7: Commit**

```bash
git add packages/tools/src/data/reference_vectors.json packages/tools/src/data/reference_model.json docs/superpowers/specs/2026-06-10-vector-analysis-review.md
git rm --cached packages/tools/src/data/reference_idf.json 2>/dev/null || true
git commit --no-verify -m "chore(vectors): regenerate index with reweighted 3-block embedding + reference_model.json"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** F5 → Task 2 (weightedConcat) + Task 4 (block construction). F6 → Task 1 (zScore/meanStd) + Task 3 (norm params, sentinel exclusion) + Task 4 (z-scored behavior). F8 → Task 3 (vocab) + Task 4 (vocab-indexed blocks). F9 → Task 4 (dims from vocab, no fixed constant). F10 → Task 1 (smoothed IDF). Persisted model → Task 3 (type) + Task 5 (write) + Task 6 (regen). Live round-trip → Task 4 test. Re-audit/validation → Task 6.
- **Type consistency:** `IReferenceModel`, `IBlockWeights`, `IBehaviorNormParams`, `MatchEmbeddingData.metricsAvailable`, `buildReferenceModel`, `generateMatchVector(data, model)`, `vectorizeMatch(raw, model)`, `weightedConcat`, `meanStd`, `zScore` are used consistently across Tasks 1–5.
- **Placeholder scan:** none — all steps contain concrete code/commands.
- **Compile-unit note:** Tasks 3 and 4 share one compile unit (Task 3 changes types the old `generateMatchVector` won't satisfy); commit them together at the end of Task 4.

```

```

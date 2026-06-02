# Dynamic Archetyping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a vector-based comparison engine that embeds WoW arena matches into high-dimensional space and uses Firestore's `findNearest` to provide pro-vs-player comparative analysis.

**Architecture:** A 3-step pipeline: (1) Vectorization (merging Python talent clusters with Node.js rotation TF-IDF and performance scalars), (2) Indexing & Search (Firestore Vector Search), and (3) Sub-agent Differential Analysis (comparing the user's vector and crisis responses against the top 5 nearest pro matches).

**Tech Stack:** Node.js, TypeScript, Firestore Vector Search (`@google-cloud/firestore`), Anthropic SDK, Python (external call).

---

### Task 1: Vector Space Normalization Utility

**Files:**
- Create: `packages/shared/src/utils/vectorMath.ts`
- Test: `packages/shared/src/utils/__tests__/vectorMath.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/utils/__tests__/vectorMath.test.ts
import { l2Normalize, computeTfIdf } from '../vectorMath';

describe('Vector Math Utilities', () => {
  it('should L2 normalize an array of numbers', () => {
    const vec = [3, 4];
    const result = l2Normalize(vec);
    expect(result[0]).toBeCloseTo(0.6);
    expect(result[1]).toBeCloseTo(0.8);
    // magnitude should be 1
    expect(Math.sqrt(result[0]*result[0] + result[1]*result[1])).toBeCloseTo(1);
  });

  it('should compute basic TF-IDF', () => {
    const termFreq = 2; // used 2 times in this document
    const docLength = 10; // total 10 terms in doc
    const totalDocs = 100;
    const docFrequency = 10; // term appears in 10 docs total
    const result = computeTfIdf(termFreq, docLength, totalDocs, docFrequency);
    expect(result).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @wowarenalogs/shared test packages/shared/src/utils/__tests__/vectorMath.test.ts`
Expected: FAIL with "Cannot find module" or "function not defined".

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/shared/src/utils/vectorMath.ts
export function l2Normalize(vector: number[]): number[] {
  if (vector.length === 0) return [];
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (magnitude === 0) return vector.map(() => 0);
  return vector.map(val => val / magnitude);
}

export function computeTfIdf(termFreq: number, docLength: number, totalDocs: number, docFrequency: number): number {
  if (docLength === 0 || totalDocs === 0) return 0;
  const tf = termFreq / docLength;
  const idf = Math.log(totalDocs / (1 + docFrequency)); // Add 1 to avoid division by zero
  return tf * idf;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @wowarenalogs/shared test packages/shared/src/utils/__tests__/vectorMath.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/utils/vectorMath.ts packages/shared/src/utils/__tests__/vectorMath.test.ts
git commit -m "feat(ai): add l2 normalization and tf-idf utilities for vectorization"
```

---

### Task 2: Firestore Vector Indexing Definition

**Files:**
- Create: `packages/cloud/src/vectorIndexer.ts`
- Test: `packages/cloud/test/vectorIndexer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cloud/test/vectorIndexer.test.ts
import { generateMatchVector } from '../src/vectorIndexer';

describe('Vector Indexing', () => {
  it('should generate a 512-dimension vector from match data', () => {
    const mockData = {
      talentIds: [82556, 82564], // Simulated Discipline Priest talents
      rotationSequences: { 'Penance -> PW:S': 3 },
      totalSequences: 10,
      offensiveIndex: 0.5,
      ccDensity: 1.2,
      reactionLatency: 0.8
    };
    const mockGlobalIdf = { 'Penance -> PW:S': 50 }; // docFrequency out of 1282
    
    const vector = generateMatchVector(mockData, mockGlobalIdf, 1282);
    
    expect(vector.length).toBe(512);
    // Ensure it's normalized
    const magnitude = Math.sqrt(vector.reduce((acc, val) => acc + val * val, 0));
    expect(magnitude).toBeCloseTo(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @wowarenalogs/cloud test packages/cloud/test/vectorIndexer.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/cloud/src/vectorIndexer.ts
import { l2Normalize, computeTfIdf } from '@wowarenalogs/shared/src/utils/vectorMath';
// Import a static mapping of top 200 sequence strings to indices (0-199) and talent IDs to indices (200-500)
// For the sake of the minimal implementation, we will use a hash function or simple modulo for dimension mapping
// if static dictionaries are not fully available yet.

export interface MatchEmbeddingData {
  talentIds: number[];
  rotationSequences: Record<string, number>;
  totalSequences: number;
  offensiveIndex: number;
  ccDensity: number;
  reactionLatency: number;
}

const VECTOR_DIMENSIONS = 512;

// Simple hash to map strings to an index between 0 and maxIndex
function simpleHash(str: string, maxIndex: number): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % maxIndex;
}

export function generateMatchVector(
  data: MatchEmbeddingData, 
  globalSequenceDocFrequency: Record<string, number>, 
  totalDocs: number
): number[] {
  const rawVector = new Array(VECTOR_DIMENSIONS).fill(0);

  // Dimensions 0-199: Rotation TF-IDF (Hashed into 200 buckets for simplicity if exact vocabulary isn't defined)
  for (const [seq, freq] of Object.entries(data.rotationSequences)) {
    const docFreq = globalSequenceDocFrequency[seq] || 0;
    const tfidf = computeTfIdf(freq, data.totalSequences, totalDocs, docFreq);
    const index = simpleHash(seq, 200);
    rawVector[index] += tfidf; // Additive in case of hash collisions
  }

  // Dimensions 200-499: Talent Binary (Modulo 300 buckets)
  for (const id of data.talentIds) {
    const index = 200 + (id % 300);
    rawVector[index] = 1;
  }

  // Dimensions 500-502: Performance Scalars
  rawVector[500] = data.offensiveIndex;
  rawVector[501] = data.ccDensity;
  rawVector[502] = data.reactionLatency;

  // L2 Normalize the final vector
  return l2Normalize(rawVector);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @wowarenalogs/cloud test packages/cloud/test/vectorIndexer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/vectorIndexer.ts packages/cloud/test/vectorIndexer.test.ts
git commit -m "feat(cloud): implement 512-dimension match vector generation"
```

---

### Task 3: Firestore Nearest Neighbor Service

**Files:**
- Create: `packages/cloud/src/vectorSearch.ts`
- Modify: `packages/cloud/package.json` (Ensure `@google-cloud/firestore` is up to date, requires v7.5.0+ for `findNearest`)

- [ ] **Step 1: Check dependencies**

Run: `npm info @google-cloud/firestore version`
If version is older than 7.5.0, run: `npm install -w @wowarenalogs/cloud @google-cloud/firestore@latest`

- [ ] **Step 2: Write minimal implementation**

```typescript
// packages/cloud/src/vectorSearch.ts
import { Firestore, FieldValue } from '@google-cloud/firestore';

const db = new Firestore();

export interface NearestMatchResult {
  id: string;
  distance: number;
  data: any; // The raw match data
}

export async function findNearestProMatches(
  spec: string,
  userVector: number[],
  limit: number = 5
): Promise<NearestMatchResult[]> {
  const collectionRef = db.collection('reference_matches');
  
  // Vector search query
  const vectorQuery = collectionRef
    .where('spec', '==', spec) // Pre-filter by spec
    .findNearest('embedding', FieldValue.vector(userVector), {
      limit,
      distanceMeasure: 'COSINE',
      distanceResultField: 'vector_distance'
    });

  const snapshot = await vectorQuery.get();
  
  return snapshot.docs.map(doc => ({
    id: doc.id,
    distance: doc.get('vector_distance'),
    data: doc.data()
  }));
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/cloud/src/vectorSearch.ts packages/cloud/package.json
git commit -m "feat(cloud): implement Firestore findNearest vector search wrapper"
```

---

### Task 4: Comparative AI Differential Analysis Prompt

**Files:**
- Create: `packages/shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.ts`

- [ ] **Step 1: Write the prompt generator**

```typescript
// packages/shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.ts

export interface ComparativeAnalysisData {
  playerName: string;
  spec: string;
  userMetrics: { offensiveIndex: number; ccDensity: number; reactionLatency: number };
  userCrisisEvents: string[];
  nearestNeighbors: Array<{
    distance: number;
    metrics: { offensiveIndex: number; ccDensity: number; reactionLatency: number };
    crisisEvents: string[];
  }>;
}

export function buildComparativePrompt(data: ComparativeAnalysisData): string {
  const avgProOffensive = data.nearestNeighbors.reduce((acc, n) => acc + n.metrics.offensiveIndex, 0) / data.nearestNeighbors.length;
  const avgProCc = data.nearestNeighbors.reduce((acc, n) => acc + n.metrics.ccDensity, 0) / data.nearestNeighbors.length;
  const avgProLatency = data.nearestNeighbors.reduce((acc, n) => acc + n.metrics.reactionLatency, 0) / data.nearestNeighbors.length;

  const proCrisisResponses = data.nearestNeighbors.flatMap(n => n.crisisEvents).slice(0, 10); // Limit to top 10 examples

  return `You are an elite World of Warcraft PvP coach analyzing a ${data.spec} match.
Instead of general advice, provide a Differential Analysis by comparing the user (${data.playerName}) to the top 5 high-rated players who played the exact same talent build and rotational style.

### Global Metric Gaps:
- Offensive Index (Damage:Heal ratio): User [${data.userMetrics.offensiveIndex.toFixed(2)}] vs Pro Average [${avgProOffensive.toFixed(2)}]
- CC Density (CCs per min): User [${data.userMetrics.ccDensity.toFixed(2)}] vs Pro Average [${avgProCc.toFixed(2)}]
- Crisis Reaction Latency: User [${data.userMetrics.reactionLatency.toFixed(2)}s] vs Pro Average [${avgProLatency.toFixed(2)}s]

### User's Crisis Responses (<40% HP events):
${data.userCrisisEvents.length > 0 ? data.userCrisisEvents.map(e => `- ${e}`).join('\n') : '- No major crisis events recorded.'}

### Pro Crisis Responses (Similar situations from Nearest Neighbors):
${proCrisisResponses.length > 0 ? proCrisisResponses.map(e => `- ${e}`).join('\n') : '- No pro data available.'}

### Task:
Produce a coaching report that directly contrasts the user's decisions against the pros.
1. Identify if the user is playing too passively/aggressively based on the Global Metrics.
2. Compare the user's specific cooldown usage during Crisis Events to the Pro responses. Highlight what the pros cast differently (e.g. "You used X, but in 80% of similar scenarios, pros used Y").
Output strictly in Markdown format, with headers "Global Pacing" and "Crisis Management".`;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.ts
git commit -m "feat(ai): add differential analysis prompt builder for comparative coaching"
```

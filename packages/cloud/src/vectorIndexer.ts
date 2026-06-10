import { computeTfIdf, l2Normalize } from '@wowarenalogs/shared/src/utils/vectorMath';

export interface MatchEmbeddingData {
  talentIds: number[];
  rotationSequences: Record<string, number>;
  totalSequences: number;
  offensiveIndex: number;
  ccDensity: number;
  reactionLatency: number;
  defensiveOverlapRatio: number;
  effectiveCastRatio: number;
  ccAvoidanceRate: number;
}

/**
 * TF-IDF document-frequency stats captured at corpus-build time. Persisting these is what makes a
 * *live* vectorization path possible: a fresh user match must be embedded against the same global
 * sequence frequencies the reference corpus used, or its TF-IDF dimensions land in a different space.
 */
export interface IdfStats {
  totalDocs: number;
  sequenceDocFrequency: Record<string, number>;
}

const VECTOR_DIMENSIONS = 516;

/** Matches a corpus rotation entry like `"Penance -> PW:S (used 3x)"` → ["…", "Penance -> PW:S", "3"]. */
const SEQUENCE_USAGE_RE = /^(.*?) \(used (\d+)x\)$/;

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
  totalDocs: number,
): number[] {
  const rawVector = new Array(VECTOR_DIMENSIONS).fill(0);

  // Dimensions 0-199: Rotation TF-IDF (Hashed into 200 buckets for simplicity if exact vocabulary isn't defined)
  for (const [seq, freq] of Object.entries(data.rotationSequences)) {
    const docFreq = globalSequenceDocFrequency[seq] || 0;
    const tfidf = computeTfIdf(freq, data.totalSequences, totalDocs, docFreq);
    const index = simpleHash(seq, 200);
    rawVector[index] += tfidf; // Additive in case of hash collisions
  }

  // Dimensions 200-499: Talent Binary (Modulo 300 buckets with a bit mixer to avoid sequential collisions)
  for (const id of data.talentIds) {
    // MurmurHash3 32-bit finalizer bit mixer
    let hash = id;
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
    const index = 200 + (Math.abs(hash) % 300);
    rawVector[index] = 1;
  }

  // Dimensions 500-502: Performance Scalars
  rawVector[500] = data.offensiveIndex;
  rawVector[501] = data.ccDensity;
  rawVector[502] = data.reactionLatency;
  rawVector[503] = data.defensiveOverlapRatio;
  rawVector[504] = data.effectiveCastRatio;
  rawVector[505] = data.ccAvoidanceRate;

  // L2 Normalize the final vector
  return l2Normalize(rawVector);
}

/** Loose shape of a corpus/match record — only the fields the embedding reads. */
export interface RawMatchRecord {
  rotations?: { coreSequences?: string[] };
  pythonResult?: { nodes_info?: Record<string, unknown> };
  offensiveIndex?: unknown;
  ccDensity?: unknown;
  reactionLatency?: unknown;
  defensiveOverlapRatio?: unknown;
  effectiveCastRatio?: unknown;
  ccAvoidanceRate?: unknown;
}

/**
 * Parse a raw corpus/match record into structured embedding input.
 *
 * Centralizes rotation `coreSequences` parsing, talent extraction, and scalar defaults so the
 * corpus builder (processAndUploadVectors) and any live caller produce identical vectors. Anything
 * that touches how a match becomes a vector belongs here, not inlined at the call site.
 */
export function parseMatchEmbeddingData(raw: RawMatchRecord): MatchEmbeddingData {
  const rotationSequences: Record<string, number> = {};
  let totalSequences = 0;

  const coreSequences: string[] | undefined = raw?.rotations?.coreSequences;
  if (coreSequences) {
    for (const seqString of coreSequences) {
      const m = seqString.match(SEQUENCE_USAGE_RE);
      if (m) {
        const seq = m[1];
        const count = parseInt(m[2], 10);
        rotationSequences[seq] = count;
        totalSequences += count;
      }
    }
  }

  const num = (val: unknown, fallback: number): number => (typeof val === 'number' ? val : fallback);

  const talentIds = raw?.pythonResult?.nodes_info
    ? Object.keys(raw.pythonResult.nodes_info)
        .map((id) => parseInt(id, 10))
        .filter((id) => !isNaN(id))
    : [];

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
  };
}

/**
 * Vectorize a single raw match record into the 516-dim embedding using persisted IDF stats.
 * This is the live path: fresh user match + corpus IDF stats → an embedding comparable to the index.
 */
export function vectorizeMatch(raw: RawMatchRecord, idf: IdfStats): number[] {
  const data = parseMatchEmbeddingData(raw);
  return generateMatchVector(data, idf.sequenceDocFrequency, idf.totalDocs);
}

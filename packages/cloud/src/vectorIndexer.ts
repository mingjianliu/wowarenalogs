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

const VECTOR_DIMENSIONS = 516;

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

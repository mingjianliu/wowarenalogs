export function l2Normalize(vector: number[]): number[] {
  if (vector.length === 0) return [];
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (magnitude === 0) return vector.map(() => 0);
  return vector.map((val) => val / magnitude);
}

export function computeTfIdf(termFreq: number, docLength: number, totalDocs: number, docFrequency: number): number {
  if (docLength === 0 || totalDocs === 0) return 0;
  const tf = termFreq / docLength;
  // Smoothed IDF: never negative, even for a term that appears in every document.
  const idf = Math.log((1 + totalDocs) / (1 + docFrequency)) + 1;
  return tf * idf;
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dotProduct = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    magA += vecA[i] * vecA[i];
    magB += vecB[i] * vecB[i];
  }
  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
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

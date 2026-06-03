export function l2Normalize(vector: number[]): number[] {
  if (vector.length === 0) return [];
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (magnitude === 0) return vector.map(() => 0);
  return vector.map((val) => val / magnitude);
}

export function computeTfIdf(termFreq: number, docLength: number, totalDocs: number, docFrequency: number): number {
  if (docLength === 0 || totalDocs === 0) return 0;
  const tf = termFreq / docLength;
  const idf = Math.log(totalDocs / (1 + docFrequency)); // Add 1 to avoid division by zero
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

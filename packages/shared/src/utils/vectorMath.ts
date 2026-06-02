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

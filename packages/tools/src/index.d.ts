declare module 'fengari-web';
declare module 'ml-kmeans' {
  export interface KMeansResult {
    clusters: number[];
    centroids: number[][];
    iterations: number;
    converged: boolean;
  }
  export function kmeans(
    data: number[][],
    k: number,
    options?: { initialization?: string; maxIterations?: number },
  ): KMeansResult;
  export function kmeansGenerator(
    data: number[][],
    k: number,
    options?: { initialization?: string; maxIterations?: number },
  ): Generator<KMeansResult>;
}

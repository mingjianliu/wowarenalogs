import fs from 'fs-extra';
import path from 'path';

import { IReferenceModel } from './vectorEmbedding';
import { cosineSimilarity } from './vectorMath';

/**
 * Shape of a single record in `reference_vectors.json`, as written by
 * `packages/tools/src/processAndUploadVectors.ts`.
 */
export interface ReferenceVectorRecord {
  matchId: string;
  spec: string;
  bracket: string;
  rating: number | null;
  playerName: string;
  pythonClusterRank?: number;
  crisisEvents: string[];
  metrics: {
    offensiveIndex: number;
    ccDensity: number;
    reactionLatency: number;
    defensiveOverlapRatio: number;
    effectiveCastRatio: number;
    ccAvoidanceRate: number;
  } | null;
  embedding: number[];
}

export interface NearestMatchResult {
  id: string;
  distance: number;
  data: ReferenceVectorRecord;
}

// reference_vectors.json is authored in packages/tools/src/data. Resolve it from several candidate
// roots so this works in: (a) shared dev/test, (b) the tools workspace, (c) the Next standalone
// server where it is traced in via outputFileTracingIncludes (see web/next.config.js).
const REFERENCE_VECTORS_CANDIDATES = [
  path.join(__dirname, '../../../tools/src/data/reference_vectors.json'), // shared/src/utils -> tools/src/data
  path.join(process.cwd(), 'packages/tools/src/data/reference_vectors.json'),
  path.join(process.cwd(), 'tools/src/data/reference_vectors.json'),
  path.join(process.cwd(), '.next/server/reference_vectors.json'),
];
function resolveReferenceVectorsPath(): string | null {
  for (const p of REFERENCE_VECTORS_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

// reference_model.json sits alongside reference_vectors.json; resolve it the same way so the live
// embedding path (vectorizeMatch) can run inside the Next.js API route.
const REFERENCE_MODEL_CANDIDATES = [
  path.join(__dirname, '../../../tools/src/data/reference_model.json'),
  path.join(process.cwd(), 'packages/tools/src/data/reference_model.json'),
  path.join(process.cwd(), '../tools/src/data/reference_model.json'),
  path.join(process.cwd(), 'tools/src/data/reference_model.json'),
  path.join(process.cwd(), '.next/server/reference_model.json'),
];
let cachedModel: IReferenceModel | null = null;
export async function loadReferenceModel(): Promise<IReferenceModel | null> {
  if (cachedModel) return cachedModel;
  for (const p of REFERENCE_MODEL_CANDIDATES) {
    if (fs.existsSync(p)) {
      cachedModel = (await fs.readJson(p)) as IReferenceModel;
      return cachedModel;
    }
  }
  return null;
}

/**
 * Canonicalize a bracket string to a stable slug so the index side and the query side compare
 * equal regardless of representation. The corpus stores raw labels (`2v2`, `3v3`,
 * `Rated Solo Shuffle`) while callers often pass slugs (`solo_shuffle`). Without this, a
 * `solo_shuffle` query silently matched zero `Rated Solo Shuffle` records.
 */
export function normalizeBracket(raw: string | undefined | null): string {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase();
  if (lower.includes('solo')) return 'solo_shuffle';
  if (lower.includes('3v3')) return '3v3';
  if (lower.includes('2v2')) return '2v2';
  return lower.trim();
}

export async function findNearestProMatchesLocal(
  spec: string,
  userVector: number[],
  bracket: string,
  limit = 5,
): Promise<NearestMatchResult[]> {
  const refPath = resolveReferenceVectorsPath();
  if (!refPath) return [];

  const allMatches: ReferenceVectorRecord[] = await fs.readJson(refPath);

  const targetBracket = normalizeBracket(bracket);
  const results = allMatches
    .filter((m) => m.spec === spec && normalizeBracket(m.bracket) === targetBracket)
    .map((m) => {
      const similarity = cosineSimilarity(userVector, m.embedding);
      return {
        id: m.matchId,
        distance: 1 - similarity, // Distance is 1 - similarity
        data: m,
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);

  return results;
}

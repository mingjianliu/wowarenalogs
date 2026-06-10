import { cosineSimilarity } from '@wowarenalogs/shared/src/utils/vectorMath';
import fs from 'fs-extra';
import path from 'path';

export interface NearestMatchResult {
  id: string;
  distance: number;
  data: any;
}

// Local index file path
const REFERENCE_VECTORS_PATH = path.join(__dirname, '../../tools/src/data/reference_vectors.json');

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
  if (!fs.existsSync(REFERENCE_VECTORS_PATH)) {
    return [];
  }

  const allMatches: any[] = await fs.readJson(REFERENCE_VECTORS_PATH);

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

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

export async function findNearestProMatchesLocal(
  spec: string,
  userVector: number[],
  limit = 5,
): Promise<NearestMatchResult[]> {
  if (!fs.existsSync(REFERENCE_VECTORS_PATH)) {
    return [];
  }

  const allMatches: any[] = await fs.readJson(REFERENCE_VECTORS_PATH);

  const results = allMatches
    .filter((m) => m.spec === spec)
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

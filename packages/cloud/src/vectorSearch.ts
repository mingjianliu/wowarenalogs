// packages/cloud/src/vectorSearch.ts
import { FieldValue, Firestore } from '@google-cloud/firestore';

const db = new Firestore();

export interface NearestMatchResult {
  id: string;
  distance: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any; // The raw match data
}

export async function findNearestProMatches(
  spec: string,
  userVector: number[],
  limit = 5,
): Promise<NearestMatchResult[]> {
  const collectionRef = db.collection('reference_matches');

  // Vector search query
  const vectorQuery = collectionRef
    .where('spec', '==', spec) // Pre-filter by spec
    .findNearest('embedding', FieldValue.vector(userVector), {
      limit,
      distanceMeasure: 'COSINE',
      // @ts-expect-error exact spec args
      distanceResultField: 'vector_distance',
    });

  const snapshot = await vectorQuery.get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    distance: doc.get('vector_distance'),
    data: doc.data(),
  }));
}

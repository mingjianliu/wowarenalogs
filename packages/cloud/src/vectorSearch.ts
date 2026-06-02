import { FieldValue, Firestore } from '@google-cloud/firestore';

const db = new Firestore();

export interface NearestMatchResult {
  id: string;
  distance: number;
  data: Record<string, unknown>; // The raw match data
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
    .findNearest({
      vectorField: 'embedding',
      queryVector: FieldValue.vector(userVector),
      limit,
      distanceMeasure: 'COSINE',
      distanceResultField: 'vector_distance',
    });

  const snapshot = await vectorQuery.get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    distance: doc.get('vector_distance'),
    data: doc.data(),
  }));
}

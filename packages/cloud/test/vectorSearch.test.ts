import { findNearestProMatches } from '../src/vectorSearch';
import { Firestore, FieldValue } from '@google-cloud/firestore';

jest.mock('@google-cloud/firestore', () => {
  const mFirestore = {
    collection: jest.fn(),
  };
  return {
    Firestore: jest.fn(() => mFirestore),
    FieldValue: {
      vector: jest.fn((vec) => vec),
    },
  };
});

describe('findNearestProMatches', () => {
  let firestoreMock: any;

  beforeEach(() => {
    firestoreMock = new Firestore();
    jest.clearAllMocks();
  });

  it('should call Firestore with correct vector search parameters and map results', async () => {
    const mGet = jest.fn().mockResolvedValue({
      docs: [
        {
          id: 'doc1',
          get: jest.fn().mockReturnValue(0.123),
          data: jest.fn().mockReturnValue({ spec: 'Frost Mage', otherData: 'foo' }),
        },
        {
          id: 'doc2',
          get: jest.fn().mockReturnValue(0.456),
          data: jest.fn().mockReturnValue({ spec: 'Frost Mage', otherData: 'bar' }),
        },
      ],
    });

    const mFindNearest = jest.fn().mockReturnValue({ get: mGet });
    const mWhere = jest.fn().mockReturnValue({ findNearest: mFindNearest });
    
    firestoreMock.collection.mockReturnValue({
      where: mWhere,
    });

    const userVector = [0.1, 0.2, 0.3];
    const results = await findNearestProMatches('Frost Mage', userVector, 2);

    expect(firestoreMock.collection).toHaveBeenCalledWith('reference_matches');
    expect(mWhere).toHaveBeenCalledWith('spec', '==', 'Frost Mage');
    expect(FieldValue.vector).toHaveBeenCalledWith(userVector);
    expect(mFindNearest).toHaveBeenCalledWith('embedding', userVector, {
      limit: 2,
      distanceMeasure: 'COSINE',
      distanceResultField: 'vector_distance',
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      id: 'doc1',
      distance: 0.123,
      data: { spec: 'Frost Mage', otherData: 'foo' },
    });
    expect(results[1]).toEqual({
      id: 'doc2',
      distance: 0.456,
      data: { spec: 'Frost Mage', otherData: 'bar' },
    });
  });
});

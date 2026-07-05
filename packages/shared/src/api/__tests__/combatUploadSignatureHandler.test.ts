import type { NextApiRequest, NextApiResponse } from 'next';

// Mock firestore and storage
jest.mock('@google-cloud/firestore', () => {
  const mockLimitFn = jest.fn();
  const mockLimit = new Proxy(mockLimitFn, {
    apply(target, thisArg, argumentsList) {
      const result = Reflect.apply(target, thisArg, argumentsList);
      if (result && typeof result.then === 'function') {
        result.get = () => result;
      }
      return result;
    },
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);
      if (typeof val === 'function') {
        return val.bind(target);
      }
      return val;
    },
  });

  const mockWhere = jest.fn().mockReturnValue({ limit: mockLimit });
  const mockCollection = jest.fn().mockReturnValue({ where: mockWhere });

  return {
    Firestore: jest.fn().mockImplementation(() => ({
      collection: mockCollection,
    })),
    _mockCollection: mockCollection,
    _mockWhere: mockWhere,
    _mockLimit: mockLimit,
  };
});

jest.mock('@google-cloud/storage', () => {
  const mockGetSignedUrl = jest.fn();
  return {
    Storage: jest.fn().mockImplementation(() => ({
      bucket: () => ({
        file: () => ({
          getSignedUrl: mockGetSignedUrl,
        }),
      }),
    })),
    _mockGetSignedUrl: mockGetSignedUrl,
  };
});

// Import the handler after the mocks are set up
import { combatUploadSignatureHandler } from '../combatUploadSignatureHandler';

const {
  _mockCollection: mockCollection,
  _mockWhere: mockWhere,
  _mockLimit: mockLimit,
} = jest.requireMock('@google-cloud/firestore');

const { _mockGetSignedUrl: mockGetSignedUrl } = jest.requireMock('@google-cloud/storage');

describe('combatUploadSignatureHandler', () => {
  let req: Partial<NextApiRequest>;
  let res: Partial<NextApiResponse>;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      method: 'GET',
      query: { id: 'test-match-id' },
      headers: {
        'x-goog-meta-ownerid': 'owner-123',
      },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  it('returns url: null if match already exists in Firestore', async () => {
    mockLimit.mockResolvedValueOnce({ empty: false }); // match exists

    await combatUploadSignatureHandler(req as NextApiRequest, res as NextApiResponse);

    expect(mockCollection).toHaveBeenCalledWith('match-stubs-prod');
    expect(mockWhere).toHaveBeenCalledWith('id', '==', 'test-match-id');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      url: null,
      id: 'test-match-id',
      matchExists: true,
    });
  });

  it('generates a signed URL if match does not exist in Firestore', async () => {
    mockLimit.mockResolvedValueOnce({ empty: true }); // match doesn't exist
    mockGetSignedUrl.mockResolvedValueOnce(['http://gcs-signed-url']);

    await combatUploadSignatureHandler(req as NextApiRequest, res as NextApiResponse);

    expect(mockGetSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'write',
        expires: expect.any(Date),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      url: 'http://gcs-signed-url',
      id: 'test-match-id',
      matchExists: false,
    });
  });
});

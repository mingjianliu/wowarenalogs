import { ApolloContext } from '../../types';

// Mock Firestore
const mockGet = jest.fn();
const mockLimit = jest.fn().mockReturnValue({ get: mockGet });
const mockOffset = jest.fn().mockReturnValue({ limit: mockLimit });
const mockOrderBy = jest.fn().mockReturnValue({ offset: mockOffset, limit: mockLimit });
const mockWhere = jest.fn().mockReturnValue({ orderBy: mockOrderBy });
const mockCollection = jest.fn().mockReturnValue({ where: mockWhere });

jest.mock('@google-cloud/firestore', () => {
  return {
    Firestore: jest.fn().mockImplementation(() => ({
      collection: mockCollection,
    })),
  };
});

// Require after mocks are initialized
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { userMatches, matchesWithOwnerId } = require('../matches') as typeof import('../matches');

describe('Matches Resolver Access Control', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({
      docs: [
        {
          data: () => ({ id: 'combat-1', ownerId: 'user-1' }),
        },
      ],
    });
  });

  describe('userMatches', () => {
    it('allows access if owner matches context.user.battlenetId', async () => {
      const context = { user: { battlenetId: 'user-1' } } as unknown as ApolloContext;
      const res = await userMatches({}, { userId: 'user-1', offset: 0, count: 10 }, context);

      expect(res.combats).toHaveLength(1);
      expect(res.combats[0].id).toBe('combat-1');
    });

    it('allows access if target is anonymous', async () => {
      const context = {} as unknown as ApolloContext;
      const res = await userMatches({}, { userId: 'anonymous:guest', offset: 0, count: 10 }, context);

      expect(res.combats).toHaveLength(1);
    });

    it("returns empty if user is authenticated but requests someone else's id", async () => {
      const context = { user: { battlenetId: 'user-2' } } as unknown as ApolloContext;
      const res = await userMatches({}, { userId: 'user-1', offset: 0, count: 10 }, context);

      expect(res.combats).toHaveLength(0);
      expect(mockCollection).not.toHaveBeenCalled();
    });

    it('returns empty if user is unauthenticated and requests an authenticated id', async () => {
      const context = {} as unknown as ApolloContext;
      const res = await userMatches({}, { userId: 'user-1', offset: 0, count: 10 }, context);

      expect(res.combats).toHaveLength(0);
      expect(mockCollection).not.toHaveBeenCalled();
    });
  });

  describe('matchesWithOwnerId', () => {
    it('allows access if owner matches context.user.battlenetId', async () => {
      const context = { user: { battlenetId: 'user-1' } } as unknown as ApolloContext;
      const res = await matchesWithOwnerId({}, { ownerId: 'user-1' }, context);

      expect(res).toHaveLength(1);
    });

    it('allows access if target is anonymous', async () => {
      const context = {} as unknown as ApolloContext;
      const res = await matchesWithOwnerId({}, { ownerId: 'anonymous:guest' }, context);

      expect(res).toHaveLength(1);
    });

    it("returns empty if user is authenticated but requests someone else's id", async () => {
      const context = { user: { battlenetId: 'user-2' } } as unknown as ApolloContext;
      const res = await matchesWithOwnerId({}, { ownerId: 'user-1' }, context);

      expect(res).toHaveLength(0);
    });
  });
});

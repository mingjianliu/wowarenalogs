# Matches Resolver Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Secure the matches GraphQL resolvers (`userMatches` and `matchesWithOwnerId`) so that authenticated users' match histories can only be queried by themselves.

**Architecture:** Gate the returned records on comparing the query parameters with the logged-in user's `context.user.battlenetId` or verifying the target is in the anonymous namespace.

**Tech Stack:** GraphQL Resolvers, Apollo Server, Jest

---

### Task 1: Matches Resolver Unit Tests & Implementation

**Files:**
- Create: `packages/shared/src/graphql-server/resolvers/__tests__/matches.test.ts`
- Modify: `packages/shared/src/graphql-server/resolvers/matches.ts`

- [ ] **Step 1: Create the new unit test file**

Write a test suite in `packages/shared/src/graphql-server/resolvers/__tests__/matches.test.ts` to test resolver access control:
1. Under matched auth context, it fetches and returns matches.
2. Under anonymous target, it fetches and returns matches.
3. Under mismatched auth context, it returns empty array/result.

```typescript
import { userMatches, matchesWithOwnerId } from '../matches';
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

    it('returns empty if user is authenticated but requests someone else\'s id', async () => {
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

    it('returns empty if user is authenticated but requests someone else\'s id', async () => {
      const context = { user: { battlenetId: 'user-2' } } as unknown as ApolloContext;
      const res = await matchesWithOwnerId({}, { ownerId: 'user-1' }, context);

      expect(res).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @wowarenalogs/shared src/graphql-server/resolvers/__tests__/matches.test.ts`
Expected: FAIL (due to missing authorization checks in the resolvers)

- [ ] **Step 3: Modify `matches.ts` to implement gating**

Update `packages/shared/src/graphql-server/resolvers/matches.ts`:
1. Update `matchesWithOwnerId` (add context parameter and verify ownerId):
```typescript
export async function matchesWithOwnerId(
  _parent: unknown,
  args: { ownerId: string },
  context: ApolloContext,
) {
  if (args.ownerId !== context?.user?.battlenetId && !args.ownerId.startsWith('anonymous:')) {
    return [];
  }
  const collectionReference = firestore.collection(matchStubsCollection);
  const matchDocs = await collectionReference
    .where('ownerId', '==', args.ownerId)
    .orderBy('startTime', 'desc')
    .limit(Constants.MAX_RESULTS_PER_QUERY)
    .get();
  const matches = matchDocs.docs.map((d) => firestoreDocToMatchStub(d.data() as ICombatDataStub));
  return matches;
}
```

2. Update `userMatches` (add context parameter and verify userId):
```typescript
export async function userMatches(
  _parent: unknown,
  args: { userId: string; offset: number; count: number },
  context: ApolloContext,
): Promise<CombatQueryResult> {
  if (args.userId !== context?.user?.battlenetId && !args.userId.startsWith('anonymous:')) {
    return {
      combats: [],
      queryLimitReached: false,
    };
  }
  const collectionReference = firestore.collection(matchStubsCollection);
  const matchDocs = await collectionReference
    .where('ownerId', '==', `${args.userId}`)
    .orderBy('startTime', 'desc')
    .offset(args.offset)
    .limit(Math.min(args.count, Constants.MAX_RESULTS_PER_QUERY))
    .get();
  const matches = matchDocs.docs.map((d) => firestoreDocToMatchStub(d.data() as ICombatDataStub));

  return {
    combats: matches,
    queryLimitReached: false,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @wowarenalogs/shared src/graphql-server/resolvers/__tests__/matches.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/graphql-server/resolvers/matches.ts packages/shared/src/graphql-server/resolvers/__tests__/matches.test.ts
git commit -m "fix(security): gate userMatches and matchesWithOwnerId resolvers on authenticated user or anonymous scope"
```

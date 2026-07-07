# Design Spec: Restricting Matches Resolver Access to Owners (B155)

Prevents unauthorized enumeration of authenticated users' match history by gating `userMatches` and `matchesWithOwnerId` resolvers on Apollo context authentication.

## 1. Objectives
- Ensure that authenticated users' match histories can only be retrieved by the users themselves.
- Allow anonymous match histories (starting with `'anonymous:'`) to be queried publicly to support guest/unauthenticated user flows.
- Implement tests to verify access control on `userMatches` and `matchesWithOwnerId`.

## 2. Technical Design

### A. GraphQL Resolvers (`packages/shared/src/graphql-server/resolvers/matches.ts`)
- **`userMatches`:**
  - Verify that `args.userId` is either:
    - Equal to `context.user?.battlenetId` (authenticated user querying their own data)
    - A string starting with `'anonymous:'` (anonymous workspace user)
  - If neither condition is met, return an empty `CombatQueryResult`: `{ combats: [], queryLimitReached: false }`.

- **`matchesWithOwnerId`:**
  - Verify that `args.ownerId` is either:
    - Equal to `context.user?.battlenetId`
    - A string starting with `'anonymous:'`
  - If neither condition is met, return `[]`.

```typescript
// Proposed check in userMatches:
  if (args.userId !== context?.user?.battlenetId && !args.userId.startsWith('anonymous:')) {
    return {
      combats: [],
      queryLimitReached: false,
    };
  }

// Proposed check in matchesWithOwnerId:
  if (args.ownerId !== context?.user?.battlenetId && !args.ownerId.startsWith('anonymous:')) {
    return [];
  }
```

## 3. Verification Plan
- **Unit Tests:**
  - Verify `userMatches` and `matchesWithOwnerId` return data when requesting one's own ID.
  - Verify they return data when requesting an anonymous ID.
  - Verify they return empty when requesting someone else's authenticated ID.

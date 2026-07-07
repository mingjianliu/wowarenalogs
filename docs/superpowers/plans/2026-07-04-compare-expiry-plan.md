# Expired Match Comparative Prompt UI Notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface an explicit "match expired" state in the UI when the Firestore match stub has expired (older than 7 days) instead of failing silently or showing an empty/hidden component.

**Architecture:** 
1. `/api/compare` checks if `logObjectUrl` is missing and returns `{ expired: true }`.
2. The `CombatAIAnalysis` component parses this response and renders a friendly notice.

**Tech Stack:** React (Next.js), GraphQL Server, Jest

---

### Task 1: API Endpoint and Unit Test

**Files:**
- Modify: `packages/web/pages/api/compare.ts`
- Modify: `packages/web/pages/api/__tests__/compare.test.ts`

- [ ] **Step 1: Write a failing test in `compare.test.ts`**

Add a test block to `packages/web/pages/api/__tests__/compare.test.ts` to assert that when Firestore does not contain the match stub, the response body contains `{ expired: true }`.

```typescript
// Add under describe('POST /api/compare') in packages/web/pages/api/__tests__/compare.test.ts:
  describe('expired/missing stub handling', () => {
    it('returns expired: true if matchId cannot be found in Firestore (stub expired)', async () => {
      const { res, status, json } = makeRes();
      const mockGet = jest.fn().mockResolvedValue({ empty: true });
      const mockLimit = jest.fn().mockReturnThis();
      const mockWhere = jest.fn().mockReturnThis();
      const mockCollection = jest.fn().mockReturnValue({ where: mockWhere, limit: mockLimit, get: mockGet });
      
      const { Firestore } = jest.requireMock('@google-cloud/firestore') as { Firestore: jest.Mock };
      Firestore.mockImplementationOnce(() => ({
        collection: mockCollection,
      }));

      await handler(makeReq('POST', { matchId: 'expired-match-id' }), res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ expired: true });
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @wowarenalogs/web pages/api/__tests__/compare.test.ts`
Expected: FAIL (returns empty object `{}` instead of `{ expired: true }`)

- [ ] **Step 3: Modify `packages/web/pages/api/compare.ts`**

Update `packages/web/pages/api/compare.ts:290-360` to return `expired: true` when `verifiedComparison` or `result` fails to load due to missing stub:

```typescript
// In stats variant:
      const verifiedComparison = await withTimeout(buildStatsComparison(matchId, localContext), COMPARE_TIMEOUT_MS);
      if (!verifiedComparison) {
        const hasStub = localContext ? true : await resolveLogObjectUrl(matchId);
        return res.status(200).json({ expired: !hasStub });
      }

// In exemplar variant:
      const result = await withTimeout(buildExemplarComparison(matchId, localContext), COMPARE_TIMEOUT_MS);
      if (!result) {
        const hasStub = localContext ? true : await resolveLogObjectUrl(matchId);
        return res.status(200).json({ expired: !hasStub });
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @wowarenalogs/web pages/api/__tests__/compare.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/pages/api/compare.ts packages/web/pages/api/__tests__/compare.test.ts
git commit -m "fix(compare): return expired: true from compare API when Firestore stub is missing"
```

---

### Task 2: Client UI component update

**Files:**
- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/index.tsx`

- [ ] **Step 1: Modify `index.tsx`**

1. Add `comparisonExpired` state:
```typescript
// Around line 107 in index.tsx:
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonExpired, setComparisonExpired] = useState(false);
```

2. Reset `comparisonExpired` state when starting a fetch:
```typescript
// Around line 180 in index.tsx:
    (async () => {
      try {
        setComparisonLoading(true);
        setComparisonExpired(false);
        setVerified(undefined);
```

3. Parse `expired` property from API response:
```typescript
// Around line 211 in index.tsx:
        const body = (await r.json()) as {
          verifiedComparison?: VerifiedComparison;
          userCrises?: string[];
          proCrises?: string[];
          report?: string;
          expired?: boolean;
        };
        if (combat.id !== combatId) return; // stale guard, mirrors the findings path
        if (body.expired) {
          setComparisonExpired(true);
        } else if (body.verifiedComparison) {
          setComparisonExpired(false);
          setVerified({
            vc: body.verifiedComparison,
            userCrises: body.userCrises ?? [],
            proCrises: body.proCrises ?? [],
            report: body.report,
          });
        }
```

4. Render a user-visible message when `comparisonExpired` is `true`:
```typescript
// Around line 445 in index.tsx:
        {(comparisonLoading || verified || comparisonExpired) && (
          <div className="px-5 mt-8">
            <div className="flex items-center gap-3.5 mb-4">
              <div
                className="shrink-0 w-[34px] h-[34px] rounded-lg flex items-center justify-center"
                style={{
                  color: '#7ee0a0',
                  background: 'rgba(126,224,160,0.08)',
                  border: '1px solid rgba(126,224,160,0.23)',
                }}
              >
                <SparkleIcon size={17} />
              </div>
              <div>
                <span className="text-[10px] font-bold tracking-[0.16em] uppercase text-zinc-600">Part II</span>
                <h2
                  className="text-[18px] font-bold text-zinc-50 leading-tight"
                  style={{ fontFamily: 'var(--ai-font-display)' }}
                >
                  Pro comparison
                </h2>
                <p className="text-[12.5px] text-zinc-500 mt-0.5">
                  Your pacing &amp; crisis decisions vs your full 2300+ cohort on this spec &amp; bracket.
                </p>
              </div>
            </div>
            {comparisonExpired ? (
              <div className="text-[12.5px] text-zinc-400 py-6">
                Pro comparison is not available because the match history record has expired (match stubs are retained for 7 days).
              </div>
            ) : verified ? (
              <ProComparisonVerified
                vc={verified.vc}
                userCrises={verified.userCrises}
                proCrises={verified.proCrises}
                report={verified.report}
              />
            ) : (
              <div className="text-[12.5px] text-zinc-600 py-6">Comparing you to your pro cohort…</div>
            )}
          </div>
        )}
```

- [ ] **Step 2: Run verification**

Run: `npm run typecheck -w @wowarenalogs/shared && npm run lint -w @wowarenalogs/shared`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/index.tsx
git commit -m "feat(ui): display expired message when pro comparison is not available"
```

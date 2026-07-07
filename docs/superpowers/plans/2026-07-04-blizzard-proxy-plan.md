# Blizzard API Proxy Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Secure the Blizzard API proxy handler against SSRF, Host Header Injection, and OAuth credential leaks.

**Architecture:** Validate the requested region (`route[0]`) against a strict whitelist (`us`, `eu`, `apac`, `cn`) before using it in any external request URLs.

**Tech Stack:** Next.js API, Node-fetch, Jest

---

### Task 1: Blizzard Proxy Unit Tests & Implementation

**Files:**
- Create: `packages/shared/src/api/__tests__/blizzardApi.test.ts`
- Modify: `packages/shared/src/api/blizzardApi.ts`

- [ ] **Step 1: Create the new unit test file**

Write a test suite in `packages/shared/src/api/__tests__/blizzardApi.test.ts` that mocks `fetch` and checks:
1. Invalid region payloads (like `evil.com/x`, `kr`, or empty string) return a `400 Bad Request`.
2. Valid region requests (like `us`, `eu`) proceed normally.

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { handler } from '../blizzardApi';

// Mock node-fetch
const mockFetch = jest.fn();
jest.mock('node-fetch', () => {
  return function fetchMock(...args: any[]) {
    return mockFetch(...args);
  };
});

describe('blizzardApi handler', () => {
  let req: Partial<NextApiRequest>;
  let res: Partial<NextApiResponse>;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      method: 'GET',
      query: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  it('returns 400 if route is missing', async () => {
    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns 400 if region is invalid (SSRF injection attempt)', async () => {
    req.query = { route: ['evil.com/x', 'profile', 'index'] };

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid region' });
  });

  it('allows valid regions and calls fetch', async () => {
    req.query = { route: ['us', 'profile', 'index'], namespace: 'static-us', locale: 'en_US' };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('{"data": "ok"}'),
    });

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: 'ok' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @wowarenalogs/shared src/api/__tests__/blizzardApi.test.ts`
Expected: FAIL (on the SSRF injection check)

- [ ] **Step 3: Modify `blizzardApi.ts` to enforce whitelist**

Update `packages/shared/src/api/blizzardApi.ts:56-63`:
```typescript
export async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { route, namespace, locale } = req.query;
  if (!route || !Array.isArray(route) || route.length === 0) {
    res.status(400).end();
    return;
  }
  const region = route[0];
  if (!['us', 'eu', 'apac', 'cn'].includes(region)) {
    res.status(400).json({ error: 'Invalid region' });
    return;
  }
  const key = JSON.stringify(route);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @wowarenalogs/shared src/api/__tests__/blizzardApi.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/api/blizzardApi.ts packages/shared/src/api/__tests__/blizzardApi.test.ts
git commit -m "fix(security): whitelist region in Blizzard API proxy to prevent SSRF and token leaks"
```

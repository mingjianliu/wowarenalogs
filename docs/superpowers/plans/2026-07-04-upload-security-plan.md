# Log Upload Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Secure the log upload pipeline by shortening GCS signed URL expiration, preventing match stub overwrites, and refusing to sign upload URLs for existing matches.

**Architecture:** 
1. The upload signature API checks Firestore before requesting GCS signed URL; skips signing if the match stub exists.
2. Shorten the GCS URL expiry time window from far-future (2500) to 15 minutes.
3. The client uploader skips uploading if the match is reported to already exist.
4. The cloud function ingestion handler uses existence checks before updating/setting Firestore documents to prevent overwrite.

**Tech Stack:** Next.js API, Google Cloud Storage SDK, Firestore SDK, Jest

---

### Task 1: Upload Signature Unit Tests & Implementation

**Files:**
- Create: `packages/shared/src/api/__tests__/combatUploadSignatureHandler.test.ts`
- Modify: `packages/shared/src/api/combatUploadSignatureHandler.ts`

- [ ] **Step 1: Create the new unit test file**

Write a test suite in `packages/shared/src/api/__tests__/combatUploadSignatureHandler.test.ts` to mock Firestore and GCS APIs and assert:
1. When `matchExists` is `true`, the handler does NOT generate a signed URL and returns `url: null`.
2. When `matchExists` is `false`, the handler generates a signed URL with a 15-minute expiration time.

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { combatUploadSignatureHandler } from '../combatUploadSignatureHandler';

// Mock firestore and storage
const mockLimit = jest.fn();
const mockWhere = jest.fn().mockReturnValue({ limit: mockLimit });
const mockCollection = jest.fn().mockReturnValue({ where: mockWhere });
jest.mock('@google-cloud/firestore', () => {
  return {
    Firestore: jest.fn().mockImplementation(() => ({
      collection: mockCollection,
    })),
  };
});

const mockGetSignedUrl = jest.fn();
jest.mock('@google-cloud/storage', () => {
  return {
    Storage: jest.fn().mockImplementation(() => ({
      bucket: () => ({
        file: () => ({
          getSignedUrl: mockGetSignedUrl,
        }),
      }),
    })),
  };
});

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @wowarenalogs/shared src/api/__tests__/combatUploadSignatureHandler.test.ts`
Expected: FAIL (due to missing/unimplemented behavior in the handler)

- [ ] **Step 3: Modify `combatUploadSignatureHandler.ts`**

Update `packages/shared/src/api/combatUploadSignatureHandler.ts`:
1. Check `matchExists` first. If `true`, return `url: null` with `matchExists: true` immediately.
2. Shorten GCS expiration using `Date.now() + 15 * 60 * 1000`.

```typescript
// Replace lines 56-74 in combatUploadSignatureHandler.ts
  const signedUrlConfig: GetSignedUrlConfig = {
    action: 'write',
    expires: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes expiry
    contentType: 'text/plain;charset=UTF-8',
    extensionHeaders,
  };
  _.keys(extensionHeaders).forEach((k) => {
    if (signedUrlConfig.extensionHeaders) {
      signedUrlConfig.extensionHeaders[k] = request.headers[k];
    }
  });

  try {
    const matchExists = await matchExistsAsync(id as string);
    if (matchExists) {
      response.status(200).json({ url: null, id, matchExists: true });
      return;
    }

    const [result] = await Promise.all([
      file.getSignedUrl(signedUrlConfig),
    ]);
    const url = result[0];
    response.status(200).json({ url, id, matchExists: false });
  } catch (err) {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @wowarenalogs/shared src/api/__tests__/combatUploadSignatureHandler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/api/combatUploadSignatureHandler.ts packages/shared/src/api/__tests__/combatUploadSignatureHandler.test.ts
git commit -m "feat(security): gate signed URL generation and shorten GCS expiration to 15 minutes"
```

---

### Task 2: Client Uploader Modification

**Files:**
- Modify: `packages/shared/src/utils/upload.ts`

- [ ] **Step 1: Modify `upload.ts` to skip upload if matchExists is true**

Update `packages/shared/src/utils/upload.ts:56-62`:
```typescript
  const storageSignerResponse = await fetch(`/api/getCombatUploadSignature/${combat.id}`, { headers });
  const jsonResponse = (await storageSignerResponse.json()) as { id: string; url: string | null; matchExists: boolean };
  
  if (jsonResponse.matchExists) {
    console.log('Match already exists on server, skipping upload.');
    return jsonResponse;
  }

  const signedUploadUrl = jsonResponse.url;
  if (!signedUploadUrl) {
    throw new Error('Failed to retrieve upload signature URL');
  }

  console.log('Starting streaming upload...');
  await fetch(signedUploadUrl, {
```

- [ ] **Step 2: Verify shared package test suite still passes**

Run: `npm run test -w @wowarenalogs/shared`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/utils/upload.ts
git commit -m "fix(security): skip GCS streaming upload if matchExists is true"
```

---

### Task 3: Ingestion Overwrite Prevention (Cloud Function)

**Files:**
- Modify: `packages/cloud/src/writeMatchStubHandler.ts`

- [ ] **Step 1: Modify `writeMatchStubHandler.ts`**

Update `packages/cloud/src/writeMatchStubHandler.ts` to check if a stub document already exists in Firestore before writing it.

Around lines 62-68 (arenaMatch stub write):
```typescript
    const stub = createStubDTOFromArenaMatch(arenaMatch, ownerId, logObjectUrl);
    console.time('firestore.doc');
    const document = firestore.doc(`${matchStubsFirestore}/${stub.id}`);
    console.timeEnd('firestore.doc');
    console.log(`writing ${matchStubsFirestore}/${stub.id}`);
    console.time('firestore.set');
    const docSnap = await document.get();
    if (!docSnap.exists) {
      await document.set(instanceToPlain(stub));
    } else {
      console.log(`Document ${stub.id} already exists, skipping stub set.`);
    }
    console.timeEnd('firestore.set');
```

Around lines 92-98 (shuffleMatches stubs write):
```typescript
    const firestorePromises = stubs.map(async ([stub, round]) => {
      console.log(`processing stub ${stub.id}`);
      const document = firestore.doc(`${matchStubsFirestore}/${stub.id}`);
      console.time(`firestore.set-${round.id}`);
      const docSnap = await document.get();
      if (!docSnap.exists) {
        await document.set(instanceToPlain(stub));
      } else {
        console.log(`Document ${stub.id} already exists, skipping stub set.`);
      }
      console.timeEnd(`firestore.set-${round.id}`);
    });
```

- [ ] **Step 2: Verify cloud-functions typecheck and lint**

Run: `npm run typecheck -w @wowarenalogs/cloud-functions && npm run lint -w @wowarenalogs/cloud-functions`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/cloud/src/writeMatchStubHandler.ts
git commit -m "fix(security): prevent overwrite of existing stubs in writeMatchStubHandler"
```

# Design Spec: Hardening Log Upload Security (B152)

Hardens the log upload pipeline to prevent unauthorized file overwrites, metadata manipulation, and permanent signed GCS write URLs.

## 1. Objectives
- Eliminate permanent GCS signed write URLs.
- Prevent overwriting existing log files in Google Cloud Storage.
- Prevent overwriting existing match stubs in Firestore.
- Gracefully bypass uploading client-side when the match already exists on the server.

## 2. Technical Design

### A. Upload Signature Endpoint (`packages/shared/src/api/combatUploadSignatureHandler.ts`)
- **Signed URL Expiry:** Reduce the expiration duration from the far-future `'03-01-2500'` to a strict 15-minute window (`Date.now() + 15 * 60 * 1000`).
- **Signature Prevention on Exists:** 
  1. Await `matchExistsAsync(id)`.
  2. If `true`, immediately return HTTP 200 with `{ url: null, id, matchExists: true }` instead of requesting a signed URL from Google Cloud Storage.
  3. This avoids exposing any writable GCS signature for an already-uploaded match.

### B. Client-side Log Uploader (`packages/shared/src/utils/upload.ts`)
- In `uploadCombatAsync`, retrieve the response from `/api/getCombatUploadSignature/${combat.id}`.
- If `jsonResponse.matchExists === true`:
  - Log `Match already exists on server, skipping upload.`
  - Return `jsonResponse` immediately without executing the `fetch(signedUploadUrl)` PUT request.

### C. Cloud Ingestion Handler (`packages/cloud/src/writeMatchStubHandler.ts`)
- In `handler()`, when writing stubs to Firestore:
  - Check `if (!docSnap.exists)` or catch "document already exists" errors when calling `document.create()` instead of unconditionally calling `document.set()`.
  - To prevent function retries from failing with errors, check if the document exists first:
    ```typescript
    const docSnap = await document.get();
    if (!docSnap.exists) {
      await document.set(instanceToPlain(stub));
    } else {
      console.log(`Document ${stub.id} already exists, skipping stub set.`);
    }
    ```

## 3. Verification Plan
- **Unit Tests:**
  - Verify that `uploadCombatAsync` returns immediately without throwing when `matchExists` is true.
  - Verify that `combatUploadSignatureHandler` returns `url: null` when `matchExists` is true.
- **Manual Verification:**
  - Verify `npm run typecheck` and `npm run lint` pass successfully.

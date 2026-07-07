# Design Spec: Hardening Blizzard API Proxy against SSRF and Credential Exfiltration (B154)

Secures the Blizzard API proxy handler (`packages/shared/src/api/blizzardApi.ts`) against Host Header Injection, SSRF, and credential exfiltration.

## 1. Objectives
- Restrict allowed region/host values to a strict whitelist: `us`, `eu`, `apac`, `cn`.
- Reject requests with invalid region values with HTTP 400.
- Verify through unit tests that SSRF payloads and malicious region requests are rejected.

## 2. Technical Design

### A. Region Whitelisting (`packages/shared/src/api/blizzardApi.ts`)
- In `handler()`, validate that `route[0]` (the region) is a string and belongs to the whitelisted regions set: `['us', 'eu', 'apac', 'cn']`.
- If invalid, return a `400 Bad Request` response.

```typescript
  const region = route[0];
  if (!region || !['us', 'eu', 'apac', 'cn'].includes(region)) {
    res.status(400).json({ error: 'Invalid region' });
    return;
  }
```

## 3. Verification Plan
- **Unit Tests:**
  - Verify that a valid region (e.g. `us`) is processed.
  - Verify that an invalid region (e.g. `evil.com/x`) returns a `400 Bad Request`.

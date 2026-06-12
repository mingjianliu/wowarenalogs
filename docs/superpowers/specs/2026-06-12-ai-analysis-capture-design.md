# AI Analysis Input/Output Capture — Design

**Date:** 2026-06-12
**Status:** Approved, ready for implementation plan
**Goal:** Record every production AI analysis run (input + output) into a durable, queryable
store so real-world usage can be mined for prompt optimization.

---

## 1. Problem & Goal

The AI cooldown analysis feature (`/api/analyze` → Claude) is used by real users on the
deployed site, but those runs are not recorded anywhere. We want a corpus of real
**inputs** (the `matchContext` the prompt actually saw) and **outputs** (the model's
analysis/findings) so we can mine real usage to optimize the system prompts.

**In scope:** capture every _production_ run that hits `/api/analyze`.
**Out of scope:** local/dev runs, live delivery (email/Slack/dashboard), redaction, sampling.

---

## 2. Capture Scope & Gating

- **Production only.** Capture runs only when `process.env.NODE_ENV === 'production'`.
- **Exclude debug runs.** The `debug` request path (local AI test page) is skipped even if it
  somehow reaches a prod server, because it represents developer testing, not real usage.
- Gating lives **server-side** in `/api/analyze`, so it is independent of which client
  (web vs desktop Electron) made the call — only the production server records.

---

## 3. Architecture

Single choke point: **`packages/web/pages/api/analyze.ts`**. Every analysis — production
Combat Report button and local AI test page — already flows through it, and it already holds
the full input and output.

### Components

1. **`packages/shared/src/api/analysisCapture.ts`** (new)
   - Exports `captureAnalysisRun(record: AnalysisCaptureInput): Promise<void>`.
   - Builds the Firestore document, writes it to collection `ai-analysis-logs-prod`.
   - Fetches the raw log from `logObjectUrl` (public GCS read) and snapshots it to
     `gs://<bucket>/ai-analysis-logs/{captureId}.log`; stores the snapshot URL on the doc.
   - Fully **guarded**: every failure is caught, logged via `console.warn`, and swallowed.
     This function must **never throw** into the request path.
   - Reuses the Firestore + Storage client init pattern from
     `packages/shared/src/api/combatUploadSignatureHandler.ts` (same project ids /
     dev-credential handling).

2. **`packages/web/pages/api/analyze.ts`** (edit)
   - After `responseBody` is built and _before_ `res.status(200).json(...)`, if production
     and not a `debug` run, `await captureAnalysisRun(...)` (Approach A, see §4).
   - Read `matchId` and `logObjectUrl` from the request body (new optional fields).

3. **Caller `packages/shared/src/components/CombatReport/CombatAIAnalysis/index.tsx`** (edit, ~line 788)
   - Include `matchId` and `logObjectUrl` in the POST body. The component has the match in
     context; `logObjectUrl` comes from the match stub.
   - The local AI test page (`packages/web/app/(main)/local/ai/page.tsx`) is **not** modified
     — it is dev-only and excluded by gating; it has no `matchId`/`logObjectUrl` anyway
     (parses a dropped file that was never uploaded).

4. **`packages/tools/src/scripts/exportAnalysisCaptures.ts`** (new)
   - `npm run -w @wowarenalogs/tools start:exportAnalysisCaptures`
   - Pages the Firestore `ai-analysis-logs-prod` collection and writes a local JSONL corpus
     (e.g. `packages/tools/analysis-captures/captures.jsonl`).
   - `--with-logs` flag additionally downloads the GCS raw-log snapshots.
   - Mirrors the shape and ergonomics of `collect-benchmarks`.

---

## 4. Capture Timing — Approach A (Synchronous, Guarded)

The analysis already blocks several seconds on the Claude API call, so capture latency is
cheap relative to total request time.

- After Claude returns, `await captureAnalysisRun(...)` **before** sending the HTTP response.
- The Firestore doc write and the GCS raw-log snapshot run **in parallel** inside the helper,
  wrapped in `try/catch` plus a bounded timeout.
- Adds ~0.3–0.7 s to a multi-second action.
- **Guarantees capture regardless of host** (standalone Next.js on GCP can throttle CPU after
  the response is sent, which would make fire-and-forget lossy — rejected for that reason).
- A capture failure (Firestore down, log fetch fails, timeout) is swallowed and logged; the
  user's analysis response is unaffected.

Rejected alternatives:

- **B — Fire-and-forget after response:** zero latency but lossy on throttled hosts.
- **C — Split (await Firestore, fire-and-forget snapshot):** middle ground, but the raw-log
  snapshot is explicitly wanted, so we guarantee it.

---

## 5. Record Schema

### 5.1 Firestore document (`ai-analysis-logs-prod`)

```
captureId            string    unique id for this capture (also the GCS snapshot filename)
timestamp            Date      capture time
model                string    e.g. 'claude-sonnet-4-6'

promptId             string    'FINDINGS_JSON' | 'NEW' | 'SYSTEM' | 'custom'
promptHash           string    sha256(activeSystemPrompt) — exact prompt-version fingerprint
flags                object    { findingsJson?: boolean, useTimelinePrompt?: boolean }

matchId              string?   source match id (re-fetchable for ~7 days, then stub TTL-deletes)
logObjectUrl         string?   original raw-log GCS url from the match stub
rawLogSnapshotUrl    string?   our durable GCS snapshot url; null if snapshot failed

input: {
  matchContext       string    full prompt input, stored as-is (no redaction)
}

output: {
  analysisProse      string    rendered prose (responseBody.analysis)
  findings           object?   parsed structured findings, or null
  parseOk            boolean?  findingsJson parse success
  parseError         string?   parse error message if any
  rawText            string    raw model text
}

usage: {
  inputTokens        number
  outputTokens       number
  durationMs         number
}
```

**Never stored:** the user-supplied `apiKey`.

### 5.2 GCS raw-log snapshot

- Object: `gs://<bucket>/ai-analysis-logs/{captureId}.log`
- Bucket: the same project's bucket used by `combatUploadSignatureHandler`
  (`wowarenalogs-log-files-prod` in prod). Final bucket/prefix confirmed during planning.
- Required because raw arena logs frequently exceed Firestore's **1 MiB** document limit, so
  the raw log cannot live in the Firestore doc.
- Snapshotting it makes the corpus self-contained **past the prod stub's 7-day TTL**
  (`createMatchStub.ts`: `DOC_RETENTION_DAYS = 7`), after which `matchById` / `logObjectUrl`
  go dead.

---

## 6. promptHash — Usage

`promptHash = sha256(activeSystemPrompt)` is the fingerprint that makes the corpus useful for
**before/after prompt comparison**, the core optimization use case.

- `promptId` only identifies the _slot_ (`FINDINGS_JSON`, etc.). When the prompt **text** is
  edited over time, `promptHash` changes, cleanly separating "v1" from "v2" captures.
- **Before/after a prompt edit (natural A/B):** compare `parseOk` rate, mean `outputTokens`,
  `durationMs`, and sampled output quality across hashes.
- **Regression attribution:** if parse failures spike, group by `promptHash` to confirm a
  specific revision caused it.
- **Clean cohorts:** filter the corpus to outputs produced by the prompt version currently in
  prod.

**Hash → prompt text resolution:** we do **not** store the full prompt text on each record
(redundant). The prompt text lives in `packages/shared/src/prompts/analyzeSystemPrompts.ts`;
resolve a hash back to text via git (`git log -S` / blame). The hash is a trivial sha256 over
a few-KB string — negligible cost.

---

## 7. Failure Handling

- `captureAnalysisRun` is fully guarded: all errors caught, `console.warn`-logged, swallowed.
- Capture must **never** alter the analysis response or surface an error to the user.
- A bounded timeout on the parallel Firestore+GCS work prevents a slow/hung dependency from
  noticeably delaying the response.
- Partial capture is acceptable: if the Firestore write succeeds but the snapshot fails,
  `rawLogSnapshotUrl` is `null` and the structured record is still durable.

---

## 8. Export Script

- `npm run -w @wowarenalogs/tools start:exportAnalysisCaptures`
- Pages `ai-analysis-logs-prod`, writes JSONL locally for offline analysis.
- `--with-logs`: also download GCS raw-log snapshots into a local directory.
- Output directory gitignored (like the benchmark `logs/` cache).
- Mirrors `collect-benchmarks` conventions (env-var config, corpus-grows-across-runs feel).

---

## 9. Testing

- Unit-test `analysisCapture.ts`:
  - Builds the correct record from inputs (field mapping, `promptHash` computation, apiKey
    excluded).
  - Gating: no-op when not production / when `debug`.
  - Failure isolation: a thrown Firestore/GCS error is swallowed (function resolves, never
    rejects).
- Mock Firestore + Storage clients (no real cloud calls in tests).
- Run shared tests via `npx tsdx test` (watch for ts-jest compile errors silently disabling
  suites — see project test-suite-health note).

---

## 10. Scope Cuts (YAGNI)

- No email/Slack/digest delivery — pull-on-demand only.
- No dashboard / UI.
- No PII redaction — `matchContext` stored as-is (character names are already public on
  wowarenalogs.com match pages).
- No sampling — capture 100% (AI analysis is a deliberate, low-volume user action).
- No storing the full system prompt text per record — resolve via `promptHash` + git.
- No storing the full raw log in Firestore — GCS snapshot only.

---

## 11. Open Items for Planning

- Confirm the exact GCS bucket + prefix for snapshots (reuse log bucket vs a dedicated one).
- Confirm `logObjectUrl` is available in the `CombatAIAnalysis` component's match context to
  forward to the endpoint.
- Decide the bounded-timeout value for the capture write.
- Optional: a GCS lifecycle rule on the `ai-analysis-logs/` prefix to cap long-term storage.

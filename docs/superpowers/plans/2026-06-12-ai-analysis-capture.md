# AI Analysis Input/Output Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every production `/api/analyze` run (input + output) to a durable Firestore collection plus a GCS snapshot of the raw combat log, so real usage can be mined for prompt optimization.

**Architecture:** A single server-side choke point (`packages/web/pages/api/analyze.ts`) calls a new, fully-guarded `captureAnalysisRun` helper _after_ the Claude response is built and _before_ the HTTP response is sent (Approach A — synchronous, guarded). The helper is split into a **pure** record builder + gating (unit-tested) and a **guarded IO** layer (Firestore write + GCS raw-log snapshot). The client sends only `matchId`; the server resolves `logObjectUrl` from the Firestore match stub during capture. An offline tools script exports the corpus to local JSONL.

**Tech Stack:** TypeScript, Next.js API route, `@google-cloud/firestore`, `@google-cloud/storage`, Node `crypto` (sha256), `ts-jest`/`tsdx` for shared tests, `ts-node` for the tools script.

**Spec:** `docs/superpowers/specs/2026-06-12-ai-analysis-capture-design.md`

---

## Notes for the implementer

- **Pre-existing lint debt:** the repo's husky pre-commit hook runs a repo-wide `npm run lint` that is currently failing on unrelated pre-existing debt (the repo owner is fixing it separately). If a commit is blocked by that hook, commit with `git commit --no-verify` — but only after confirming the failure is the pre-existing debt and not something this task introduced. **Your new code must still be lint-clean** (see the `eslint-disable` notes in each task).
- **Shared package enforces `no-console`.** Mirror `combatUploadSignatureHandler.ts`: put `// eslint-disable-next-line no-console` directly above any `console.warn`.
- **Tools package enforces `no-console` as an error.** Mirror `collectBenchmarks.ts`: put `/* eslint-disable no-console */` at the very top of the new tools script.
- **Run shared tests with tsdx** from the `packages/shared` directory: `npx tsdx test <pattern>`.
- **Firestore rejects `undefined`.** The record builder must coalesce every optional value to `null`, and JSON-sanitize `findings`.

---

## File Structure

| File                                                                     | Status        | Responsibility                                                                      |
| ------------------------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------- |
| `packages/shared/src/api/analysisCapture.ts`                             | Create        | Pure record builder + gating; guarded Firestore/GCS IO (`captureAnalysisRun`).      |
| `packages/shared/src/api/__tests__/analysisCapture.test.ts`              | Create        | Unit tests for the pure builder, gating, and the never-throws guarantee.            |
| `packages/web/pages/api/analyze.ts`                                      | Modify        | Accept `matchId`; call `captureAnalysisRun` (guarded) when production & not debug.  |
| `packages/shared/src/components/CombatReport/CombatAIAnalysis/index.tsx` | Modify (~788) | Send `matchId: combat.id` in the POST body.                                         |
| `packages/tools/src/exportAnalysisCaptures.ts`                           | Create        | Page the Firestore collection → local JSONL; `--with-logs` downloads GCS snapshots. |
| `packages/tools/package.json`                                            | Modify        | Add `start:exportAnalysisCaptures` script.                                          |
| `packages/tools/.gitignore`                                              | Modify/Create | Ignore the local export output dir.                                                 |
| `docs/superpowers/specs/2026-06-12-ai-analysis-capture-design.md`        | Modify        | Reflect server-side `logObjectUrl` resolution (closes §11 item).                    |

---

## Task 1: Pure capture-record builder + gating (TDD)

**Files:**

- Create: `packages/shared/src/api/analysisCapture.ts`
- Test: `packages/shared/src/api/__tests__/analysisCapture.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/api/__tests__/analysisCapture.test.ts`:

```ts
import crypto from 'crypto';

import { buildCaptureRecord, shouldCapture, AnalysisCaptureInput } from '../analysisCapture';

function sampleInput(overrides: Partial<AnalysisCaptureInput> = {}): AnalysisCaptureInput {
  return {
    matchId: 'match-123',
    model: 'claude-sonnet-4-6',
    promptId: 'FINDINGS_JSON',
    activeSystemPrompt: 'SYSTEM PROMPT TEXT',
    flags: { findingsJson: true },
    matchContext: '<match_context>...</match_context>',
    analysisProse: 'You ate a Hammer of Justice.',
    findings: [{ rank: 1, title: 'x' }],
    parseOk: true,
    parseError: undefined,
    rawText: '{"findings":[{"rank":1,"title":"x"}]}',
    inputTokens: 5000,
    outputTokens: 640,
    durationMs: 4200,
    ...overrides,
  };
}

describe('buildCaptureRecord', () => {
  it('maps fields and computes a sha256 promptHash', () => {
    const rec = buildCaptureRecord(sampleInput(), { captureId: 'cap-1', now: new Date('2026-06-12T00:00:00Z') });
    expect(rec.captureId).toBe('cap-1');
    expect(rec.model).toBe('claude-sonnet-4-6');
    expect(rec.promptId).toBe('FINDINGS_JSON');
    expect(rec.promptHash).toBe(crypto.createHash('sha256').update('SYSTEM PROMPT TEXT').digest('hex'));
    expect(rec.matchId).toBe('match-123');
    expect(rec.input.matchContext).toContain('match_context');
    expect(rec.output.analysisProse).toContain('Hammer of Justice');
    expect(rec.output.parseOk).toBe(true);
    expect(rec.usage).toEqual({ inputTokens: 5000, outputTokens: 640, durationMs: 4200 });
  });

  it('never includes an apiKey field anywhere in the record', () => {
    const rec = buildCaptureRecord(sampleInput(), { captureId: 'cap-1' });
    expect(JSON.stringify(rec).toLowerCase()).not.toContain('apikey');
  });

  it('coalesces optional values to null (Firestore-safe) and defaults flags', () => {
    const rec = buildCaptureRecord(
      sampleInput({ matchId: undefined, findings: null, parseOk: undefined, parseError: undefined, flags: {} }),
      { captureId: 'cap-1' },
    );
    expect(rec.matchId).toBeNull();
    expect(rec.logObjectUrl).toBeNull();
    expect(rec.rawLogSnapshotUrl).toBeNull();
    expect(rec.output.findings).toBeNull();
    expect(rec.output.parseOk).toBeNull();
    expect(rec.output.parseError).toBeNull();
    expect(rec.flags).toEqual({ findingsJson: false, useTimelinePrompt: false });
  });
});

describe('shouldCapture', () => {
  it('captures only in production non-debug runs', () => {
    expect(shouldCapture({ nodeEnv: 'production', debug: false })).toBe(true);
    expect(shouldCapture({ nodeEnv: 'production', debug: true })).toBe(false);
    expect(shouldCapture({ nodeEnv: 'development', debug: false })).toBe(false);
    expect(shouldCapture({ nodeEnv: undefined, debug: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/shared && npx tsdx test analysisCapture`
Expected: FAIL — `Cannot find module '../analysisCapture'`.

- [ ] **Step 3: Write the minimal implementation (pure parts only)**

Create `packages/shared/src/api/analysisCapture.ts` with **only** the pure exports for now:

```ts
import crypto from 'crypto';

export type PromptId = 'FINDINGS_JSON' | 'NEW' | 'SYSTEM' | 'custom';

export interface AnalysisCaptureInput {
  matchId?: string;
  model: string;
  promptId: PromptId;
  activeSystemPrompt: string;
  flags: { findingsJson?: boolean; useTimelinePrompt?: boolean };
  matchContext: string;
  analysisProse: string;
  findings: unknown | null;
  parseOk?: boolean;
  parseError?: string;
  rawText: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface AnalysisCaptureDoc {
  captureId: string;
  timestamp: Date;
  model: string;
  promptId: PromptId;
  promptHash: string;
  flags: { findingsJson: boolean; useTimelinePrompt: boolean };
  matchId: string | null;
  logObjectUrl: string | null;
  rawLogSnapshotUrl: string | null;
  input: { matchContext: string };
  output: {
    analysisProse: string;
    findings: unknown | null;
    parseOk: boolean | null;
    parseError: string | null;
    rawText: string;
  };
  usage: { inputTokens: number; outputTokens: number; durationMs: number };
}

/** Pure: build the Firestore document from the input. apiKey is structurally absent. */
export function buildCaptureRecord(
  input: AnalysisCaptureInput,
  opts: { captureId?: string; now?: Date } = {},
): AnalysisCaptureDoc {
  return {
    captureId: opts.captureId ?? crypto.randomUUID(),
    timestamp: opts.now ?? new Date(),
    model: input.model,
    promptId: input.promptId,
    promptHash: crypto.createHash('sha256').update(input.activeSystemPrompt).digest('hex'),
    flags: {
      findingsJson: input.flags.findingsJson ?? false,
      useTimelinePrompt: input.flags.useTimelinePrompt ?? false,
    },
    matchId: input.matchId ?? null,
    logObjectUrl: null, // resolved later in the IO layer
    rawLogSnapshotUrl: null, // set later in the IO layer
    input: { matchContext: input.matchContext },
    output: {
      analysisProse: input.analysisProse,
      findings: input.findings == null ? null : JSON.parse(JSON.stringify(input.findings)),
      parseOk: input.parseOk ?? null,
      parseError: input.parseError ?? null,
      rawText: input.rawText,
    },
    usage: {
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      durationMs: input.durationMs,
    },
  };
}

/** Pure: capture only real production runs (exclude dev and debug/test runs). */
export function shouldCapture(env: { nodeEnv?: string; debug?: boolean }): boolean {
  return env.nodeEnv === 'production' && env.debug !== true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/shared && npx tsdx test analysisCapture`
Expected: PASS — all `buildCaptureRecord` and `shouldCapture` tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/api/analysisCapture.ts packages/shared/src/api/__tests__/analysisCapture.test.ts
git commit -m "feat(capture): pure analysis-capture record builder + gating" || git commit --no-verify -m "feat(capture): pure analysis-capture record builder + gating"
```

---

## Task 2: Guarded Firestore/GCS IO layer (TDD for the never-throws guarantee)

**Files:**

- Modify: `packages/shared/src/api/analysisCapture.ts`
- Test: `packages/shared/src/api/__tests__/analysisCapture.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/api/__tests__/analysisCapture.test.ts`:

```ts
import { captureAnalysisRun } from '../analysisCapture';

describe('captureAnalysisRun (guarded IO)', () => {
  const baseInput = (): AnalysisCaptureInput => ({
    model: 'claude-sonnet-4-6',
    promptId: 'FINDINGS_JSON',
    activeSystemPrompt: 'P',
    flags: { findingsJson: true },
    matchContext: 'ctx',
    analysisProse: 'prose',
    findings: null,
    rawText: 'raw',
    inputTokens: 1,
    outputTokens: 1,
    durationMs: 1,
  });

  it('never rejects even when Firestore throws', async () => {
    const throwingFirestore = {
      collection: () => {
        throw new Error('firestore boom');
      },
    } as unknown as import('@google-cloud/firestore').Firestore;
    await expect(
      captureAnalysisRun(baseInput(), {
        firestore: throwingFirestore,
        storage: {} as never,
        fetchImpl: (async () => ({ ok: false })) as never,
      }),
    ).resolves.toBeUndefined();
  });

  it('writes the Firestore doc and skips the snapshot when there is no matchId', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    const fakeFirestore = {
      collection: () => ({ doc: () => ({ set }) }),
    } as unknown as import('@google-cloud/firestore').Firestore;
    const fetchImpl = jest.fn();
    await captureAnalysisRun(
      { ...baseInput(), matchId: undefined },
      {
        firestore: fakeFirestore,
        storage: {} as never,
        fetchImpl: fetchImpl as never,
      },
    );
    expect(set).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled(); // no matchId → no log resolution/snapshot
    const written = set.mock.calls[0][0];
    expect(written.matchId).toBeNull();
    expect(written.rawLogSnapshotUrl).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/shared && npx tsdx test analysisCapture`
Expected: FAIL — `captureAnalysisRun` is not exported.

- [ ] **Step 3: Write the IO implementation**

Append to `packages/shared/src/api/analysisCapture.ts` (keep the existing pure code above):

```ts
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import fs from 'fs';
import path from 'path';

const isDev = process.env.NODE_ENV === 'development';
const CAPTURE_COLLECTION = 'ai-analysis-logs-prod';
const MATCH_STUBS_COLLECTION = 'match-stubs-prod';
const SNAPSHOT_PREFIX = 'ai-analysis-logs';
const LOG_FILES_BUCKET = isDev ? 'wowarenalogs-public-dev-log-files-prod' : 'wowarenalogs-log-files-prod';
const CAPTURE_TIMEOUT_MS = 4000;

export interface CaptureDeps {
  firestore?: Firestore;
  storage?: Storage;
  fetchImpl?: (url: string) => Promise<{ ok: boolean; text: () => Promise<string> }>;
}

let cachedFirestore: Firestore | null = null;
function defaultFirestore(): Firestore {
  if (!cachedFirestore) {
    cachedFirestore = new Firestore({
      projectId: isDev ? 'wowarenalogs-public-dev' : 'wowarenalogs',
      credentials: isDev
        ? JSON.parse(fs.readFileSync(path.join(process.cwd(), '../cloud/wowarenalogs-public-dev.json'), 'utf8'))
        : undefined,
    });
  }
  return cachedFirestore;
}

let cachedStorage: Storage | null = null;
function defaultStorage(): Storage {
  if (!cachedStorage) {
    cachedStorage = new Storage({
      projectId: isDev ? 'wowarenalogs-public-dev' : 'wowarenalogs',
      credentials: isDev
        ? JSON.parse(fs.readFileSync(path.join(process.cwd(), '../cloud/wowarenalogs-public-dev.json'), 'utf8'))
        : undefined,
    });
  }
  return cachedStorage;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`analysisCapture timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function resolveLogObjectUrl(firestore: Firestore, matchId: string): Promise<string | null> {
  const snap = await firestore.collection(MATCH_STUBS_COLLECTION).where('id', '==', matchId).limit(1).get();
  if (snap.empty) return null;
  const data = snap.docs[0].data() as { logObjectUrl?: string };
  return data.logObjectUrl ?? null;
}

async function snapshotRawLog(
  storage: Storage,
  fetchImpl: NonNullable<CaptureDeps['fetchImpl']>,
  logObjectUrl: string,
  captureId: string,
): Promise<string | null> {
  const res = await fetchImpl(logObjectUrl);
  if (!res.ok) return null;
  const text = await res.text();
  const dest = `${SNAPSHOT_PREFIX}/${captureId}.log`;
  await storage.bucket(LOG_FILES_BUCKET).file(dest).save(text, { contentType: 'text/plain; charset=utf-8' });
  return `gs://${LOG_FILES_BUCKET}/${dest}`;
}

async function captureInner(input: AnalysisCaptureInput, deps: CaptureDeps): Promise<void> {
  const firestore = deps.firestore ?? defaultFirestore();
  const storage = deps.storage ?? defaultStorage();
  const fetchImpl =
    deps.fetchImpl ?? ((url: string) => fetch(url) as unknown as Promise<{ ok: boolean; text: () => Promise<string> }>);

  const record = buildCaptureRecord(input);

  // Best-effort raw-log snapshot: a failure here must not prevent the structured doc write.
  if (record.matchId) {
    try {
      const logObjectUrl = await resolveLogObjectUrl(firestore, record.matchId);
      record.logObjectUrl = logObjectUrl;
      if (logObjectUrl) {
        record.rawLogSnapshotUrl = await snapshotRawLog(storage, fetchImpl, logObjectUrl, record.captureId);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[analysisCapture] raw-log snapshot failed (continuing): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  await firestore.collection(CAPTURE_COLLECTION).doc(record.captureId).set(record);
}

/**
 * Guarded entry point. Records a production analysis run (input + output) to Firestore plus a
 * GCS snapshot of the raw log. Fully guarded + time-bounded: never throws into the request path.
 */
export async function captureAnalysisRun(input: AnalysisCaptureInput, deps: CaptureDeps = {}): Promise<void> {
  try {
    await withTimeout(captureInner(input, deps), CAPTURE_TIMEOUT_MS);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[analysisCapture] capture failed (swallowed): ${err instanceof Error ? err.message : err}`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/shared && npx tsdx test analysisCapture`
Expected: PASS — including the never-rejects and no-matchId-skips-snapshot tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/api/analysisCapture.ts packages/shared/src/api/__tests__/analysisCapture.test.ts
git commit -m "feat(capture): guarded Firestore+GCS IO with log-stub resolution and snapshot" \
  || git commit --no-verify -m "feat(capture): guarded Firestore+GCS IO with log-stub resolution and snapshot"
```

---

## Task 3: Wire capture into the `/api/analyze` endpoint

**Files:**

- Modify: `packages/web/pages/api/analyze.ts`

- [ ] **Step 1: Add the import**

At the top of `packages/web/pages/api/analyze.ts`, below the existing prompt import block, add:

```ts
import { captureAnalysisRun, shouldCapture, PromptId } from '../../../shared/src/api/analysisCapture';
```

- [ ] **Step 2: Accept `matchId` from the request body**

In the `req.body` destructure (currently `matchContext, apiKey: bodyApiKey, systemPrompt, debug, useTimelinePrompt, findingsJson`), add `matchId`, and add `matchId?: string;` to the inline body type:

```ts
const {
  matchContext,
  apiKey: bodyApiKey,
  systemPrompt: bodySystemPrompt,
  debug,
  useTimelinePrompt,
  findingsJson,
  matchId,
} = req.body as {
  matchContext?: string;
  apiKey?: string;
  systemPrompt?: string;
  debug?: boolean;
  useTimelinePrompt?: boolean;
  findingsJson?: boolean;
  matchId?: string;
};
```

- [ ] **Step 3: Call the guarded capture before responding**

Immediately **before** `return res.status(200).json(responseBody);` (after the `if (debug) { ... }` block), insert:

```ts
// Capture production runs (input + output) for prompt optimization.
// Guarded + time-bounded inside captureAnalysisRun; never breaks the response.
if (shouldCapture({ nodeEnv: process.env.NODE_ENV, debug })) {
  const promptId: PromptId =
    activeSystemPrompt === FINDINGS_JSON_SYSTEM_PROMPT
      ? 'FINDINGS_JSON'
      : activeSystemPrompt === NEW_SYSTEM_PROMPT
        ? 'NEW'
        : activeSystemPrompt === SYSTEM_PROMPT
          ? 'SYSTEM'
          : 'custom';
  await captureAnalysisRun({
    matchId,
    model,
    promptId,
    activeSystemPrompt,
    flags: { findingsJson: Boolean(findingsJson), useTimelinePrompt: Boolean(useTimelinePrompt) },
    matchContext,
    analysisProse: typeof responseBody.analysis === 'string' ? responseBody.analysis : '',
    findings: (responseBody.findings as unknown) ?? null,
    parseOk,
    parseError,
    rawText: content.text,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    durationMs,
  });
}
```

- [ ] **Step 4: Typecheck the web package**

Run: `npm run -w @wowarenalogs/web build` (or `npx tsc --noEmit -p packages/web/tsconfig.json` if available)
Expected: compiles with no type errors referencing `analyze.ts`. (`parseOk`/`parseError` are already declared earlier in the handler; `activeSystemPrompt`, `model`, `durationMs`, `content`, `message`, `responseBody` are all in scope at the insertion point.)

- [ ] **Step 5: Commit**

```bash
git add packages/web/pages/api/analyze.ts
git commit -m "feat(capture): record production analyze runs from the API route" \
  || git commit --no-verify -m "feat(capture): record production analyze runs from the API route"
```

---

## Task 4: Send `matchId` from the Combat Report caller

**Files:**

- Modify: `packages/shared/src/components/CombatReport/CombatAIAnalysis/index.tsx` (~line 788)

- [ ] **Step 1: Add `matchId` to the POST body**

In `handleAnalyze`, the fetch body is currently:

```ts
        body: JSON.stringify({ matchContext, apiKey, findingsJson: true }),
```

Change it to include the match id (already available as `combatId` / `combat.id` in this scope):

```ts
        body: JSON.stringify({ matchContext, apiKey, findingsJson: true, matchId: combatId }),
```

- [ ] **Step 2: Typecheck the shared package**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: no new type errors. (`combatId` is the `const combatId = combat.id;` declared at the top of `handleAnalyze`.)

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/components/CombatReport/CombatAIAnalysis/index.tsx
git commit -m "feat(capture): forward matchId from Combat Report AI analysis caller" \
  || git commit --no-verify -m "feat(capture): forward matchId from Combat Report AI analysis caller"
```

---

## Task 5: Export tools script

**Files:**

- Create: `packages/tools/src/exportAnalysisCaptures.ts`
- Modify: `packages/tools/package.json`
- Modify/Create: `packages/tools/.gitignore`

- [ ] **Step 1: Write the export script**

Create `packages/tools/src/exportAnalysisCaptures.ts`:

```ts
/* eslint-disable no-console */
/**
 * exportAnalysisCaptures.ts — pull the production AI-analysis capture corpus locally.
 *
 * Reads the `ai-analysis-logs-prod` Firestore collection (written by /api/analyze) and
 * writes one JSON object per line to a local JSONL file for offline prompt optimization.
 * With --with-logs, also downloads each record's GCS raw-log snapshot.
 *
 * Output (gitignored):
 *   packages/tools/analysis-captures/captures.jsonl
 *   packages/tools/analysis-captures/logs/{captureId}.log   (only with --with-logs)
 *
 * Prerequisites:
 *   Application-default credentials for the `wowarenalogs` project:
 *     gcloud auth application-default login   (or GOOGLE_APPLICATION_CREDENTIALS=<sa-key.json>)
 *
 * Usage:
 *   npm run -w @wowarenalogs/tools start:exportAnalysisCaptures
 *   npm run -w @wowarenalogs/tools start:exportAnalysisCaptures -- --with-logs
 */

import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import fs from 'fs-extra';
import path from 'path';

const COLLECTION = 'ai-analysis-logs-prod';
const OUT_DIR = path.join(__dirname, '..', 'analysis-captures');
const OUT_FILE = path.join(OUT_DIR, 'captures.jsonl');
const LOG_DIR = path.join(OUT_DIR, 'logs');

async function main() {
  const withLogs = process.argv.includes('--with-logs');
  const firestore = new Firestore({ projectId: 'wowarenalogs' });
  const storage = new Storage({ projectId: 'wowarenalogs' });

  await fs.ensureDir(OUT_DIR);
  if (withLogs) await fs.ensureDir(LOG_DIR);

  const snap = await firestore.collection(COLLECTION).orderBy('timestamp', 'asc').get();
  console.log(`Found ${snap.size} capture(s) in ${COLLECTION}`);

  const lines: string[] = [];
  let logCount = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    lines.push(JSON.stringify(data));

    if (withLogs && typeof data.rawLogSnapshotUrl === 'string' && data.rawLogSnapshotUrl.startsWith('gs://')) {
      try {
        const without = data.rawLogSnapshotUrl.replace('gs://', '');
        const bucketName = without.slice(0, without.indexOf('/'));
        const objectPath = without.slice(without.indexOf('/') + 1);
        const dest = path.join(LOG_DIR, `${data.captureId}.log`);
        await storage.bucket(bucketName).file(objectPath).download({ destination: dest });
        logCount += 1;
      } catch (err) {
        console.warn(`  skip log for ${data.captureId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  await fs.writeFile(OUT_FILE, lines.join('\n') + (lines.length ? '\n' : ''));
  console.log(`Wrote ${lines.length} record(s) → ${OUT_FILE}`);
  if (withLogs) console.log(`Downloaded ${logCount} raw-log snapshot(s) → ${LOG_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `packages/tools/package.json`, inside `"scripts"`, add (keep alphabetical-ish ordering consistent with neighbors):

```json
    "start:exportAnalysisCaptures": "ts-node --files ./src/exportAnalysisCaptures.ts",
```

- [ ] **Step 3: Gitignore the export output**

Ensure `packages/tools/.gitignore` contains (create the file if it does not exist; append the line if it does):

```
analysis-captures/
```

- [ ] **Step 4: Verify the script compiles**

Run: `cd packages/tools && npx tsc --noEmit`
Expected: no type errors in `exportAnalysisCaptures.ts`. (Do **not** run the script itself here — it requires prod credentials and live data.)

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/exportAnalysisCaptures.ts packages/tools/package.json packages/tools/.gitignore
git commit -m "feat(capture): exportAnalysisCaptures tools script for the capture corpus" \
  || git commit --no-verify -m "feat(capture): exportAnalysisCaptures tools script for the capture corpus"
```

---

## Task 6: Update the spec to reflect server-side logObjectUrl resolution

**Files:**

- Modify: `docs/superpowers/specs/2026-06-12-ai-analysis-capture-design.md`

- [ ] **Step 1: Edit §3 component 3 (the caller)**

Replace the bullet describing the caller change so it sends only `matchId`:

> 3. **Caller `.../CombatAIAnalysis/index.tsx`** (edit, ~line 788) — include **`matchId` (= `combat.id`)** in the POST body. The server resolves `logObjectUrl` from the Firestore match stub during capture, so the client does not send `logObjectUrl`. The local AI test page is not modified.

- [ ] **Step 2: Edit §11 (Open Items)**

Remove the open item "Confirm `logObjectUrl` is available in the `CombatAIAnalysis` component" and add a resolved note:

> - **Resolved:** `logObjectUrl` is not threaded through React; the server resolves it from the `match-stubs-prod` stub by `matchId` at capture time (within the 7-day TTL window).
> - Capture timeout set to **4000 ms** (overall bound on Firestore + snapshot work).

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-12-ai-analysis-capture-design.md
git commit -m "docs(specs): server-side logObjectUrl resolution; capture timeout 4s" \
  || git commit --no-verify -m "docs(specs): server-side logObjectUrl resolution; capture timeout 4s"
```

---

## Manual verification (after all tasks)

These cannot be unit-tested (require live Firestore/GCS + Anthropic). Do them in a dev/staging context where `NODE_ENV` can be set to `production` against the dev project, or accept that capture is exercised only in prod.

1. **Gating:** with `NODE_ENV !== 'production'`, run the local AI test page → confirm **no** doc appears in `ai-analysis-logs-prod` (gating off).
2. **Happy path (prod):** trigger AI Analysis on a real, uploaded match → confirm a doc lands in `ai-analysis-logs-prod` with the right `matchContext`, `output`, `promptHash`, and a populated `rawLogSnapshotUrl`; confirm the GCS object `ai-analysis-logs/{captureId}.log` exists.
3. **No-stub degradation:** trigger analysis on a match whose stub has expired/never existed → confirm the doc still writes with `logObjectUrl: null` and `rawLogSnapshotUrl: null` (structured record durable).
4. **Failure isolation:** confirm the user-facing analysis still returns normally even if capture fails (temporarily point the bucket name at a nonexistent bucket in a scratch build) — response unaffected, `console.warn` logged.
5. **Export:** run `npm run -w @wowarenalogs/tools start:exportAnalysisCaptures -- --with-logs` → confirm `packages/tools/analysis-captures/captures.jsonl` + downloaded logs.

---

## Self-Review

- **Spec coverage:** §2 gating → Task 1 (`shouldCapture`) + Task 3. §3 components → Tasks 1–5. §4 Approach A (sync guarded before response) → Task 3 insertion point + Task 2 guard/timeout. §5 schema → Task 1 builder + Task 2 IO fields. §6 promptHash → Task 1. §7 failure handling → Task 2 (outer guard + inner snapshot guard + timeout). §8 export → Task 5. §9 testing → Tasks 1–2. §11 open items → Task 6 + Manual verification. ✅
- **Placeholder scan:** none — every code step has complete code; commands have expected output.
- **Type consistency:** `AnalysisCaptureInput`, `AnalysisCaptureDoc`, `PromptId`, `CaptureDeps`, `buildCaptureRecord`, `shouldCapture`, `captureAnalysisRun` names are identical across Tasks 1–4. The `analyze.ts` call site supplies exactly the `AnalysisCaptureInput` fields defined in Task 1.
- **Note:** `fetchImpl` is typed structurally (`{ ok; text() }`) so tests need no DOM/global-fetch types and the real call casts the global `fetch`.

import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

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

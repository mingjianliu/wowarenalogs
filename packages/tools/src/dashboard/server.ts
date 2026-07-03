/* eslint-disable no-console */
/**
 * dashboard/server.ts — framework-free localhost dashboard for the pipeline.
 * Pure module: exports createDashboardServer() with no top-level side effects, so it is safe to
 * import into other entry points (e.g. pipeline-app's main.ts bundles this via esbuild). The
 * standalone CLI runner (`npm run -w @wowarenalogs/tools dashboard`) lives in ./standalone.ts —
 * do NOT add a `require.main === module` self-invocation here: once esbuild bundles this file
 * into another entry point, all module-scope code shares that entry's `require.main`/`module`,
 * so the guard silently evaluates true and the self-invocation runs inside the host process too.
 */
import { spawn } from 'child_process';
import fs from 'fs-extra';
import http from 'http';
import path from 'path';

import { createAdapter } from '../../../windows-agent/src/storage/createAdapter';
import { loadCollectorConfig, syncDirPath } from '../collect/collectorConfig';
import { readRuns } from '../collect/statusFile';
import { nextRunAt, readScheduleInterval } from './schedule';

export interface DashboardServerOptions {
  /** Path to the HTML shell served at `/`. Default: index.html beside server.ts. */
  htmlPath?: string;
  /** First port to try. Default 5178; on EADDRINUSE tries +1 up to +10 before rejecting. */
  basePort?: number;
  /** Extra status merged into `/api/status` under the `local` key. */
  extraStatus?: () => Promise<Record<string, unknown>>;
  /** Handler for `POST /api/run`. Default: spawn launchd/collect-and-analyze.sh (current behavior). */
  onRunNow?: () => Promise<'started' | 'busy'>;
  /** Handler for `POST /api/clear-lock` (spec §8 explicit stale-lock clear). No default — routes
   * 404 when omitted (only wal-pilot, which owns the collector, wires this up). */
  onClearLock?: () => Promise<boolean>;
}

async function buildStatus(): Promise<unknown> {
  const syncDir = syncDirPath();
  let heartbeats: unknown[] = [];
  try {
    const config = loadCollectorConfig();
    const adapter = createAdapter(config.storage);
    const keys = await adapter.list('status/');
    heartbeats = await Promise.all(keys.map(async (k) => JSON.parse((await adapter.get(k)).toString())));
  } catch (e) {
    console.warn(`[dashboard] heartbeat read failed: ${e instanceof Error ? e.message : e}`);
  }
  const statusPath = path.join(syncDir, 'status.json');
  const collector = fs.pathExistsSync(statusPath) ? fs.readJsonSync(statusPath) : null;
  const runs = readRuns(syncDir, 20);
  const intervalSeconds = readScheduleInterval();
  const lastRunAt = runs.length > 0 ? runs[runs.length - 1].finishedAt : null;
  const lockPath = path.join(syncDir, 'run.lock');
  let lockAgeMs: number | null = null;
  try {
    lockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    lockAgeMs = null; // no lock held
  }
  return {
    heartbeats,
    collector,
    runs,
    schedule: { intervalSeconds, lastRunAt, nextRunAt: nextRunAt(lastRunAt, intervalSeconds) },
    running: fs.pathExistsSync(lockPath),
    lockAgeMs,
    reportsDir: path.resolve(__dirname, '../../local-batch/reports'),
  };
}

async function defaultRunNow(): Promise<'started' | 'busy'> {
  if (fs.pathExistsSync(path.join(syncDirPath(), 'run.lock'))) {
    return 'busy';
  }
  const script = path.resolve(__dirname, '../../launchd/collect-and-analyze.sh');
  const child = spawn('bash', [script], { detached: true, stdio: 'ignore' });
  child.unref();
  return 'started';
}

export function createDashboardServer(opts: DashboardServerOptions = {}): Promise<{ port: number; close(): void }> {
  const page = fs.readFileSync(opts.htmlPath ?? path.join(__dirname, 'index.html'), 'utf-8');
  const onRunNow = opts.onRunNow ?? defaultRunNow;
  const basePort = opts.basePort ?? 5178;

  return new Promise((resolve, reject) => {
    let port = basePort;
    let attempt = 0;

    const server = http.createServer((req, res) => {
      void (async () => {
        if (req.method === 'GET' && req.url === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
        } else if (req.method === 'GET' && req.url === '/api/status') {
          const body = JSON.stringify({
            ...((await buildStatus()) as Record<string, unknown>),
            ...(opts.extraStatus ? { local: await opts.extraStatus() } : {}),
          });
          res.writeHead(200, { 'content-type': 'application/json' }).end(body);
        } else if (req.method === 'POST' && req.url === '/api/run') {
          const origin = req.headers.origin;
          if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
            res
              .writeHead(403, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'forbidden origin' }));
            return;
          }
          const result = await onRunNow();
          if (result === 'busy') {
            res
              .writeHead(409, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'already running' }));
            return;
          }
          res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ started: true }));
        } else if (req.method === 'POST' && req.url === '/api/clear-lock') {
          const origin = req.headers.origin;
          if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
            res
              .writeHead(403, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'forbidden origin' }));
            return;
          }
          if (!opts.onClearLock) {
            res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
            return;
          }
          const cleared = await opts.onClearLock();
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ cleared }));
        } else {
          res.writeHead(404).end('not found');
        }
      })().catch((e) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: String(e) }));
      });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempt < 10) {
        attempt += 1;
        port = basePort + attempt;
        server.listen(port, '127.0.0.1');
      } else {
        reject(err);
      }
    });

    // 127.0.0.1 only — never expose the Run button beyond this machine.
    server.listen(port, '127.0.0.1', () => {
      resolve({ port, close: () => server.close() });
    });
  });
}

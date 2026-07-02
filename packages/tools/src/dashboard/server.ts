/* eslint-disable no-console */
/**
 * dashboard/server.ts — framework-free localhost dashboard for the pipeline.
 * Usage: npm run -w @wowarenalogs/tools dashboard   →  http://127.0.0.1:5178
 */
import { spawn } from 'child_process';
import fs from 'fs-extra';
import http from 'http';
import path from 'path';

import { createAdapter } from '../../../windows-agent/src/storage/createAdapter';
import { loadCollectorConfig, syncDirPath } from '../collect/collectorConfig';
import { readRuns } from '../collect/statusFile';
import { nextRunAt, readScheduleInterval } from './schedule';

const PORT = 5178;
const PAGE = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');

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
  return {
    heartbeats,
    collector,
    runs,
    schedule: { intervalSeconds, lastRunAt, nextRunAt: nextRunAt(lastRunAt, intervalSeconds) },
    running: fs.pathExistsSync(path.join(syncDir, 'run.lock')),
    reportsDir: path.resolve(__dirname, '../../local-batch/reports'),
  };
}

const server = http.createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    } else if (req.method === 'GET' && req.url === '/api/status') {
      const body = JSON.stringify(await buildStatus());
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    } else if (req.method === 'POST' && req.url === '/api/run') {
      if (fs.pathExistsSync(path.join(syncDirPath(), 'run.lock'))) {
        res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'already running' }));
        return;
      }
      const script = path.resolve(__dirname, '../../launchd/collect-and-analyze.sh');
      const child = spawn('bash', [script], { detached: true, stdio: 'ignore' });
      child.unref();
      res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ started: true }));
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

// 127.0.0.1 only — never expose the Run button beyond this machine.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dashboard] http://127.0.0.1:${PORT}`);
});

/* eslint-disable no-console */
/**
 * collectAndAnalyze.ts — scheduled pipeline entrypoint:
 *   collect segments → reconstruct logs → run localBatchAnalysis (LOG_DIR=<syncDir>/logs)
 * Writes status.json (live) and one runs.jsonl record per run for the dashboard.
 *
 * Usage: npm run -w @wowarenalogs/tools start:collectAndAnalyze
 */
import { spawnSync } from 'child_process';
import path from 'path';

import { loadCollectorConfig } from './collect/collectorConfig';
import { appendRun, writeStatus } from './collect/statusFile';
import { CollectStats, runCollection } from './collectLogs';

async function main(): Promise<void> {
  const config = loadCollectorConfig();
  const startedAt = new Date().toISOString();
  let stats: CollectStats = { segmentsFetched: 0, bytesAppended: 0, filesUpdated: [], gaps: [] };
  let analysisExitCode: number | null = null;
  let error: string | null = null;

  try {
    writeStatus(config.syncDir, {
      phase: 'collecting',
      updatedAt: new Date().toISOString(),
      detail: 'listing segments',
    });
    stats = await runCollection(config);

    writeStatus(config.syncDir, {
      phase: 'analyzing',
      updatedAt: new Date().toISOString(),
      detail: `analyzing logs in ${path.join(config.syncDir, 'logs')}`,
    });
    // Child process so the analysis keeps its own lifecycle/output; inherits
    // stdio so launchd's log file captures per-match progress.
    const result = spawnSync('npm', ['run', 'start:localBatchAnalysis'], {
      cwd: __dirname.replace(/\/src$/, ''), // packages/tools
      env: { ...process.env, LOG_DIR: path.join(config.syncDir, 'logs') },
      stdio: 'inherit',
    });
    analysisExitCode = result.status;
    if (result.status !== 0) error = `localBatchAnalysis exited ${result.status}`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.error(`[collectAndAnalyze] ${error}`);
  } finally {
    writeStatus(config.syncDir, { phase: 'idle', updatedAt: new Date().toISOString(), detail: error ?? 'ok' });
    appendRun(config.syncDir, {
      startedAt,
      finishedAt: new Date().toISOString(),
      segmentsFetched: stats.segmentsFetched,
      bytesAppended: stats.bytesAppended,
      filesUpdated: stats.filesUpdated,
      gaps: stats.gaps,
      analysisExitCode,
      error,
    });
  }
  if (error) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

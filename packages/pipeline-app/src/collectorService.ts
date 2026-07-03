import { mkdirSync, rmdirSync } from 'fs';
import path from 'path';

import { CollectorConfig } from '../../tools/src/collect/collectorConfig';
import { appendRun, writeStatus } from '../../tools/src/collect/statusFile';
import { CollectStats, runCollection } from '../../tools/src/collectLogs';
import { runBatchAnalysis } from '../../tools/src/localBatchAnalysis';
import { cleanupAppliedSegments } from './cleanup';

export type CollectorPhase = 'idle' | 'collecting' | 'analyzing' | 'cleaning';

export class CollectorService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private opts: {
      collectorConfig: CollectorConfig;
      scheduleHours: number;
      cleanupAfterDays: number;
      onPhase: (phase: CollectorPhase, detail: string) => void;
      runners?: {
        collect?: typeof runCollection;
        analyze?: typeof runBatchAnalysis;
        cleanup?: typeof cleanupAppliedSegments;
      };
    },
  ) {}

  lockPath(): string {
    return path.join(this.opts.collectorConfig.syncDir, 'run.lock');
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.runNow();
    }, this.opts.scheduleHours * 3_600_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runNow(): Promise<'completed' | 'busy' | 'failed'> {
    const { collectorConfig, cleanupAfterDays, onPhase } = this.opts;
    const collect = this.opts.runners?.collect ?? runCollection;
    const analyze = this.opts.runners?.analyze ?? runBatchAnalysis;
    const cleanup = this.opts.runners?.cleanup ?? cleanupAppliedSegments;
    const { syncDir, storage } = collectorConfig;
    const logDir = path.join(syncDir, 'logs');

    try {
      mkdirSync(this.lockPath());
    } catch {
      return 'busy'; // CLI run or another trigger holds the lock — same convention as collect-and-analyze.sh
    }

    const startedAt = new Date().toISOString();
    let stats: CollectStats = { segmentsFetched: 0, bytesAppended: 0, filesUpdated: [], gaps: [] };
    let analysisExitCode: number | null = null;
    let error: string | null = null;
    const setPhase = (phase: CollectorPhase, detail: string) => {
      writeStatus(syncDir, {
        phase: phase === 'cleaning' ? 'idle' : phase,
        updatedAt: new Date().toISOString(),
        detail,
      });
      onPhase(phase, detail);
    };

    try {
      setPhase('collecting', 'listing segments');
      stats = await collect(collectorConfig);
      setPhase('analyzing', `analyzing logs in ${logDir}`);
      try {
        await analyze({ logDir });
        analysisExitCode = 0;
      } catch (e) {
        analysisExitCode = 1;
        error = e instanceof Error ? e.message : String(e);
      }
      if (!error && storage.provider === 'localDir' && cleanupAfterDays > 0) {
        setPhase('cleaning', 'removing applied segments');
        await cleanup({ syncFolderRoot: storage.directory, logsDir: logDir, cleanupAfterDays });
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      writeStatus(syncDir, { phase: 'idle', updatedAt: new Date().toISOString(), detail: error ?? 'ok' });
      onPhase('idle', error ?? 'ok');
      appendRun(syncDir, {
        startedAt,
        finishedAt: new Date().toISOString(),
        segmentsFetched: stats.segmentsFetched,
        bytesAppended: stats.bytesAppended,
        filesUpdated: stats.filesUpdated,
        gaps: stats.gaps,
        analysisExitCode,
        error,
      });
      try {
        rmdirSync(this.lockPath());
      } catch {
        /* already gone */
      }
    }
    return error ? 'failed' : 'completed';
  }
}

import { mkdirSync, rmdirSync, statSync } from 'fs';
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
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runNow().catch(() => undefined);
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

    const STALE_LOCK_MS = 2 * 3_600_000; // spec §8: locks older than 2h are stale
    try {
      mkdirSync(this.lockPath());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        // A crash can orphan the lock; treat >2h-old locks as stale and take over.
        try {
          if (Date.now() - statSync(this.lockPath()).mtimeMs > STALE_LOCK_MS) {
            rmdirSync(this.lockPath());
            mkdirSync(this.lockPath());
          } else {
            return 'busy';
          }
        } catch {
          return 'busy';
        }
      } else {
        // syncDir may not exist yet (first run before provisioning): create + retry once.
        try {
          mkdirSync(syncDir, { recursive: true });
          mkdirSync(this.lockPath());
        } catch (e2) {
          console.error(`[collector] cannot acquire lock: ${e2 instanceof Error ? e2.message : String(e2)}`);
          return 'failed';
        }
      }
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
      try {
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
      } catch (telemetryErr) {
        // Telemetry is best-effort; it must never block lock release.
        error = error ?? (telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr));
        console.error(`[collector] failed to record run: ${error}`);
      } finally {
        try {
          rmdirSync(this.lockPath());
        } catch {
          /* already gone or parent unwritable — stale-lock takeover recovers within 2h */
        }
      }
    }
    return error ? 'failed' : 'completed';
  }
}

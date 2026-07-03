import { mkdirSync, readdirSync, rmdirSync } from 'fs';
import path from 'path';

import { CollectorConfig } from '../../tools/src/collect/collectorConfig';
import { appendRun, writeStatus } from '../../tools/src/collect/statusFile';
import { CollectStats, runCollection } from '../../tools/src/collectLogs';
import { runBatchAnalysis } from '../../tools/src/localBatchAnalysis';
import { AnalysisBackend, resolveAnalysisBackend } from '../../tools/src/utils/claudeCli';
import { cleanupAppliedSegments } from './cleanup';

export type CollectorPhase = 'idle' | 'collecting' | 'analyzing' | 'cleaning';

export class CollectorService {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** True while this instance holds run.lock (between a successful mkdir and its rmdir). Lets
   * main.ts release the lock on quit-mid-run without stepping on a lock some *other* process
   * (another CLI invocation, an orphaned crash) legitimately owns. */
  private holdsLock = false;

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
        resolveBackend?: () => AnalysisBackend;
      };
    },
  ) {}

  lockPath(): string {
    return path.join(this.opts.collectorConfig.syncDir, 'run.lock');
  }

  /** Explicit human/quit-triggered release — only acts if this instance is the current lock
   * owner. Errors are swallowed: this is best-effort cleanup, never a source of new failures. */
  releaseLockIfOwned(): void {
    if (!this.holdsLock) return;
    try {
      rmdirSync(this.lockPath());
    } catch {
      /* already gone or parent unwritable */
    }
    this.holdsLock = false;
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
    const resolveBackend = this.opts.runners?.resolveBackend ?? resolveAnalysisBackend;
    const { syncDir, storage } = collectorConfig;
    const logDir = path.join(syncDir, 'logs');

    try {
      mkdirSync(this.lockPath());
      this.holdsLock = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        // Held by this service, a CLI run, or an orphaned crash. Never take
        // over automatically — a long backlog run can legitimately exceed any
        // TTL and mtime says nothing about liveness. Stale locks are surfaced
        // in the dashboard for an explicit human clear (spec §8).
        return 'busy';
      } else {
        // syncDir may not exist yet (first run before provisioning): create + retry once.
        try {
          mkdirSync(syncDir, { recursive: true });
          mkdirSync(this.lockPath());
          this.holdsLock = true;
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

      // Fresh-install/no-backlog-yet runs (nothing to analyze) are a successful no-op, not a
      // failure — don't even probe for an analysis backend.
      let hasLogs = false;
      try {
        hasLogs = readdirSync(logDir).some((f) => /^WoWCombatLog.*\.txt$/i.test(f));
      } catch {
        hasLogs = false; // logDir doesn't exist yet
      }

      if (!hasLogs) {
        setPhase('analyzing', 'no logs yet');
        analysisExitCode = 0;
      } else {
        setPhase('analyzing', `analyzing logs in ${logDir}`);
        let backend: AnalysisBackend;
        try {
          backend = resolveBackend();
        } catch {
          // resolveAnalysisBackend() throws for a forced-but-unavailable ANALYSIS_BACKEND
          // (e.g. ANALYSIS_BACKEND=cli with no `claude` on PATH) — same outcome as 'none'.
          backend = 'none';
        }
        if (backend === 'none') {
          analysisExitCode = 1;
          error = 'No analysis backend: claude CLI not on PATH and no ANTHROPIC_API_KEY';
        } else {
          try {
            await analyze({ logDir, outputDir: path.join(syncDir, 'analysis') });
            analysisExitCode = 0;
          } catch (e) {
            analysisExitCode = 1;
            error = e instanceof Error ? e.message : String(e);
          }
        }
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
          /* already gone (e.g. released by releaseLockIfOwned on quit) or parent unwritable —
           * the dashboard surfaces a lingering lock for a human clear */
        }
        this.holdsLock = false;
      }
    }
    return error ? 'failed' : 'completed';
  }
}

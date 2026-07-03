import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { readRuns } from '../../../tools/src/collect/statusFile';
import { AnalysisBackend } from '../../../tools/src/utils/claudeCli';
import { CollectorService } from '../collectorService';

function setup(
  overrides: Partial<{
    collectFails: boolean;
    analyzeFails: boolean;
    /** Default true: seeds a WoWCombatLog*.txt so the pre-existing collect→analyze→cleanup tests
     * keep exercising the full pipeline. Set false to test the no-logs-yet no-op path. */
    seedLogs: boolean;
    /** Default () => 'cli': avoids every test probing the real `claude` CLI / PATH. */
    resolveBackend: () => AnalysisBackend;
  }> = {},
) {
  const syncDir = mkdtempSync(join(tmpdir(), 'pilot-sync-'));
  const drive = mkdtempSync(join(tmpdir(), 'pilot-drive-'));
  const logDir = join(syncDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  if (overrides.seedLogs !== false) {
    writeFileSync(join(logDir, 'WoWCombatLog-test.txt'), 'test log content');
  }
  const phases: string[] = [];
  const calls = { collect: 0, analyze: 0, cleanup: 0 };
  const svc = new CollectorService({
    collectorConfig: { storage: { provider: 'localDir', directory: drive }, syncDir },
    scheduleHours: 6,
    cleanupAfterDays: 14,
    onPhase: (p, d) => phases.push(`${p}:${d.slice(0, 20)}`),
    runners: {
      collect: async () => {
        calls.collect += 1;
        if (overrides.collectFails) throw new Error('collect boom');
        return { segmentsFetched: 2, bytesAppended: 10, filesUpdated: ['a'], gaps: [] };
      },
      analyze: async () => {
        calls.analyze += 1;
        if (overrides.analyzeFails) throw new Error('analyze boom');
        return { processed: 1, skipped: 0, failed: 0, unparseable: 0 };
      },
      cleanup: async () => {
        calls.cleanup += 1;
        return { deleted: [], kept: 0 };
      },
      resolveBackend: overrides.resolveBackend ?? (() => 'cli'),
    },
  });
  return { svc, syncDir, phases, calls };
}

describe('CollectorService.runNow', () => {
  it('runs collect → analyze → cleanup and records a successful RunRecord', async () => {
    const { svc, syncDir, calls } = setup();
    expect(await svc.runNow()).toBe('completed');
    expect(calls).toEqual({ collect: 1, analyze: 1, cleanup: 1 });
    const runs = readRuns(syncDir, 5);
    expect(runs).toHaveLength(1);
    expect(runs[0].analysisExitCode).toBe(0);
    expect(runs[0].segmentsFetched).toBe(2);
    expect(runs[0].error).toBeNull();
  });

  it('returns busy without state writes when the lock is held', async () => {
    const { svc, syncDir } = setup();
    mkdirSync(svc.lockPath());
    expect(await svc.runNow()).toBe('busy');
    expect(readRuns(syncDir, 5)).toHaveLength(0);
  });

  it('records failures and releases the lock', async () => {
    const { svc, syncDir } = setup({ analyzeFails: true });
    expect(await svc.runNow()).toBe('failed');
    const runs = readRuns(syncDir, 5);
    expect(runs[0].analysisExitCode).toBe(1);
    expect(runs[0].error).toMatch(/analyze boom/);
    expect(await svc.runNow()).toBe('failed'); // lock was released → runs again
    expect(readRuns(syncDir, 5)).toHaveLength(2);
  });

  it('collect failure: returns failed, records the error with null analysisExitCode, releases the lock', async () => {
    const { svc, syncDir, calls } = setup({ collectFails: true });
    expect(await svc.runNow()).toBe('failed');
    expect(calls.analyze).toBe(0);
    const runs = readRuns(syncDir, 5);
    expect(runs[0].error).toMatch(/collect boom/);
    expect(runs[0].analysisExitCode).toBeNull();
    expect(existsSync(join(syncDir, 'run.lock'))).toBe(false);
  });

  it('non-EEXIST lock failure is a loud failed, not silent busy', async () => {
    const fileAsDir = join(mkdtempSync(join(tmpdir(), 'pilot-file-')), 'plainfile');
    writeFileSync(fileAsDir, 'x');
    const svc = new CollectorService({
      collectorConfig: {
        storage: { provider: 'localDir', directory: mkdtempSync(join(tmpdir(), 'pilot-d-')) },
        syncDir: join(fileAsDir, 'sub'),
      },
      scheduleHours: 6,
      cleanupAfterDays: 14,
      onPhase: () => undefined,
      runners: {
        collect: async () => ({ segmentsFetched: 0, bytesAppended: 0, filesUpdated: [], gaps: [] }),
        analyze: async () => ({ processed: 0, skipped: 0, failed: 0, unparseable: 0 }),
        cleanup: async () => ({ deleted: [], kept: 0 }),
        resolveBackend: () => 'cli',
      },
    });
    await expect(svc.runNow()).resolves.toBe('failed'); // resolves — never rejects
  });

  it('never auto-clears an old lock — stale locks are a human decision (spec §8)', async () => {
    const { svc, syncDir } = setup();
    mkdirSync(svc.lockPath());
    const old = new Date(Date.now() - 3 * 3_600_000);
    utimesSync(svc.lockPath(), old, old);
    expect(await svc.runNow()).toBe('busy');
    expect(readRuns(syncDir, 5)).toHaveLength(0);
  });

  it('no logs yet: skips analysis as a successful no-op, not a failure', async () => {
    const { svc, syncDir, calls } = setup({ seedLogs: false });
    expect(await svc.runNow()).toBe('completed');
    expect(calls.analyze).toBe(0);
    const runs = readRuns(syncDir, 5);
    expect(runs).toHaveLength(1);
    expect(runs[0].analysisExitCode).toBe(0);
    expect(runs[0].error).toBeNull();
  });

  it('no analysis backend available: treated as a failure, analyze is never invoked', async () => {
    const { svc, syncDir, calls } = setup({ resolveBackend: () => 'none' });
    expect(await svc.runNow()).toBe('failed');
    expect(calls.analyze).toBe(0);
    const runs = readRuns(syncDir, 5);
    expect(runs[0].analysisExitCode).toBe(1);
    expect(runs[0].error).toMatch(/No analysis backend/);
  });

  it('resolveBackend throwing (forced-but-unavailable ANALYSIS_BACKEND) maps to the same failure path', async () => {
    const { svc, syncDir, calls } = setup({
      resolveBackend: () => {
        throw new Error('ANALYSIS_BACKEND=cli but the `claude` CLI was not found on PATH');
      },
    });
    expect(await svc.runNow()).toBe('failed');
    expect(calls.analyze).toBe(0);
    const runs = readRuns(syncDir, 5);
    expect(runs[0].analysisExitCode).toBe(1);
    expect(runs[0].error).toMatch(/No analysis backend/);
  });
});

describe('CollectorService.releaseLockIfOwned', () => {
  it('does not touch a lock this instance does not own', () => {
    const { svc } = setup();
    mkdirSync(svc.lockPath()); // simulate another process (or an orphaned crash) holding the lock
    svc.releaseLockIfOwned();
    expect(existsSync(svc.lockPath())).toBe(true);
  });

  it('releases a lock this instance holds (simulates app quit firing mid-run)', async () => {
    const syncDir = mkdtempSync(join(tmpdir(), 'pilot-sync-'));
    const drive = mkdtempSync(join(tmpdir(), 'pilot-drive-'));
    const logDir = join(syncDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'WoWCombatLog-test.txt'), 'x');

    // `svc` is referenced inside the `analyze` closure below, which only runs once construction
    // (and this assignment) has completed.
    const svc: CollectorService = new CollectorService({
      collectorConfig: { storage: { provider: 'localDir', directory: drive }, syncDir },
      scheduleHours: 6,
      cleanupAfterDays: 14,
      onPhase: () => undefined,
      runners: {
        collect: async () => ({ segmentsFetched: 0, bytesAppended: 0, filesUpdated: [], gaps: [] }),
        analyze: async () => {
          // At this point in the real run.lock lifecycle this instance holds the lock — simulate
          // main.ts's `before-quit` firing right here.
          expect(existsSync(svc.lockPath())).toBe(true);
          svc.releaseLockIfOwned();
          expect(existsSync(svc.lockPath())).toBe(false);
          return { processed: 0, skipped: 0, failed: 0, unparseable: 0 };
        },
        cleanup: async () => ({ deleted: [], kept: 0 }),
        resolveBackend: () => 'cli',
      },
    });

    // runNow()'s own finally-block rmdir becomes a swallowed no-op — the lock is already gone.
    await expect(svc.runNow()).resolves.toBe('completed');
  });
});

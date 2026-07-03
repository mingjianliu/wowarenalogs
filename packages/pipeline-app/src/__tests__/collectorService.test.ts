import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { readRuns } from '../../../tools/src/collect/statusFile';
import { CollectorService } from '../collectorService';

function setup(overrides: Partial<{ collectFails: boolean; analyzeFails: boolean }> = {}) {
  const syncDir = mkdtempSync(join(tmpdir(), 'pilot-sync-'));
  const drive = mkdtempSync(join(tmpdir(), 'pilot-drive-'));
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
      },
    });
    await expect(svc.runNow()).resolves.toBe('failed'); // resolves — never rejects
  });

  it('takes over a stale (>2h) lock instead of reporting busy forever', async () => {
    const { svc, syncDir } = setup();
    mkdirSync(svc.lockPath());
    const old = new Date(Date.now() - 3 * 3_600_000);
    utimesSync(svc.lockPath(), old, old);
    expect(await svc.runNow()).toBe('completed');
    expect(readRuns(syncDir, 5)).toHaveLength(1);
  });
});

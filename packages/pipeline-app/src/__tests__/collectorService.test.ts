import { mkdirSync, mkdtempSync } from 'fs';
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
});

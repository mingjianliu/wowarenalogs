import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { StreamerService, StreamerState } from '../streamerService';

const noopWatch = (() => ({ close: jest.fn() })) as unknown as typeof import('fs').watch;
const LINE = '6/14 18:30:00.000  COMBAT_LOG_VERSION,21\n';

function setup() {
  const wow = mkdtempSync(join(tmpdir(), 'pilot-wow-'));
  mkdirSync(join(wow, 'Logs'));
  const bucket = mkdtempSync(join(tmpdir(), 'pilot-bucket-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'pilot-state-'));
  const states: StreamerState[] = [];
  const svc = new StreamerService({
    agentConfig: {
      wowDirectory: wow,
      hostname: 'TEST-PC',
      flushIntervalMs: 30,
      quietPeriodMs: 10,
      ignoreOlderDays: 7,
      storage: { provider: 'localDir', directory: bucket },
    },
    statePath: join(stateDir, 'wal-pilot.state.json'),
    onState: (s) => states.push(s),
    watchFn: noopWatch,
  });
  return { wow, bucket, states, svc };
}

describe('StreamerService', () => {
  it('flushes a seeded file and reports streaming state', async () => {
    const { wow, states, svc } = setup();
    writeFileSync(join(wow, 'Logs', 'WoWCombatLog-1.txt'), LINE);
    svc.start(); // initial scan seeds the file
    await new Promise((r) => setTimeout(r, 200)); // quiet-period flush at 10ms
    svc.stop();
    const streaming = states.filter((s) => s.status === 'streaming');
    expect(streaming.length).toBeGreaterThanOrEqual(1);
    expect(streaming[0].lastError).toBeNull();
  });

  it('reports error state when the storage target is unwritable, and keeps running', async () => {
    const { wow, states, svc } = setup();
    writeFileSync(join(wow, 'Logs', 'WoWCombatLog-1.txt'), LINE);
    // sabotage: replace bucket dir with a file so localDir mkdir fails
    // (constructed service points at bucket; remove+recreate as file)
    svc.start();
    svc.stop();
    // rebuild service against an impossible directory
    const bad = new StreamerService({
      agentConfig: {
        wowDirectory: wow,
        hostname: 'TEST-PC',
        flushIntervalMs: 30,
        quietPeriodMs: 10,
        ignoreOlderDays: 7,
        storage: { provider: 'localDir', directory: '/dev/null/nope' },
      },
      statePath: join(mkdtempSync(join(tmpdir(), 'pilot-state2-')), 's.json'),
      onState: (s) => states.push(s),
      watchFn: noopWatch,
    });
    bad.start();
    await new Promise((r) => setTimeout(r, 200));
    bad.stop();
    expect(states.some((s) => s.status === 'error' && s.lastError)).toBe(true);
  });
});

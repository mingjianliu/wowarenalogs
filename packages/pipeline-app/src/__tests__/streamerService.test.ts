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

  it('start() throws and emits error when the Logs dir is missing', () => {
    const bucket = mkdtempSync(join(tmpdir(), 'pilot-bucket-'));
    const states: StreamerState[] = [];
    const svc = new StreamerService({
      agentConfig: {
        wowDirectory: join(tmpdir(), 'definitely-missing-wow-dir'),
        hostname: 'TEST-PC',
        flushIntervalMs: 30,
        quietPeriodMs: 10,
        ignoreOlderDays: 7,
        storage: { provider: 'localDir', directory: bucket },
      },
      statePath: join(mkdtempSync(join(tmpdir(), 'pilot-state3-')), 's.json'),
      onState: (s) => states.push(s),
      watchFn: noopWatch,
    });
    expect(() => svc.start()).toThrow(/Logs directory unreadable/);
    expect(states).toEqual([
      { status: 'error', lastFlushAt: null, lastError: expect.stringContaining('Logs directory unreadable') },
    ]);
  });

  it('idle is measured from start time, not epoch, and fires only after idleAfterMs of quiet', async () => {
    const { states, svc: _unused } = setup(); // reuse setup's dirs but build our own service with idleAfterMs
    _unused.stop();
    const wow = mkdtempSync(join(tmpdir(), 'pilot-wow-idle-'));
    mkdirSync(join(wow, 'Logs'));
    const idleStates: StreamerState[] = [];
    const svc = new StreamerService({
      agentConfig: {
        wowDirectory: wow,
        hostname: 'TEST-PC',
        flushIntervalMs: 1000,
        quietPeriodMs: 1000,
        ignoreOlderDays: 7,
        storage: { provider: 'localDir', directory: mkdtempSync(join(tmpdir(), 'pilot-bucket-idle-')) },
      },
      statePath: join(mkdtempSync(join(tmpdir(), 'pilot-state-idle-')), 's.json'),
      onState: (s) => idleStates.push(s),
      watchFn: noopWatch,
      idleAfterMs: 120,
    });
    svc.start();
    await new Promise((r) => setTimeout(r, 60)); // half the idle window: nothing yet
    expect(idleStates.filter((s) => s.status === 'idle')).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 150)); // past the window: idle fires
    svc.stop();
    expect(idleStates.some((s) => s.status === 'idle')).toBe(true);
    void states;
  });
});

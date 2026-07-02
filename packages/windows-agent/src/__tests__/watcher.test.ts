import { startLogWatcher } from '../watcher';

// watchFn stub: capture the listener, never touch the real fs
const noopWatch = (() => ({ close: jest.fn() })) as unknown as typeof import('fs').watch;

describe('startLogWatcher', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function make(onFlush: (files: string[]) => Promise<void>) {
    return startLogWatcher({
      logsDir: '/fake/Logs',
      flushIntervalMs: 60000,
      quietPeriodMs: 30000,
      onFlush,
      watchFn: noopWatch,
    });
  }

  it('flushes dirty files on the interval and clears the set', async () => {
    const flushes: string[][] = [];
    const w = make(async (files) => {
      flushes.push(files);
    });
    w.handleEvent('change', 'WoWCombatLog-1.txt');
    w.handleEvent('change', 'WoWCombatLog-2.txt');
    await jest.advanceTimersByTimeAsync(60000);
    expect(flushes).toEqual([['WoWCombatLog-1.txt', 'WoWCombatLog-2.txt']]);
    await jest.advanceTimersByTimeAsync(60000);
    expect(flushes).toHaveLength(1); // nothing dirty → no second flush
    w.close();
  });

  it('drops rename events and non-log filenames', async () => {
    const flushes: string[][] = [];
    const w = make(async (files) => {
      flushes.push(files);
    });
    w.handleEvent('rename', 'WoWCombatLog-1.txt');
    w.handleEvent('change', 'SoundCache.dat');
    w.handleEvent('change', null);
    await jest.advanceTimersByTimeAsync(120000);
    expect(flushes).toHaveLength(0);
    w.close();
  });

  it('fires a final quiet-period flush after events stop', async () => {
    const flushes: string[][] = [];
    const w = make(async (files) => {
      flushes.push(files);
    });
    w.handleEvent('change', 'WoWCombatLog-1.txt');
    // quiet period (30s) elapses before the 60s interval tick
    await jest.advanceTimersByTimeAsync(30000);
    expect(flushes).toEqual([['WoWCombatLog-1.txt']]);
    await jest.advanceTimersByTimeAsync(120000);
    expect(flushes).toHaveLength(1); // no repeat flushes while idle
    w.close();
  });

  it('skips a tick while a previous flush is still running', async () => {
    let release: () => void = () => undefined;
    const flushes: string[][] = [];
    const w = make(
      (files) =>
        new Promise<void>((resolve) => {
          flushes.push(files);
          release = resolve;
        }),
    );
    w.handleEvent('change', 'WoWCombatLog-1.txt');
    await jest.advanceTimersByTimeAsync(30000); // quiet flush starts, never resolves yet
    w.handleEvent('change', 'WoWCombatLog-2.txt');
    await jest.advanceTimersByTimeAsync(60000); // tick during pending flush → skipped
    expect(flushes).toHaveLength(1);
    release();
    await jest.advanceTimersByTimeAsync(60000); // next tick flushes the still-dirty file
    expect(flushes[1]).toEqual(['WoWCombatLog-2.txt']);
    w.close();
  });
});

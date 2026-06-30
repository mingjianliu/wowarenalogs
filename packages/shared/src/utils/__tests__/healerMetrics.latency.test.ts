/* eslint-disable @typescript-eslint/no-explicit-any */
import { computeCDResponseLatency } from '../healerMetrics';

const win = (fromSeconds: number, toSeconds: number) => ({ fromSeconds, toSeconds });
const cd = (timeSeconds: number, timingLabel: string) => ({ casts: [{ timeSeconds, timingLabel }] }) as any;

test('returns null latency + coverage 0/N when no defensive answers any window', () => {
  const r = computeCDResponseLatency([], [win(10, 12), win(40, 42)], 0);
  expect(r.latencyMsMedian).toBeNull();
  expect(r.answered).toBe(0);
  expect(r.windows).toBe(2);
});

test('measures latency only over answered windows and counts coverage', () => {
  // window starts at 10s; defensive cast at 12s (Reactive) -> 2000ms latency; window 40s unanswered
  const r = computeCDResponseLatency([cd(12, 'Reactive')], [win(10, 12), win(40, 42)], 0);
  expect(r.latencyMsMedian).toBe(2000);
  expect(r.answered).toBe(1);
  expect(r.windows).toBe(2);
});

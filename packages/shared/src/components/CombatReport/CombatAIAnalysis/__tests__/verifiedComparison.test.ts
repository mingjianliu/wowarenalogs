/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion */
import { buildVerifiedComparison, diversifyByPlayer } from '../verifiedComparison';

const rec = (playerName: string, offensiveIndex: number | null, reactionLatency: number | null) =>
  ({
    playerName,
    metrics: {
      offensiveIndex,
      ccDensity: 1,
      reactionLatency,
      defensiveOverlapRatio: 0,
      effectiveCastRatio: 1,
      ccAvoidanceRate: 0,
    },
  }) as any;

test('cohort stats exclude nulls and disclose nReal', () => {
  const cell = [rec('A', 0.1, null), rec('B', 0.2, 5), rec('C', 0.3, 7)];
  const vc = buildVerifiedComparison(
    cell,
    { offensiveIndex: 0.25, responseLatencySec: 6 },
    { player: 'Me', spec: 'Discipline Priest', bracket: '3v3' },
  );
  expect(vc.cohort.perMetric.offensiveIndex!.nReal).toBe(3);
  expect(vc.cohort.perMetric.responseLatencySec!.nReal).toBe(2); // A's null excluded
  expect(vc.cohort.n).toBe(3);
  expect(vc.cohort.uniquePlayers).toBe(3);
});

test('a null in one metric never nulls the others (the metricsAvailable trap)', () => {
  const cell = [rec('A', 0.1, null), rec('B', 0.2, null)];
  const vc = buildVerifiedComparison(
    cell,
    { offensiveIndex: 0.15 },
    { player: 'Me', spec: 'Discipline Priest', bracket: '3v3' },
  );
  expect(vc.cohort.perMetric.offensiveIndex!.nReal).toBe(2); // survives
  expect(vc.cohort.perMetric.responseLatencySec).toBeUndefined(); // all null -> omitted
});

test('thin cohort emits a note and no percentile', () => {
  const cell = [rec('A', 0.1, 5)];
  const vc = buildVerifiedComparison(
    cell,
    { offensiveIndex: 0.2 },
    { player: 'Me', spec: 'Holy Priest', bracket: 'solo_shuffle' },
  );
  expect(vc.notes.some((n) => n.toLowerCase().includes('thin'))).toBe(true);
});

test('diversifyByPlayer caps rounds-per-player', () => {
  const r = diversifyByPlayer([{ playerName: 'A' }, { playerName: 'A' }, { playerName: 'A' }, { playerName: 'B' }], 1);
  expect(r.filter((x) => x.playerName === 'A').length).toBe(1);
  expect(r.length).toBe(2);
});

test('emits warning note when cohort has too few teamDtps records', () => {
  const cell = Array.from({ length: 10 }, (_, i) => ({
    playerName: `Player${i}`,
    metrics: {
      offensiveIndex: 0.1 * i,
      ccDensity: 1,
      reactionLatency: 0.5,
      defensiveOverlapRatio: 0,
      effectiveCastRatio: 1,
      ccAvoidanceRate: 0,
      teamDtps: 1000 + i * 100,
    },
  })) as any;

  const vc = buildVerifiedComparison(
    cell,
    { offensiveIndex: 0.5 },
    { player: 'Me', spec: 'Discipline Priest', bracket: '3v3' },
    1500, // userTeamDtps
  );

  expect(
    vc.notes.some((n) =>
      n.includes('offensiveIndex pressure-matching skipped: too few cohort games with pressure telemetry'),
    ),
  ).toBe(true);
});

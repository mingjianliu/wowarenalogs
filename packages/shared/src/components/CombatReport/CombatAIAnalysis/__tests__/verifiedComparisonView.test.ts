import {
  buildCrisisView,
  buildVerifiedMetricRows,
  deriveHeadline,
  sampleDisclosure,
  standingFor,
} from '../verifiedComparisonView';

const stat = (median: number, userPercentile: number | null, nReal = 40) => ({
  mean: median,
  median,
  p25: median,
  p75: median,
  userPercentile,
  nReal,
});

const vc: any = {
  player: 'Me',
  spec: 'Discipline Priest',
  bracket: '3v3',
  cohort: {
    n: 40,
    uniquePlayers: 22,
    leaderboardSelection: '2300+ leaderboard selection',
    perMetric: {
      offensiveIndex: stat(0.15, 0.05), // higher=better, 5th pct -> behind (the worst gap)
      ccDensity: stat(1.4, 0.9), // higher=better, 90th pct -> ahead
      responseLatencySec: stat(6, 0.85), // lower=better, 85th pct -> behind (slow)
      defensiveOverlapRatio: stat(0.0, 0.5), // context -> even
    },
  },
  notes: ['thin cohort (n=5) — percentiles are low-confidence'],
};

test('standingFor respects valence', () => {
  expect(standingFor('higher', 0.8)).toBe('ahead');
  expect(standingFor('higher', 0.2)).toBe('behind');
  expect(standingFor('lower', 0.8)).toBe('behind'); // high latency percentile = slow = bad
  expect(standingFor('lower', 0.1)).toBe('ahead');
  expect(standingFor('context', 0.9)).toBe('even');
  expect(standingFor('higher', null)).toBe('na');
});

test('buildVerifiedMetricRows omits absent metrics and computes standing', () => {
  const rows = buildVerifiedMetricRows(vc);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  expect(byKey.offensiveIndex.standing).toBe('behind');
  expect(byKey.ccDensity.standing).toBe('ahead');
  expect(byKey.responseLatencySec.standing).toBe('behind');
  expect(byKey.responseLatencySec.label).toBe('Defensive Response Latency');
  expect(byKey.responseLatencySec.nReal).toBe(40);
  expect(byKey.effectiveCastRatio).toBeUndefined(); // absent from cohort -> omitted, never fabricated
});

test('deriveHeadline picks the worst gap (offensiveIndex 20th pct)', () => {
  const h = deriveHeadline(vc);
  expect(h.label).toContain('Offensive Index');
  expect(h.gist).toContain('5th percentile');
});

test('buildCrisisView parses user + pro sequences', () => {
  const v = buildCrisisView(
    ['At 60.2s (Teammate Bob-Realm-US HP: 37%): Penance -> Power Word: Shield'],
    ['At 44.0s (Teammate Pro-Realm-US HP: 40%): Flash Heal -> Renew'],
  );
  expect(v.user[0].sequence).toEqual(['Penance', 'Power Word: Shield']);
  expect(v.user[0].hpPct).toBe(37);
  expect(v.pros[0].sequence).toEqual(['Flash Heal', 'Renew']);
});

test('sampleDisclosure surfaces n/uniquePlayers/notes', () => {
  const s = sampleDisclosure(vc);
  expect(s.n).toBe(40);
  expect(s.uniquePlayers).toBe(22);
  expect(s.notes[0]).toContain('thin cohort');
});

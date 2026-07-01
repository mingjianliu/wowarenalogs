/* eslint-disable @typescript-eslint/no-explicit-any */
import { checkClaims } from '../claimChecker';
import { buildStatsLedPrompt, collectServerNumbers } from '../comparativePrompt.stats';

const vc: any = {
  player: 'Me',
  spec: 'Discipline Priest',
  bracket: '3v3',
  cohort: {
    n: 24,
    uniquePlayers: 20,
    leaderboardSelection: '2300+ leaderboard selection',
    perMetric: { responseLatencySec: { mean: 9.2, median: 7.8, p25: 5, p75: 12, userPercentile: 0.6, nReal: 14 } },
  },
  notes: ['thin cohort (n=5) — percentiles are low-confidence'],
};

test('prompt uses the registry label, discloses sample size, and never says panic', () => {
  const p = buildStatsLedPrompt(vc);
  expect(p).toContain('Defensive Response Latency'); // registry label, not "Crisis Reaction Latency"
  expect(p).toContain('n=14'); // nReal disclosed
  expect(p.toLowerCase()).toContain('do not invent'); // narrate-only contract
  expect(p.toLowerCase()).not.toContain('panic');
});

test('prompt includes the Global Pacing header, player/spec/bracket, and cohort provenance', () => {
  const p = buildStatsLedPrompt(vc);
  expect(p).toContain('Global Pacing');
  expect(p).toContain('Me');
  expect(p).toContain('Discipline Priest');
  expect(p).toContain('3v3');
  expect(p).toContain('20');
  expect(p).toContain('2300+ leaderboard selection');
});

test('prompt surfaces notes verbatim and the median value from the stat, not a fabricated number', () => {
  const p = buildStatsLedPrompt(vc);
  expect(p).toContain('thin cohort (n=5) — percentiles are low-confidence');
  expect(p).toContain('7.80'); // median, formatted to 2 decimals
  expect(p).toContain('60th'); // userPercentile rendered as a rounded percentile
});

test('omits userPercentile as n/a when null, without throwing', () => {
  const nullPercentileVc: any = {
    ...vc,
    cohort: {
      ...vc.cohort,
      perMetric: {
        responseLatencySec: { mean: 9.2, median: 7.8, p25: 5, p75: 12, userPercentile: null, nReal: 14 },
      },
    },
  };
  const p = buildStatsLedPrompt(nullPercentileVc);
  expect(p).toContain('n/a');
});

test('renders "none" when there are no notes', () => {
  const noNotesVc: any = { ...vc, notes: [] };
  const p = buildStatsLedPrompt(noNotesVc);
  expect(p).toContain('none');
});

describe('collectServerNumbers', () => {
  test('includes every number rendered into the prompt (median, nReal, percentile, cohort size)', () => {
    const nums = collectServerNumbers(vc);
    expect(nums).toEqual(expect.arrayContaining([7.8, 14, 60, 20]));
  });

  // The stats-led path gates only on *number* violations (per the task brief: "the stats-led
  // prompt cites NO pro spell names, so do not hard-gate on spells here"). A registry label like
  // "Defensive Response Latency" can itself collide with a known single-word spell ("Response"),
  // so passing an empty spell allow-list is expected to still produce spell violations here —
  // the caller (api/compare.ts) must filter to `uncited number:` violations before gating.
  const numberViolations = (violations: string[]) => violations.filter((v) => v.startsWith('uncited number'));

  test('a report that only cites collected numbers has no number violations', () => {
    const numbers = collectServerNumbers(vc);
    const honestReport = 'Me sits at the 60th percentile on Defensive Response Latency (median 7.80s, n=14).';
    const { violations } = checkClaims(honestReport, { spells: [], numbers });
    expect(numberViolations(violations)).toEqual([]);
  });

  test('a report that invents a number produces a number violation', () => {
    const numbers = collectServerNumbers(vc);
    const fabricatedReport = 'Me sits at the 99th percentile, dramatically better than average.';
    const { violations } = checkClaims(fabricatedReport, { spells: [], numbers });
    expect(numberViolations(violations).length).toBeGreaterThan(0);
  });
});

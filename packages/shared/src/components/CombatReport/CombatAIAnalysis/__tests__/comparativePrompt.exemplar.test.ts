import { buildExemplarLedPrompt } from '../comparativePrompt.exemplar';
import { MetricKey } from '../metricRegistry';
import { CohortStat, VerifiedComparison } from '../verifiedComparison';

// userPercentile is an un-inverted raw rank: for lower=better metrics a HIGH percentile is BAD;
// for higher=better a LOW percentile is bad.
const stat = (userPercentile: number, median = 0.5): CohortStat => ({
  mean: median,
  median,
  p25: median * 0.8,
  p75: median * 1.2,
  userPercentile,
  nReal: 50,
});

const mkVC = (perMetric: Partial<Record<MetricKey, CohortStat>>): VerifiedComparison => ({
  player: 'Tester',
  spec: 'Mistweaver Monk',
  bracket: 'Rated Solo Shuffle',
  cohort: { n: 50, uniquePlayers: 6, leaderboardSelection: '2300+ leaderboard selection', perMetric },
  notes: [],
});

const base = {
  player: 'Tester',
  spec: 'Mistweaver Monk',
  bracket: 'Rated Solo Shuffle',
  userCrises: ['At 60s (Teammate 37%): Chain Heal -> Chain Heal'],
  proCrises: ['At 42s (Teammate 39%): Riptide -> Healing Wave'],
};

test('prefers a crisis-actionable metric (Offensive Index) as the anchor over a worse non-actionable one', () => {
  // effectiveCastRatio is far worse (2nd pct, higher=better) but is NOT crisis-actionable;
  // offensiveIndex is only mildly bad (36th pct) but IS actionable — it must win the anchor.
  const p = buildExemplarLedPrompt({
    ...base,
    vc: mkVC({ effectiveCastRatio: stat(0.02, 0.97), offensiveIndex: stat(0.36, 0.14) }),
  });
  expect(p).toContain('Offensive Index: you are 36th percentile');
  expect(p).toContain('to anchor the advice');
  expect(p).not.toContain('CONTEXT ONLY');
  // the anchor line always states the direction (prevents inversion)
  expect(p).toContain('higher is better');
});

test('when only a non-actionable metric is on the worse side, it renders CONTEXT ONLY + direction + guard', () => {
  // Only responseLatencySec is on the worse side (100th pct = slowest, lower=better).
  const p = buildExemplarLedPrompt({
    ...base,
    vc: mkVC({ responseLatencySec: stat(1.0, 7.5), offensiveIndex: stat(1.0, 0.14) }),
  });
  expect(p).toContain('Defensive Response Latency: you are 100th percentile');
  expect(p).toContain('lower is better'); // direction stated → no inversion
  expect(p).toContain('for context'); // header switched to context wording
  expect(p).toContain('CONTEXT ONLY');
  expect(p).toContain('do NOT claim the crisis change will move it');
  // and the driver line names what actually moves it (enemy burst, not crisis casts)
  expect(p.toLowerCase()).toContain('defensive cooldown');
});

test('Effective Cast Ratio anchor names its real driver (interrupt avoidance) and is context-only', () => {
  const p = buildExemplarLedPrompt({
    ...base,
    vc: mkVC({ effectiveCastRatio: stat(0.12, 0.97) }),
  });
  expect(p).toContain('Effective Cast Ratio: you are 12th percentile');
  expect(p).toContain('CONTEXT ONLY');
  expect(p.toLowerCase()).toContain('kicks/interrupts');
});

test('no metric on the worse side → insufficient-data anchor, no crash', () => {
  // 100th percentile on a higher=better metric = best in cohort → badness 0 → no anchor.
  const p = buildExemplarLedPrompt({ ...base, vc: mkVC({ offensiveIndex: stat(1.0, 0.14) }) });
  expect(p).toContain('insufficient data for a percentile anchor');
});

test('anchors the pro-crisis denominator (M) so the model cannot invent a larger total', () => {
  const p = buildExemplarLedPrompt({
    ...base,
    proCrises: [
      'At 42s (Teammate 39%): Riptide -> Healing Wave',
      'At 61s (Teammate 30%): Natures Swiftness -> Healing Surge',
      'At 88s (Teammate 35%): Healing Tide Totem',
    ],
    vc: mkVC({ offensiveIndex: stat(0.3, 0.14) }),
  });
  expect(p).toContain('3 shown — cite pro counts as "N of 3"');
  expect(p).toContain('there are 3 pro crises shown, so say "N of 3", never a larger total');
});

/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ComparativeAnalysisData } from '../comparativePrompt';
import {
  buildMetricRows,
  computeProAverages,
  deriveArchetype,
  formatMetric,
  parseCoachingReport,
  parseCrisisEvent,
  PRO_METRIC_MODEL,
} from '../proComparisonData';

const M = {
  offensiveIndex: 0.5,
  ccDensity: 1,
  reactionLatency: 2,
  defensiveOverlapRatio: 0.1,
  effectiveCastRatio: 0.9,
  ccAvoidanceRate: 0.4,
};

function data(over: Partial<ComparativeAnalysisData> = {}): ComparativeAnalysisData {
  return {
    playerName: 'Heal-Realm',
    spec: 'Discipline Priest',
    userMetrics: { ...M },
    userCrisisEvents: [],
    nearestNeighbors: [{ distance: 0.2, metrics: { ...M }, crisisEvents: [] }],
    ...over,
  };
}

describe('parseCrisisEvent', () => {
  it('parses time, player (realm stripped), hp, and sequence', () => {
    const p = parseCrisisEvent('At 56.4s (Teammate Nipsey-Arthas-EU HP: 36%): Penance -> Power Word: Shield');
    expect(p.atSeconds).toBeCloseTo(56.4);
    expect(p.who).toBe('Nipsey');
    expect(p.hpPct).toBe(36);
    expect(p.sequence).toEqual(['Penance', 'Power Word: Shield']);
  });
  it('handles a string with no structure gracefully', () => {
    const p = parseCrisisEvent('garbage with no structure');
    expect(Array.isArray(p.sequence)).toBe(true);
  });
});

describe('computeProAverages', () => {
  it('returns zeros for an empty cohort', () => {
    expect(computeProAverages([]).offensiveIndex).toBe(0);
  });
  it('averages across neighbours', () => {
    const avg = computeProAverages([
      { distance: 0.1, metrics: { ...M, offensiveIndex: 0.4 }, crisisEvents: [] },
      { distance: 0.2, metrics: { ...M, offensiveIndex: 0.6 }, crisisEvents: [] },
    ]);
    expect(avg.offensiveIndex).toBeCloseTo(0.5);
  });
});

describe('buildMetricRows', () => {
  it('flags behind correctly for a higher-is-better metric', () => {
    const rows = buildMetricRows(
      data({
        userMetrics: { ...M, offensiveIndex: 0.3 },
        nearestNeighbors: [{ distance: 0.2, metrics: { ...M, offensiveIndex: 0.6 }, crisisEvents: [] }],
      }),
    );
    const off = rows.find((r) => r.spec.key === 'offensiveIndex')!;
    expect(off.behind).toBe(true);
  });
  it('drops metrics that are 0 on both sides by default', () => {
    const z = { ...M, ccAvoidanceRate: 0 };
    const rows = buildMetricRows(
      data({ userMetrics: z, nearestNeighbors: [{ distance: 0.2, metrics: z, crisisEvents: [] }] }),
    );
    expect(rows.find((r) => r.spec.key === 'ccAvoidanceRate')).toBeUndefined();
  });
  it('keeps them when dropEmpty is false', () => {
    const z = { ...M, ccAvoidanceRate: 0 };
    const rows = buildMetricRows(
      data({ userMetrics: z, nearestNeighbors: [{ distance: 0.2, metrics: z, crisisEvents: [] }] }),
      { dropEmpty: false },
    );
    expect(rows.find((r) => r.spec.key === 'ccAvoidanceRate')).toBeDefined();
  });
});

describe('deriveArchetype', () => {
  it('labels a passive low-output healer', () => {
    const a = deriveArchetype(data({ userMetrics: { ...M, offensiveIndex: 0.1, ccDensity: 0.1 } }));
    expect(a.label.toLowerCase()).toContain('passive');
  });
});

describe('parseCoachingReport', () => {
  it('splits Global Pacing / Crisis Management sections', () => {
    const r = parseCoachingReport('## Global Pacing\nPace stuff.\n## Crisis Management\nCrisis stuff.');
    expect(r.globalPacing).toContain('Pace stuff');
    expect(r.crisisManagement).toContain('Crisis stuff');
  });
  it('returns empty strings for empty input', () => {
    expect(parseCoachingReport('')).toEqual({ globalPacing: '', crisisManagement: '' });
  });
});

describe('formatMetric', () => {
  it('appends the unit and rounds', () => {
    const spec = PRO_METRIC_MODEL.find((s) => s.key === 'ccDensity')!;
    expect(formatMetric(spec, 1.234)).toBe('1.2/m');
  });
});

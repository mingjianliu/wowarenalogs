import { METRIC_REGISTRY, MetricKey } from '../metricRegistry';

const KEYS: MetricKey[] = [
  'offensiveIndex',
  'ccDensity',
  'responseLatencySec',
  'defensiveOverlapRatio',
  'effectiveCastRatio',
  'ccAvoidanceRate',
];

test('every metric has a non-empty label, definition, and valence', () => {
  for (const k of KEYS) {
    const d = METRIC_REGISTRY[k];
    expect(d).toBeDefined();
    expect(d.label.length).toBeGreaterThan(0);
    expect(d.definition.length).toBeGreaterThan(0);
    expect(['higher', 'lower', 'context']).toContain(d.valence);
  }
});

test('latency is relabeled, lower=better, and decoupled from teammate-HP framing', () => {
  const d = METRIC_REGISTRY.responseLatencySec;
  expect(d.label).toBe('Defensive Response Latency');
  expect(d.valence).toBe('lower');
  expect(d.definition.toLowerCase()).toContain('enemy'); // measures enemy-burst response
  expect(d.definition.toLowerCase()).not.toContain('<40%'); // not the teammate-HP crisis block
});

test('defensiveOverlap carries no baked-in panic verdict', () => {
  expect(METRIC_REGISTRY.defensiveOverlapRatio.definition.toLowerCase()).not.toContain('panic');
});

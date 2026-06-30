export type MetricKey =
  | 'offensiveIndex'
  | 'ccDensity'
  | 'responseLatencySec'
  | 'burstResponseCoverage'
  | 'defensiveOverlapRatio'
  | 'effectiveCastRatio'
  | 'ccAvoidanceRate';

export interface MetricDef {
  key: MetricKey;
  label: string;
  definition: string;
  valence: 'higher' | 'lower' | 'context';
  unit: string;
}

export const METRIC_REGISTRY: Record<MetricKey, MetricDef> = {
  offensiveIndex: {
    key: 'offensiveIndex',
    label: 'Offensive Index',
    definition: 'Damage output divided by healing+absorb output.',
    valence: 'higher',
    unit: '',
  },
  ccDensity: {
    key: 'ccDensity',
    label: 'CC Density',
    definition: 'Successful crowd-control casts per minute.',
    valence: 'higher',
    unit: '/m',
  },
  responseLatencySec: {
    key: 'responseLatencySec',
    label: 'Defensive Response Latency',
    definition:
      'Seconds from an enemy burst window to your defensive-CD response (over windows you answered). Lower is faster.',
    valence: 'lower',
    unit: 's',
  },
  burstResponseCoverage: {
    key: 'burstResponseCoverage',
    label: 'Burst Response Coverage',
    definition: 'Fraction of enemy burst windows you answered with a defensive CD at all.',
    valence: 'higher',
    unit: '%',
  },
  defensiveOverlapRatio: {
    key: 'defensiveOverlapRatio',
    label: 'Defensive Overlap',
    definition: 'Fraction of your major defensives cast while a teammate defensive was already active.',
    valence: 'context',
    unit: '',
  },
  effectiveCastRatio: {
    key: 'effectiveCastRatio',
    label: 'Effective Cast Ratio',
    definition: 'Successful casts divided by successful casts plus interrupts taken.',
    valence: 'higher',
    unit: '',
  },
  ccAvoidanceRate: {
    key: 'ccAvoidanceRate',
    label: 'CC Avoidance Rate',
    definition: 'Fraction of incoming CC you avoided (Fade/LoS/Grounding/immunity).',
    valence: 'higher',
    unit: '',
  },
};

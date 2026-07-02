export type MetricKey =
  | 'offensiveIndex'
  | 'ccDensity'
  | 'responseLatencySec'
  // burstResponseCoverage: computed in healerMetrics but not stored in the vector index
  // (requires a future reindex to plumb answered/windows counts through storage). Dropped
  // from the registry for now so it doesn't show as misleading 'n/a' in the UI.
  | 'defensiveOverlapRatio'
  | 'effectiveCastRatio'
  | 'ccAvoidanceRate';

export interface MetricDef {
  key: MetricKey;
  label: string;
  definition: string;
  valence: 'higher' | 'lower' | 'context';
  unit: string;
  // Whether this metric can plausibly be moved by the player's <40%-HP crisis-window cast choices.
  // The exemplar prompt contrasts crisis sequences, so an anchor metric that measures something else
  // (enemy-burst latency, whole-match interrupt-avoidance) invites wrong-cause / conflation coaching.
  // Meta-eval (META-EVAL-EXEMPLAR-REPORT.md §2): responseLatencySec flagged 100% and effectiveCastRatio
  // 72% when used as the crisis anchor, vs 5-6% for the crisisActionable metrics.
  crisisActionable: boolean;
  // One-liner naming what ACTUALLY moves the metric — surfaced in the prompt so the coach doesn't
  // misattribute (e.g. that ECR is interrupt-avoidance, not heal-conversion/target-selection).
  driver: string;
}

export const METRIC_REGISTRY: Record<MetricKey, MetricDef> = {
  offensiveIndex: {
    key: 'offensiveIndex',
    label: 'Offensive Index',
    definition: 'Damage output divided by healing+absorb output.',
    valence: 'higher',
    unit: '',
    crisisActionable: true,
    driver: 'weaving damage casts in vs. spending every GCD on healing',
  },
  ccDensity: {
    key: 'ccDensity',
    label: 'CC Density',
    definition: 'Successful crowd-control casts per minute.',
    valence: 'higher',
    unit: '/m',
    crisisActionable: true,
    driver: 'how often you land control casts',
  },
  responseLatencySec: {
    key: 'responseLatencySec',
    label: 'Defensive Response Latency',
    definition:
      'Seconds from an ENEMY BURST window to your defensive-cooldown response (over windows you answered). This is about reacting to enemy offense — it is NOT your reaction to a teammate dropping below 40% HP.',
    valence: 'lower',
    unit: 's',
    crisisActionable: false,
    driver: 'how fast you fire a DEFENSIVE cooldown into enemy burst — not what you cast in a low-HP crisis',
  },

  defensiveOverlapRatio: {
    key: 'defensiveOverlapRatio',
    label: 'Defensive Overlap',
    definition: 'Fraction of your major defensives cast while a teammate defensive was already active.',
    valence: 'context',
    unit: '',
    crisisActionable: false,
    driver: 'coordinating your defensives around teammate defensives',
  },
  effectiveCastRatio: {
    key: 'effectiveCastRatio',
    label: 'Effective Cast Ratio',
    definition:
      'Successful (uninterrupted) casts divided by successful casts plus interrupts taken. It measures INTERRUPT AVOIDANCE only — it is blind to whether a cast healed, hit the right target, or was redundant.',
    valence: 'higher',
    unit: '',
    crisisActionable: false,
    driver:
      'avoiding kicks/interrupts (e.g. using instants under pressure) — NOT heal value, target choice, or redundancy',
  },
  ccAvoidanceRate: {
    key: 'ccAvoidanceRate',
    label: 'CC Avoidance Rate',
    definition: 'Fraction of incoming CC you avoided (Fade/LoS/Grounding/immunity).',
    valence: 'higher',
    unit: '',
    crisisActionable: true,
    driver: 'proactively dodging CC with Fade/LoS/Grounding/immunity',
  },
};

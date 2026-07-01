// verifiedComparisonView.ts
//
// Pure presentation transforms for the REBUILT comparison UI — turns a server-computed
// VerifiedComparison (full-cohort percentiles + disclosed nReal + notes) and the exemplar
// crisis data into the shapes the new <ProComparison> renders. No React, no side effects —
// mirrors the role of proComparisonData.ts but for the new, honest data model.
//
// This is the UI-rewire counterpart to the winning A/B design: cohort *standing* (percentile,
// not a fabricated "pro average") + concrete diversified pro *exemplars*.

import { METRIC_REGISTRY, MetricKey } from './metricRegistry';
import { parseCrisisEvent, ParsedCrisis } from './proComparisonData';
import { VerifiedComparison } from './verifiedComparison';

export type Standing = 'ahead' | 'behind' | 'even' | 'na';

export interface VerifiedMetricRow {
  key: MetricKey;
  label: string;
  definition: string;
  unit: string;
  valence: 'higher' | 'lower' | 'context';
  cohortMedian: number;
  /** 0..1 fraction of the cohort at or below the user's value; null when the user metric is absent. */
  userPercentile: number | null;
  nReal: number;
  standing: Standing;
}

const AHEAD = 0.6;
const BEHIND = 0.4;

/** Where the user sits relative to the cohort, respecting each metric's valence. */
export function standingFor(valence: 'higher' | 'lower' | 'context', pct: number | null): Standing {
  if (pct === null) return 'na';
  if (valence === 'context') return 'even';
  // higher=better: high percentile is good. lower=better: high percentile is BAD.
  const good = valence === 'higher' ? pct : 1 - pct;
  if (good >= AHEAD) return 'ahead';
  if (good <= BEHIND) return 'behind';
  return 'even';
}

/** One row per metric present in the cohort stats, in registry order. */
export function buildVerifiedMetricRows(vc: VerifiedComparison): VerifiedMetricRow[] {
  const rows: VerifiedMetricRow[] = [];
  for (const key of Object.keys(METRIC_REGISTRY) as MetricKey[]) {
    const s = vc.cohort.perMetric[key];
    if (!s) continue; // metric absent from the cohort → omit (never fabricate)
    const def = METRIC_REGISTRY[key];
    rows.push({
      key,
      label: def.label,
      definition: def.definition,
      unit: def.unit,
      valence: def.valence,
      cohortMedian: s.median,
      userPercentile: s.userPercentile,
      nReal: s.nReal,
      standing: standingFor(def.valence, s.userPercentile),
    });
  }
  return rows;
}

export interface Headline {
  label: string;
  gist: string;
}

/** The single metric where the user is furthest on the worse side of the cohort — the coaching hook. */
export function deriveHeadline(vc: VerifiedComparison): Headline {
  let worst: { row: VerifiedMetricRow; badness: number } | null = null;
  for (const row of buildVerifiedMetricRows(vc)) {
    if (row.userPercentile === null || row.valence === 'context') continue;
    const badness = row.valence === 'higher' ? 1 - row.userPercentile : row.userPercentile;
    if (badness > 0 && (worst === null || badness > worst.badness)) worst = { row, badness };
  }
  if (!worst) return { label: 'On-cohort', gist: 'Your metrics track the cohort — no single standout gap.' };
  const pct = Math.round((worst.row.userPercentile as number) * 100);
  return {
    label: `${worst.row.label} gap`,
    gist: `You sit at the ${pct}th percentile on ${worst.row.label} (cohort median ${worst.row.cohortMedian.toFixed(2)}${worst.row.unit}, n=${worst.row.nReal}) — the biggest lever this game.`,
  };
}

export interface CrisisView {
  user: ParsedCrisis[];
  pros: ParsedCrisis[];
}

/** Parse the user's own crisis sequences and the diversified pro exemplar sequences for display. */
export function buildCrisisView(userCrises: string[], proCrises: string[]): CrisisView {
  return {
    user: (userCrises ?? []).map(parseCrisisEvent),
    pros: (proCrises ?? []).map(parseCrisisEvent),
  };
}

export interface SampleDisclosure {
  n: number;
  uniquePlayers: number;
  notes: string[];
}

export function sampleDisclosure(vc: VerifiedComparison): SampleDisclosure {
  return { n: vc.cohort.n, uniquePlayers: vc.cohort.uniquePlayers, notes: vc.notes };
}

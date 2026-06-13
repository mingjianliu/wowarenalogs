// packages/shared/src/components/CombatReport/CombatAIAnalysis/proComparisonData.ts
//
// Pure transforms that turn the comparative (vector / dynamic-archetyping) result
// into the shapes the <ProComparison> view renders. No React, no side effects —
// mirrors the style of matchAnalysisData.ts / aiFindings.ts.

import { ComparativeAnalysisData } from './comparativePrompt';

export type MetricKey = keyof ComparativeAnalysisData['userMetrics'];

export interface ProMetricSpec {
  key: MetricKey;
  label: string;
  hint: string;
  unit: string;
  /** Which direction is "better" — drives the behind/ahead colouring. */
  dir: 'higher' | 'lower';
  /** Bar scale ceiling. Bars clamp to [0, max]. */
  max: number;
}

// Display model for the six differential metrics. Order = render order.
export const PRO_METRIC_MODEL: ProMetricSpec[] = [
  {
    key: 'offensiveIndex',
    label: 'Offensive Index',
    hint: 'Damage : healing output ratio',
    unit: '',
    dir: 'higher',
    max: 0.9,
  },
  {
    key: 'ccDensity',
    label: 'CC Density',
    hint: 'Successful crowd-control per minute',
    unit: '/m',
    dir: 'higher',
    max: 2.2,
  },
  {
    key: 'reactionLatency',
    label: 'Crisis Reaction Latency',
    hint: 'Delay from teammate <40% HP to a major CD',
    unit: 's',
    dir: 'lower',
    max: 6,
  },
  {
    key: 'defensiveOverlapRatio',
    label: 'Defensive Overlap',
    hint: 'High = panic-trading defensives with teammates',
    unit: '',
    dir: 'lower',
    max: 0.2,
  },
  {
    key: 'effectiveCastRatio',
    label: 'Effective Cast Ratio',
    hint: 'Low = interrupted or poor positioning',
    unit: '',
    dir: 'higher',
    max: 1,
  },
  {
    key: 'ccAvoidanceRate',
    label: 'CC Avoidance Rate',
    hint: 'High = proactive Fade / LoS / Grounding',
    unit: '',
    dir: 'higher',
    max: 1,
  },
];

export type ProMetrics = ComparativeAnalysisData['userMetrics'];

/** Average each metric across the nearest-neighbour cohort. */
export function computeProAverages(neighbors: ComparativeAnalysisData['nearestNeighbors']): ProMetrics {
  const empty: ProMetrics = {
    offensiveIndex: 0,
    ccDensity: 0,
    reactionLatency: 0,
    defensiveOverlapRatio: 0,
    effectiveCastRatio: 0,
    ccAvoidanceRate: 0,
  };
  const n = neighbors.length;
  if (n === 0) return empty;
  const sums = neighbors.reduce(
    (acc, nb) => {
      (Object.keys(acc) as MetricKey[]).forEach((k) => (acc[k] += nb.metrics[k]));
      return acc;
    },
    { ...empty },
  );
  (Object.keys(sums) as MetricKey[]).forEach((k) => (sums[k] /= n));
  return sums;
}

export interface MetricRow {
  spec: ProMetricSpec;
  you: number;
  pro: number;
  /** True when the user is on the worse side of the cohort average. */
  behind: boolean;
  /** you − pro (signed, in metric units). */
  delta: number;
  /** Gap magnitude 0..1 relative to the metric scale (for colour intensity). */
  gap: number;
}

export interface BuildMetricRowsOptions {
  /** Drop metrics where both user and cohort are 0 (unpopulated in this corpus build). Default true. */
  dropEmpty?: boolean;
}

export function buildMetricRows(data: ComparativeAnalysisData, opts: BuildMetricRowsOptions = {}): MetricRow[] {
  const { dropEmpty = true } = opts;
  const pro = computeProAverages(data.nearestNeighbors);
  return PRO_METRIC_MODEL.map((spec) => {
    const you = data.userMetrics[spec.key];
    const proVal = pro[spec.key];
    const behind = spec.dir === 'higher' ? you < proVal : you > proVal;
    return {
      spec,
      you,
      pro: proVal,
      behind,
      delta: you - proVal,
      gap: Math.min(1, Math.abs(you - proVal) / spec.max),
    };
  }).filter((row) => (dropEmpty ? !(row.you === 0 && row.pro === 0) : true));
}

export function formatMetric(spec: ProMetricSpec, value: number): string {
  const dp = spec.max <= 0.25 ? 2 : spec.max <= 1 ? 2 : 1;
  return value.toFixed(dp) + spec.unit;
}

// ── Crisis events ────────────────────────────────────────────────────────────
// Raw strings look like:
//   "At 56.4s (Teammate Nipseyhussle-Arthas-EU HP: 36%): Penance -> Power Word: Shield"
export interface ParsedCrisis {
  atSeconds: number | null;
  who: string | null;
  hpPct: number | null;
  /** Ordered cast sequence (split on " -> "). */
  sequence: string[];
  raw: string;
}

export function parseCrisisEvent(raw: string): ParsedCrisis {
  const timeMatch = raw.match(/At\s+([\d.]+)s/i);
  const whoMatch = raw.match(/\((?:Teammate|Ally)?\s*([^)]+?)\s+HP:\s*(\d+)%\)/i);
  const colon = raw.indexOf('): ');
  const responseText = colon >= 0 ? raw.slice(colon + 3) : raw;
  const sequence = responseText
    .split('->')
    .map((s) => s.trim())
    .filter(Boolean);
  // strip realm suffix from the player name for display (keep first token before '-')
  const whoRaw = whoMatch ? whoMatch[1].trim() : null;
  const who = whoRaw ? whoRaw.split('-')[0] : null;
  return {
    atSeconds: timeMatch ? parseFloat(timeMatch[1]) : null,
    who,
    hpPct: whoMatch ? parseInt(whoMatch[2], 10) : null,
    sequence,
    raw,
  };
}

// ── Archetype verdict ──────────────────────────────────────────────────────
// Heuristic playstyle read derived from the metric gaps (the LLM report carries
// the nuance; this is the at-a-glance label).
export interface ProArchetype {
  label: string;
  gist: string;
}

export function deriveArchetype(data: ComparativeAnalysisData): ProArchetype {
  const pro = computeProAverages(data.nearestNeighbors);
  const u = data.userMetrics;
  const passive = u.offensiveIndex < pro.offensiveIndex && u.ccDensity < pro.ccDensity;
  const reactive = u.reactionLatency > pro.reactionLatency || u.defensiveOverlapRatio > pro.defensiveOverlapRatio;
  const clean = u.effectiveCastRatio >= pro.effectiveCastRatio;

  let label: string;
  if (reactive && passive) label = 'Reactive & Passive';
  else if (passive) label = clean ? 'Clean but Passive' : 'Passive';
  else if (reactive) label = 'Reactive';
  else if (u.offensiveIndex > pro.offensiveIndex && u.ccDensity > pro.ccDensity) label = 'Aggressive';
  else label = 'Balanced vs cohort';

  const bits: string[] = [];
  if (passive) bits.push('output trails the cohort');
  if (reactive) bits.push('defensives commit late or overlap');
  if (clean && !passive && !reactive) bits.push('pacing and casts track the cohort');
  if (clean && (passive || reactive)) bits.push('casts stay clean');
  const gist = bits.length ? bits.join(', ') + '.' : 'Your shape closely matches the cohort.';
  return { label, gist: gist.charAt(0).toUpperCase() + gist.slice(1) };
}

// ── Coaching report (LLM markdown) ───────────────────────────────────────────
// The comparative prompt asks Claude for Markdown with "Global Pacing" and
// "Crisis Management" headers. Split it into the two sections for display.
export interface CoachingReport {
  globalPacing: string;
  crisisManagement: string;
}

export function parseCoachingReport(markdown: string): CoachingReport {
  if (!markdown) return { globalPacing: '', crisisManagement: '' };
  const headerRe = /^#{1,4}\s*(Global Pacing|Crisis Management)\s*$/gim;
  const marks: { name: string; index: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(markdown)) !== null) {
    marks.push({ name: m[1].toLowerCase(), index: m.index, end: headerRe.lastIndex });
  }
  const sliceFor = (name: string) => {
    const i = marks.findIndex((x) => x.name === name);
    if (i < 0) return '';
    const start = marks[i].end;
    const stop = i + 1 < marks.length ? marks[i + 1].index : markdown.length;
    return markdown.slice(start, stop).trim();
  };
  return {
    globalPacing: sliceFor('global pacing'),
    crisisManagement: sliceFor('crisis management'),
  };
}

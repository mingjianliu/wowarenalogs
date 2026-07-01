import { ReferenceVectorRecord } from '../../../utils/vectorSearch';
import { MetricKey } from './metricRegistry';

export interface CohortStat {
  mean: number;
  median: number;
  p25: number;
  p75: number;
  userPercentile: number | null;
  nReal: number;
}
export interface VerifiedComparison {
  player: string;
  spec: string;
  bracket: string;
  cohort: {
    n: number;
    uniquePlayers: number;
    leaderboardSelection: string;
    perMetric: Partial<Record<MetricKey, CohortStat>>;
  };
  notes: string[];
}
const THIN = 8;
type RecordMetrics = ReferenceVectorRecord['metrics'] | null | undefined;
// Maps a stored record's metrics block onto registry keys (note: record stores legacy `reactionLatency`).
const RECORD_KEYS: Array<[MetricKey, (m: RecordMetrics) => number | null]> = [
  ['offensiveIndex', (m) => m?.offensiveIndex ?? null],
  ['ccDensity', (m) => m?.ccDensity ?? null],
  ['responseLatencySec', (m) => m?.reactionLatency ?? null],
  ['defensiveOverlapRatio', (m) => m?.defensiveOverlapRatio ?? null],
  ['effectiveCastRatio', (m) => m?.effectiveCastRatio ?? null],
  ['ccAvoidanceRate', (m) => m?.ccAvoidanceRate ?? null],
];
const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

export function diversifyByPlayer<T extends { playerName: string }>(records: T[], capPerPlayer: number): T[] {
  const seen = new Map<string, number>();
  return records.filter((r) => {
    const c = seen.get(r.playerName) ?? 0;
    if (c >= capPerPlayer) return false;
    seen.set(r.playerName, c + 1);
    return true;
  });
}

export function buildVerifiedComparison(
  cellRecords: ReferenceVectorRecord[],
  userMetrics: Partial<Record<MetricKey, number | null>>,
  ctx: { player: string; spec: string; bracket: string },
): VerifiedComparison {
  const withMetrics = cellRecords.filter((r) => r.metrics != null);
  const uniquePlayers = new Set(withMetrics.map((r) => r.playerName)).size;
  const perMetric: Partial<Record<MetricKey, CohortStat>> = {};
  const notes: string[] = [];
  for (const [key, read] of RECORD_KEYS) {
    const vals = withMetrics.map((r) => read(r.metrics)).filter((v): v is number => typeof v === 'number');
    if (vals.length === 0) continue; // all null -> omit (no fake)
    const sorted = [...vals].sort((a, b) => a - b);
    const uv = userMetrics[key];
    const userPercentile = typeof uv === 'number' ? sorted.filter((v) => v <= uv).length / sorted.length : null;
    perMetric[key] = {
      mean: mean(vals),
      median: median(vals),
      p25: pct(sorted, 0.25),
      p75: pct(sorted, 0.75),
      userPercentile,
      nReal: vals.length,
    };
  }
  if (withMetrics.length < THIN) notes.push(`thin cohort (n=${withMetrics.length}) — percentiles are low-confidence`);
  return {
    player: ctx.player,
    spec: ctx.spec,
    bracket: ctx.bracket,
    cohort: { n: withMetrics.length, uniquePlayers, leaderboardSelection: '2300+ leaderboard selection', perMetric },
    notes,
  };
}

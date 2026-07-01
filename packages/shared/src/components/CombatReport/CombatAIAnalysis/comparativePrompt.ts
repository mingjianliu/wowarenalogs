// packages/shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.ts
//
// This module holds the LEGACY nearest-neighbor-average prompt (buildComparativePrompt /
// ComparativeAnalysisData), which the current ProComparison UI still consumes — do not remove
// it here. The new stats-led renderer over the full-cohort VerifiedComparison lives in
// ./comparativePrompt.stats and is re-exported below as a thin shim so callers can pick either
// variant from one import path. `/api/compare` currently flag-gates between the two; once the
// UI is rewired onto VerifiedComparison (a later plan), this file's legacy exports can be
// deleted and the shim collapsed.

export { buildStatsLedPrompt, collectServerNumbers } from './comparativePrompt.stats';

export interface ComparativeAnalysisData {
  playerName: string;
  spec: string;
  userMetrics: {
    offensiveIndex: number | null;
    ccDensity: number | null;
    reactionLatency: number | null;
    defensiveOverlapRatio: number | null;
    effectiveCastRatio: number | null;
    ccAvoidanceRate: number | null;
  };
  userCrisisEvents: string[];
  nearestNeighbors: Array<{
    distance: number;
    metrics: {
      offensiveIndex: number | null;
      ccDensity: number | null;
      reactionLatency: number | null;
      defensiveOverlapRatio: number | null;
      effectiveCastRatio: number | null;
      ccAvoidanceRate: number | null;
    };
    crisisEvents: string[];
  }>;
}

/** Average only the non-null values; returns null (never NaN/0) when there are none to average. */
function avgNonNull(values: Array<number | null>): number | null {
  const nonNull = values.filter((v): v is number => v !== null);
  return nonNull.length > 0 ? nonNull.reduce((a, b) => a + b, 0) / nonNull.length : null;
}

/** Render a metric value for the prompt: 'n/a' for null, never a fabricated 0/NaN. */
function fmt(value: number | null, suffix = ''): string {
  return value === null ? 'n/a' : `${value.toFixed(2)}${suffix}`;
}

export function buildComparativePrompt(data: ComparativeAnalysisData): string {
  const avgProOffensive = avgNonNull(data.nearestNeighbors.map((n) => n.metrics.offensiveIndex));
  const avgProCc = avgNonNull(data.nearestNeighbors.map((n) => n.metrics.ccDensity));
  const avgProLatency = avgNonNull(data.nearestNeighbors.map((n) => n.metrics.reactionLatency));
  const avgProDefOverlap = avgNonNull(data.nearestNeighbors.map((n) => n.metrics.defensiveOverlapRatio));
  const avgProEffCast = avgNonNull(data.nearestNeighbors.map((n) => n.metrics.effectiveCastRatio));
  const avgProCcAvoid = avgNonNull(data.nearestNeighbors.map((n) => n.metrics.ccAvoidanceRate));

  const proCrisisResponses = data.nearestNeighbors.flatMap((n) => n.crisisEvents).slice(0, 10); // Limit to top 10 examples

  return `You are an elite World of Warcraft PvP coach analyzing a ${data.spec} match.
Instead of general advice, provide a Differential Analysis by comparing the user (${data.playerName}) to the top 5 high-rated players who played the exact same talent build and rotational style.

### Global Metric Gaps:
- Offensive Index (Damage:Heal ratio): User [${fmt(data.userMetrics.offensiveIndex)}] vs Pro Average [${fmt(avgProOffensive)}]
- CC Density (CCs per min): User [${fmt(data.userMetrics.ccDensity)}] vs Pro Average [${fmt(avgProCc)}]
- Crisis Reaction Latency: User [${fmt(data.userMetrics.reactionLatency, 's')}] vs Pro Average [${fmt(avgProLatency, 's')}]
- Defensive Overlap Ratio (High = panic trading defensives with teammates): User [${fmt(data.userMetrics.defensiveOverlapRatio)}] vs Pro Average [${fmt(avgProDefOverlap)}]
- Effective Cast Ratio (Low = getting interrupted or poor positioning): User [${fmt(data.userMetrics.effectiveCastRatio)}] vs Pro Average [${fmt(avgProEffCast)}]
- CC Avoidance Rate (High = proactive use of Fade/Grounding/LoS): User [${fmt(data.userMetrics.ccAvoidanceRate)}] vs Pro Average [${fmt(avgProCcAvoid)}]

### User's Crisis Responses (<40% HP events):
${data.userCrisisEvents.length > 0 ? data.userCrisisEvents.map((e) => `- ${e}`).join('\n') : '- No major crisis events recorded.'}

### Pro Crisis Responses (Similar situations from Nearest Neighbors):
${proCrisisResponses.length > 0 ? proCrisisResponses.map((e) => `- ${e}`).join('\n') : '- No pro data available.'}

### Task:
Produce a coaching report that directly contrasts the user's decisions against the pros.
1. Identify if the user is playing too passively/aggressively based on the Global Metrics.
2. Compare the user's specific cooldown usage during Crisis Events to the Pro responses. Highlight what the pros cast differently (e.g. "You used X, but in 80% of similar scenarios, pros used Y").
Output strictly in Markdown format, with headers "Global Pacing" and "Crisis Management".`;
}

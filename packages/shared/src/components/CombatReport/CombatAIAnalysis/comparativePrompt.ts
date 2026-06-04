// packages/shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.ts

export interface ComparativeAnalysisData {
  playerName: string;
  spec: string;
  userMetrics: {
    offensiveIndex: number;
    ccDensity: number;
    reactionLatency: number;
    defensiveOverlapRatio: number;
    effectiveCastRatio: number;
    ccAvoidanceRate: number;
  };
  userCrisisEvents: string[];
  nearestNeighbors: Array<{
    distance: number;
    metrics: {
      offensiveIndex: number;
      ccDensity: number;
      reactionLatency: number;
      defensiveOverlapRatio: number;
      effectiveCastRatio: number;
      ccAvoidanceRate: number;
    };
    crisisEvents: string[];
  }>;
}

export function buildComparativePrompt(data: ComparativeAnalysisData): string {
  const count = data.nearestNeighbors.length;
  const sums = data.nearestNeighbors.reduce(
    (acc, n) => ({
      off: acc.off + n.metrics.offensiveIndex,
      cc: acc.cc + n.metrics.ccDensity,
      lat: acc.lat + n.metrics.reactionLatency,
      defOverlap: acc.defOverlap + n.metrics.defensiveOverlapRatio,
      effCast: acc.effCast + n.metrics.effectiveCastRatio,
      ccAvoid: acc.ccAvoid + n.metrics.ccAvoidanceRate,
    }),
    { off: 0, cc: 0, lat: 0, defOverlap: 0, effCast: 0, ccAvoid: 0 },
  );

  const avgProOffensive = count > 0 ? sums.off / count : 0;
  const avgProCc = count > 0 ? sums.cc / count : 0;
  const avgProLatency = count > 0 ? sums.lat / count : 0;
  const avgProDefOverlap = count > 0 ? sums.defOverlap / count : 0;
  const avgProEffCast = count > 0 ? sums.effCast / count : 0;
  const avgProCcAvoid = count > 0 ? sums.ccAvoid / count : 0;

  const proCrisisResponses = data.nearestNeighbors.flatMap((n) => n.crisisEvents).slice(0, 10); // Limit to top 10 examples

  return `You are an elite World of Warcraft PvP coach analyzing a ${data.spec} match.
Instead of general advice, provide a Differential Analysis by comparing the user (${data.playerName}) to the top 5 high-rated players who played the exact same talent build and rotational style.

### Global Metric Gaps:
- Offensive Index (Damage:Heal ratio): User [${data.userMetrics.offensiveIndex.toFixed(2)}] vs Pro Average [${avgProOffensive.toFixed(2)}]
- CC Density (CCs per min): User [${data.userMetrics.ccDensity.toFixed(2)}] vs Pro Average [${avgProCc.toFixed(2)}]
- Crisis Reaction Latency: User [${data.userMetrics.reactionLatency.toFixed(2)}s] vs Pro Average [${avgProLatency.toFixed(2)}s]
- Defensive Overlap Ratio (High = panic trading defensives with teammates): User [${data.userMetrics.defensiveOverlapRatio.toFixed(2)}] vs Pro Average [${avgProDefOverlap.toFixed(2)}]
- Effective Cast Ratio (Low = getting interrupted or poor positioning): User [${data.userMetrics.effectiveCastRatio.toFixed(2)}] vs Pro Average [${avgProEffCast.toFixed(2)}]
- CC Avoidance Rate (High = proactive use of Fade/Grounding/LoS): User [${data.userMetrics.ccAvoidanceRate.toFixed(2)}] vs Pro Average [${avgProCcAvoid.toFixed(2)}]

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

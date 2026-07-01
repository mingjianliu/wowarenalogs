// comparativePrompt.exemplar.ts
//
// Implementation B (exemplar-led) — the A/B counterpart to comparativePrompt.stats.ts.
// Instead of leading with cohort percentiles, it leads with CONCRETE, real, diversified pro crisis
// responses ("in a spot like your 60s crisis, a comparable pro did X -> Y -> Z"), with a verified
// metric delta as support. All sequences are server-provided (drawn from the cohort's stored crisis
// events, diversified per player); the model is instructed to narrate ONLY the provided pro
// sequences and numbers — no invented frequencies, no "% of pros".
//
// NOTE: pro crisis spell names are English only once the corpus is reindexed (englishSpellName runs
// at extraction). Until then they may appear in the source client locale — a data caveat, not an
// approach flaw. The user's own crisis sequences are freshly extracted (English).

import { METRIC_REGISTRY, MetricKey } from './metricRegistry';
import { VerifiedComparison } from './verifiedComparison';

export interface ExemplarInput {
  player: string;
  spec: string;
  bracket: string;
  userCrises: string[]; // user's <40%-HP response sequences (fresh extraction, English)
  proCrises: string[]; // diversified real pro crisis responses from the cohort
  vc: VerifiedComparison; // for the sample disclosure + one or two headline deltas
}

/** The metric where the user is furthest on the WORSE side of the cohort median — the coaching hook. */
function headlineGap(vc: VerifiedComparison): string | null {
  let worst: { label: string; txt: string; gap: number } | null = null;
  for (const key of Object.keys(vc.cohort.perMetric) as MetricKey[]) {
    const s = vc.cohort.perMetric[key];
    if (!s || s.userPercentile === null) continue;
    const def = METRIC_REGISTRY[key];
    // For higher=better, low percentile is bad; for lower=better, high percentile is bad.
    const badness = def.valence === 'lower' ? s.userPercentile : 1 - s.userPercentile;
    if (badness > 0 && (worst === null || badness > worst.gap)) {
      worst = {
        label: def.label,
        gap: badness,
        txt: `${def.label}: you are ${Math.round(s.userPercentile * 100)}th percentile (cohort median ${s.median.toFixed(2)}${def.unit}, n=${s.nReal})`,
      };
    }
  }
  return worst ? worst.txt : null;
}

export function buildExemplarLedPrompt(x: ExemplarInput): string {
  const userBlock = x.userCrises.length
    ? x.userCrises.map((c) => `- ${c}`).join('\n')
    : '- No <40% HP crisis events recorded this game.';
  const proBlock = x.proCrises.length
    ? x.proCrises.map((c) => `- ${c}`).join('\n')
    : '- No comparable pro crisis responses available.';
  const gap = headlineGap(x.vc);

  return `You are a WoW arena coach for ${x.player} (${x.spec}, ${x.bracket}). Coach by CONTRAST against real high-rated players from a cohort of ${x.vc.cohort.uniquePlayers} 2300+ players.

### Your crisis responses (teammate <40% HP → what you cast):
${userBlock}

### What comparable pros did in similar crises (real, server-provided sequences — do NOT invent others):
${proBlock}

### One verified standing to anchor the advice${gap ? ' (server-computed — do not alter):' : ':'}
${gap ? `- ${gap}` : '- (insufficient data for a percentile anchor)'}

### Task:
Contrast the player's crisis responses with the pro sequences above and give the single highest-value change. Follow these rules exactly:
- Cite ONLY spells that appear in the sequences above, and ONLY the number(s) in the verified-standing line — never state a percentile, count, or spell not shown here.
- Do NOT use absolute quantifiers about the pros ("always", "never", "every", "consistently", "far more often"). Describe only what the shown sequences literally contain — e.g. "in 2 of the 3 pro crises shown".
- "Your crisis responses" are the PLAYER's own casts; the pro sequences are a separate group — never attribute the player's casts to a pro or vice versa.
Output Markdown with a "Crisis Management" header.`;
}

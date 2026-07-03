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

import { METRIC_REGISTRY, MetricDef, MetricKey } from './metricRegistry';
import { VerifiedComparison } from './verifiedComparison';

export interface ExemplarInput {
  player: string;
  spec: string;
  bracket: string;
  userCrises: string[]; // user's <40%-HP response sequences (fresh extraction, English)
  proCrises: string[]; // diversified real pro crisis responses from the cohort
  vc: VerifiedComparison; // for the sample disclosure + one or two headline deltas
}

/**
 * The metric where the user is furthest on the WORSE side of the cohort median — the coaching hook.
 * PREFERS metrics that are actually moved by <40%-HP crisis-window cast choices (offensiveIndex,
 * ccDensity, ccAvoidanceRate), falling back to a non-crisis metric (latency / ECR) ONLY if no
 * crisis-actionable metric is on the worse side. This is the fix for the meta-eval finding that
 * anchoring the crisis contrast on responseLatencySec / effectiveCastRatio produces wrong-cause /
 * inverted coaching 72–100% of the time (META-EVAL-EXEMPLAR-REPORT.md §2/§4).
 */
type AnchorCand = { def: MetricDef; badness: number; pct: number; median: number; nReal: number };

function pickAnchor(vc: VerifiedComparison): AnchorCand | null {
  let bestActionable: AnchorCand | null = null;
  let bestFallback: AnchorCand | null = null;
  for (const key of Object.keys(vc.cohort.perMetric) as MetricKey[]) {
    const s = vc.cohort.perMetric[key];
    if (!s || s.userPercentile === null) continue;
    const def = METRIC_REGISTRY[key];
    // Higher=better → low percentile is bad; lower=better → high percentile is bad; context → never an anchor.
    const badness = def.valence === 'higher' ? 1 - s.userPercentile : def.valence === 'lower' ? s.userPercentile : 0;
    if (badness <= 0) continue;
    const cand = { def, badness, pct: Math.round(s.userPercentile * 100), median: s.median, nReal: s.nReal };
    const slot = def.crisisActionable ? 'actionable' : 'fallback';
    if (slot === 'actionable') {
      if (!bestActionable || badness > bestActionable.badness) bestActionable = cand;
    } else if (!bestFallback || badness > bestFallback.badness) {
      bestFallback = cand;
    }
  }
  return bestActionable ?? bestFallback ?? null;
}

/** Render the verified-standing block: percentile + explicit direction + what-moves-it + a CONTEXT-ONLY
 *  guard when the metric is not moved by the crisis-window casts (so the coach can't misattribute it). */
function renderStanding(a: ReturnType<typeof pickAnchor>): { header: string; body: string; contextOnly: boolean } {
  if (!a) {
    return {
      header: 'One verified standing:',
      body: '- (insufficient data for a percentile anchor)',
      contextOnly: false,
    };
  }
  const dir = a.def.valence === 'lower' ? 'lower is better' : a.def.valence === 'higher' ? 'higher is better' : '';
  const lines = [
    `- ${a.def.label}: you are ${a.pct}th percentile (cohort median ${a.median.toFixed(2)}${a.def.unit}, n=${a.nReal})${dir ? ` — ${dir}` : ''}.`,
    `  What actually moves this number: ${a.def.driver}.`,
  ];
  if (!a.def.crisisActionable) {
    lines.push(
      `  CONTEXT ONLY: this number is NOT changed by the <40%-HP crisis-window cast choices below — it measures something else. Use it as background; do NOT claim the crisis change will move it.`,
    );
  }
  return {
    header: a.def.crisisActionable
      ? 'One verified standing to anchor the advice (server-computed — do not alter):'
      : 'One verified standing for context (server-computed — do not alter):',
    body: lines.join('\n'),
    contextOnly: !a.def.crisisActionable,
  };
}

export function buildExemplarLedPrompt(x: ExemplarInput): string {
  const userBlock = x.userCrises.length
    ? x.userCrises.map((c) => `- ${c}`).join('\n')
    : '- No <40% HP crisis events recorded this game.';
  const proCount = x.proCrises.length;
  const proBlock = proCount
    ? x.proCrises.map((c) => `- ${c}`).join('\n')
    : '- No comparable pro crisis responses available.';
  const standing = renderStanding(pickAnchor(x.vc));
  const contextRule = standing.contextOnly
    ? `\n- The verified-standing line is marked CONTEXT ONLY: base your highest-value change on the crisis-sequence contrast, mention the standing only as background, and do NOT claim the change will move that number (it measures something the crisis casts don't affect). Read the number in the direction stated (do not invert it).`
    : `\n- Read the verified-standing number in the direction stated on its line (do not invert it), and only claim the change moves it if that is what the "What actually moves this number" line says.`;

  return `You are a WoW arena coach for ${x.player} (${x.spec}, ${x.bracket}). Coach by CONTRAST against real high-rated players from a cohort of ${x.vc.cohort.uniquePlayers} 2300+ players.

### Your crisis responses (teammate <40% HP → what you cast):
${userBlock}

### What comparable pros did in similar crises${proCount ? ` (${proCount} shown — cite pro counts as "N of ${proCount}")` : ''} (real, server-provided sequences — do NOT invent others):
${proBlock}

### ${standing.header}
${standing.body}

### Task:
Contrast the player's crisis responses with the pro sequences above and give the single highest-value change. Follow these rules exactly:
- Cite ONLY spells that appear in the sequences above, and ONLY the number(s) in the verified-standing line — never state a percentile, count, or spell not shown here.
- Do NOT use absolute quantifiers about the pros ("always", "never", "every", "consistently", "far more often"). Describe only what the shown sequences literally contain, and use the EXACT number of shown pro crises as the denominator${proCount ? ` — there are ${proCount} pro crises shown, so say "N of ${proCount}", never a larger total` : ''}. E.g. "in 2 of the ${proCount || 'N'} pro crises shown".
- "Your crisis responses" are the PLAYER's own casts; the pro sequences are a separate group — never attribute the player's casts to a pro or vice versa.
- Survival first: in a <40%-HP crisis the teammate living is the priority. NEVER advise healing less, skipping/delaying the save, or trading it for damage. If the verified standing reflects an offensive tendency (e.g. weaving damage), frame that ONLY as instant casts slotted BETWEEN heals that do not delay the save — never as a reason to heal less mid-crisis.${contextRule}
Output Markdown with a "Crisis Management" header.`;
}

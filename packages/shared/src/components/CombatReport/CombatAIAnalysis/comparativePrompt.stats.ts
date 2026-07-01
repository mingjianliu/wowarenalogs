// packages/shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.stats.ts
//
// Stats-led comparative prompt: renders ONLY server-computed VerifiedComparison numbers
// (full-cohort mean/median/p25/p75/userPercentile, disclosed nReal), labeled via the
// METRIC_REGISTRY (single source of truth for label/definition/valence — see B123/B132/B134),
// and instructs the model to narrate rather than invent any figures. This replaces the
// nearest-neighbor-average approach (comparativePrompt.ts / buildComparativePrompt), which
// could fabricate a "Pro Average" of 0 when every neighbor was null (see Task 2 fix c2ee6c32)
// and only ever compared against 5 matches instead of the full cohort cell.

import { METRIC_REGISTRY, MetricKey } from './metricRegistry';
import { VerifiedComparison } from './verifiedComparison';

function valenceLabel(valence: 'higher' | 'lower' | 'context'): string {
  if (valence === 'lower') return 'lower=better';
  if (valence === 'higher') return 'higher=better';
  return 'context-dependent';
}

function percentileLabel(userPercentile: number | null): string {
  return userPercentile === null ? 'n/a' : `${Math.round(userPercentile * 100)}th`;
}

export function buildStatsLedPrompt(vc: VerifiedComparison): string {
  const lines: string[] = [];
  for (const key of Object.keys(vc.cohort.perMetric) as MetricKey[]) {
    const def = METRIC_REGISTRY[key];
    const s = vc.cohort.perMetric[key];
    if (!s) continue; // Object.keys only yields present keys, but Partial<> types it optional
    lines.push(
      `- ${def.label} (${def.definition} ${valenceLabel(def.valence)}): cohort median ${s.median.toFixed(2)}${def.unit} (n=${s.nReal}); your percentile ${percentileLabel(s.userPercentile)}`,
    );
  }

  return `You are a WoW arena coach comparing ${vc.player} (${vc.spec}, ${vc.bracket}) to a cohort of ${vc.cohort.uniquePlayers} ${vc.cohort.leaderboardSelection} players.

### Verified standing (server-computed — DO NOT INVENT or alter any number):
${lines.join('\n')}

### Notes: ${vc.notes.join('; ') || 'none'}

### Task:
Narrate the player's standing and the single highest-value adjustment. Use ONLY the numbers above. Do not state any percentage or count not present here. Output Markdown with a "Global Pacing" header.`;
}

// Same tokenizer claimChecker.checkClaims uses to scan a draft for numbers/percentages, applied
// here to the *rendered prompt* instead. Scanning the actual prompt text (rather than
// re-deriving an allow-list from the raw VerifiedComparison fields) guarantees the allow-list is
// rounded/formatted identically to what the model was shown — including incidental numbers such
// as bracket digits ("3v3") and the leaderboard-selection threshold ("2300+") — so the numbers
// gate in /api/compare never flags a value the model was legitimately given.
const NUMBER_TOKEN_RE = /\d+(?:\.\d+)?%?/g;

export function collectServerNumbers(vc: VerifiedComparison): number[] {
  const prompt = buildStatsLedPrompt(vc);
  const nums = new Set<number>();
  for (const tok of prompt.match(NUMBER_TOKEN_RE) ?? []) {
    nums.add(parseFloat(tok.replace('%', '')));
  }
  return Array.from(nums);
}

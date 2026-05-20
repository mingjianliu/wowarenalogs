/**
 * archetypeInjection.ts — Match archetype classification for prompt injection.
 *
 * Classifies a match into one of the bracket-specific game-situation archetypes
 * and returns a one-line `[MATCH TYPE: label]` header to prepend to the analysis prompt.
 *
 * Archetypes describe what the enemy team is doing, not the healer's spec.
 * Globally clustered (K=8 per bracket) — see cluster-eval-report.md for validation.
 *
 * The classification follows the same 7-dimension feature vector and log transforms
 * used by buildArchetypePrompts.ts. Any change to that vector must be mirrored here.
 */

import model3v3 from '../data/archetypes/archetype_model_3v3.json';
import modelSoloShuffle from '../data/archetypes/archetype_model_solo_shuffle.json';
import prompts3v3 from '../data/archetypes/archetype_prompts_3v3.json';
import promptsSoloShuffle from '../data/archetypes/archetype_prompts_solo_shuffle.json';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IArchetypeModelData {
  normParams: { min: number[]; max: number[] };
  featureNames: string[];
  centroids: number[][];
}

export interface IArchetypeClusterPrompt {
  label: string;
  isNoise: boolean;
  promptText: string;
  matchCount: number;
}

export interface IMatchDynamicsForInjection {
  burstWindowCount: number;
  ccEventsPerMinute: number;
  /** Damage share on the most-targeted friendly. 1.0 = pure tunnel; 0.33 = perfect 3-way split. */
  tunnelScore: number;
  peakBurstScore: number;
  criticalOrExposedBurstWindows: number;
  durationSeconds: number;
  ownTeamCCPerMin: number;
}

export interface IArchetypeClassification {
  clusterKey: string;
  label: string;
  isNoise: boolean;
  promptText: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Below this duration, archetype injection is suppressed — too little signal. */
const MIN_DURATION_SECONDS_FOR_INJECTION = 30;

// ── Bracket detection ─────────────────────────────────────────────────────────

export type ArchetypeBracket = '3v3' | 'solo_shuffle';

/**
 * Maps the raw bracket string from combat metadata to the archetype slug.
 * Returns null for brackets we don't have a model for (2v2, BG Blitz, etc.).
 */
export function bracketToArchetypeSlug(bracket: string | undefined | null): ArchetypeBracket | null {
  if (!bracket) return null;
  const lower = bracket.toLowerCase();
  if (lower.includes('solo')) return 'solo_shuffle';
  if (lower.includes('3v3')) return '3v3';
  return null;
}

// ── Feature vector + classification ───────────────────────────────────────────

/**
 * Build the 7-dimension feature vector for classification.
 *
 * MUST match buildArchetypePrompts.ts::toFeatureVector exactly — including the
 * log transforms on peakBurstScore and durationSeconds. Drift between the two
 * means new matches classify against centroids built from a different feature space.
 */
function toFeatureVector(d: IMatchDynamicsForInjection): number[] {
  return [
    d.burstWindowCount,
    d.ccEventsPerMinute,
    d.tunnelScore,
    Math.log1p(d.peakBurstScore),
    d.criticalOrExposedBurstWindows,
    Math.log1p(d.durationSeconds),
    d.ownTeamCCPerMin,
  ];
}

function normalize(v: number[], params: { min: number[]; max: number[] }): number[] {
  return v.map((x, i) => {
    const range = params.max[i] - params.min[i];
    return range > 0 ? (x - params.min[i]) / range : 0;
  });
}

function euclidean(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function nearestCentroid(vec: number[], centroids: number[][]): { clusterKey: string; distance: number } {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < centroids.length; i++) {
    const dist = euclidean(vec, centroids[i]);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return { clusterKey: `cluster_${bestIdx}`, distance: bestDist };
}

// ── Data accessors ────────────────────────────────────────────────────────────

function getModel(slug: ArchetypeBracket): IArchetypeModelData {
  return (slug === 'solo_shuffle' ? modelSoloShuffle : model3v3) as IArchetypeModelData;
}

function getPrompts(slug: ArchetypeBracket): Record<string, IArchetypeClusterPrompt> {
  return (slug === 'solo_shuffle' ? promptsSoloShuffle : prompts3v3) as Record<string, IArchetypeClusterPrompt>;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify a match into its archetype. Returns the cluster, label, and narrative —
 * including for noise clusters (callers decide whether to inject).
 *
 * Returns null if:
 *   - Bracket is unsupported (e.g., 2v2)
 *   - The classified cluster has no prompt entry (shouldn't happen for valid models)
 */
export function classifyMatchArchetype(
  bracket: string | undefined | null,
  dynamics: IMatchDynamicsForInjection,
): IArchetypeClassification | null {
  const slug = bracketToArchetypeSlug(bracket);
  if (!slug) return null;

  const model = getModel(slug);
  const prompts = getPrompts(slug);

  const vec = normalize(toFeatureVector(dynamics), model.normParams);
  const { clusterKey } = nearestCentroid(vec, model.centroids);

  const cluster = prompts[clusterKey];
  if (!cluster) return null;

  return {
    clusterKey,
    label: cluster.label,
    isNoise: cluster.isNoise,
    promptText: cluster.promptText,
  };
}

/**
 * Build the [MATCH TYPE: label] header line for prompt injection.
 *
 * Returns empty string when injection should be skipped:
 *   - Bracket unsupported
 *   - Duration below the minimum (too little signal in short rounds)
 *   - Classification landed in a noise cluster (one-sided fast wins, no coaching value)
 */
export function buildArchetypeInjectionHeader(
  bracket: string | undefined | null,
  dynamics: IMatchDynamicsForInjection,
): string {
  if (dynamics.durationSeconds < MIN_DURATION_SECONDS_FOR_INJECTION) return '';

  const result = classifyMatchArchetype(bracket, dynamics);
  if (!result) return '';
  if (result.isNoise) return '';

  return `[MATCH TYPE: ${result.label}]`;
}

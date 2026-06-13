import { computeTfIdf, meanStd, weightedConcat, zScore } from './vectorMath';

export interface MatchEmbeddingData {
  talentIds: number[];
  rotationSequences: Record<string, number>;
  totalSequences: number;
  offensiveIndex: number;
  ccDensity: number;
  reactionLatency: number;
  defensiveOverlapRatio: number;
  effectiveCastRatio: number;
  ccAvoidanceRate: number;
  metricsAvailable: boolean;
}

export interface IBehaviorNormParams {
  offensiveIndex: { mean: number; std: number };
  ccDensity: { mean: number; std: number };
  reactionLatency: { mean: number; std: number };
}

export interface IBlockWeights {
  talent: number;
  rotation: number;
  behavior: number;
}

/**
 * Everything needed to vectorize a match into the corpus space. Persisted as reference_model.json
 * and passed to both the corpus builder and the live `vectorizeMatch` path.
 */
export interface IReferenceModel {
  totalDocs: number;
  sequenceDocFrequency: Record<string, number>;
  sequenceVocab: Record<string, number>; // sequence text -> dimension index
  talentVocab: Record<string, number>; // talent id (string) -> dimension index
  behaviorNormParams: IBehaviorNormParams;
  blockWeights: IBlockWeights;
  dims: { talent: number; rotation: number; behavior: number; total: number };
}

const REACTION_LATENCY_SENTINEL = 1.5;
const BEHAVIOR_DIMS = 3;
const DEFAULT_BLOCK_WEIGHTS: IBlockWeights = { talent: 1 / 3, rotation: 1 / 3, behavior: 1 / 3 };

/** Matches a corpus rotation entry like `"Penance -> PW:S (used 3x)"` → ["…", "Penance -> PW:S", "3"]. */
const SEQUENCE_USAGE_RE = /^(.*?) \(used (\d+)x\)$/;

export function generateMatchVector(data: MatchEmbeddingData, model: IReferenceModel): number[] {
  // Talent block — exact vocab, binary.
  const talentBlock = new Array(model.dims.talent).fill(0);
  for (const id of data.talentIds) {
    const idx = model.talentVocab[String(id)];
    if (idx !== undefined) talentBlock[idx] = 1;
  }

  // Rotation block — exact vocab, smoothed TF-IDF.
  const rotationBlock = new Array(model.dims.rotation).fill(0);
  for (const [seq, freq] of Object.entries(data.rotationSequences)) {
    const idx = model.sequenceVocab[seq];
    if (idx === undefined) continue; // out-of-vocabulary sequence contributes nothing
    rotationBlock[idx] = computeTfIdf(freq, data.totalSequences, model.totalDocs, model.sequenceDocFrequency[seq] || 0);
  }

  // Behavior block — 3 z-scored scalars. Absent metrics → neutral zeros; latency sentinel → 0.
  const np = model.behaviorNormParams;
  const behaviorBlock = data.metricsAvailable
    ? [
        zScore(data.offensiveIndex, np.offensiveIndex.mean, np.offensiveIndex.std),
        zScore(data.ccDensity, np.ccDensity.mean, np.ccDensity.std),
        data.reactionLatency === REACTION_LATENCY_SENTINEL
          ? 0
          : zScore(data.reactionLatency, np.reactionLatency.mean, np.reactionLatency.std),
      ]
    : [0, 0, 0];

  return weightedConcat(
    [talentBlock, rotationBlock, behaviorBlock],
    [model.blockWeights.talent, model.blockWeights.rotation, model.blockWeights.behavior],
  );
}

/** Loose shape of a corpus/match record — only the fields the embedding reads. */
export interface RawMatchRecord {
  rotations?: { coreSequences?: string[] };
  pythonResult?: { nodes_info?: Record<string, unknown> };
  offensiveIndex?: unknown;
  ccDensity?: unknown;
  reactionLatency?: unknown;
  defensiveOverlapRatio?: unknown;
  effectiveCastRatio?: unknown;
  ccAvoidanceRate?: unknown;
}

/**
 * Parse a raw corpus/match record into structured embedding input.
 *
 * Centralizes rotation `coreSequences` parsing, talent extraction, and scalar defaults so the
 * corpus builder (processAndUploadVectors) and any live caller produce identical vectors. Anything
 * that touches how a match becomes a vector belongs here, not inlined at the call site.
 */
export function parseMatchEmbeddingData(raw: RawMatchRecord): MatchEmbeddingData {
  const rotationSequences: Record<string, number> = {};
  let totalSequences = 0;

  const coreSequences: string[] | undefined = raw?.rotations?.coreSequences;
  if (coreSequences) {
    for (const seqString of coreSequences) {
      const m = seqString.match(SEQUENCE_USAGE_RE);
      if (m) {
        const seq = m[1];
        const count = parseInt(m[2], 10);
        rotationSequences[seq] = count;
        totalSequences += count;
      }
    }
  }

  const num = (val: unknown, fallback: number): number => (typeof val === 'number' ? val : fallback);

  const talentIds = raw?.pythonResult?.nodes_info
    ? Object.keys(raw.pythonResult.nodes_info)
        .map((id) => parseInt(id, 10))
        .filter((id) => !isNaN(id))
    : [];

  const metricsAvailable = [
    raw?.offensiveIndex,
    raw?.ccDensity,
    raw?.reactionLatency,
    raw?.defensiveOverlapRatio,
    raw?.effectiveCastRatio,
    raw?.ccAvoidanceRate,
  ].every((v) => typeof v === 'number');

  return {
    talentIds,
    rotationSequences,
    totalSequences,
    offensiveIndex: num(raw?.offensiveIndex, 0.5),
    ccDensity: num(raw?.ccDensity, 1.0),
    reactionLatency: num(raw?.reactionLatency, 1.5),
    defensiveOverlapRatio: num(raw?.defensiveOverlapRatio, 0),
    effectiveCastRatio: num(raw?.effectiveCastRatio, 1.0),
    ccAvoidanceRate: num(raw?.ccAvoidanceRate, 0),
    metricsAvailable,
  };
}

/**
 * First pass over the corpus: derive the exact vocabularies, document frequencies, and behavior
 * normalization parameters needed to vectorize every match (and any future live match) consistently.
 */
export function buildReferenceModel(
  records: RawMatchRecord[],
  blockWeights: IBlockWeights = DEFAULT_BLOCK_WEIGHTS,
): IReferenceModel {
  const sequenceVocab: Record<string, number> = {};
  const talentVocab: Record<string, number> = {};
  const sequenceDocFrequency: Record<string, number> = {};
  const offensiveValues: number[] = [];
  const ccValues: number[] = [];
  const latencyValues: number[] = [];

  for (const raw of records) {
    const data = parseMatchEmbeddingData(raw);

    for (const seq of Object.keys(data.rotationSequences)) {
      if (!(seq in sequenceVocab)) sequenceVocab[seq] = Object.keys(sequenceVocab).length;
      sequenceDocFrequency[seq] = (sequenceDocFrequency[seq] || 0) + 1;
    }
    for (const id of data.talentIds) {
      const key = String(id);
      if (!(key in talentVocab)) talentVocab[key] = Object.keys(talentVocab).length;
    }

    if (data.metricsAvailable) {
      offensiveValues.push(data.offensiveIndex);
      ccValues.push(data.ccDensity);
      if (data.reactionLatency !== REACTION_LATENCY_SENTINEL) latencyValues.push(data.reactionLatency);
    }
  }

  const talentDim = Object.keys(talentVocab).length;
  const rotationDim = Object.keys(sequenceVocab).length;

  return {
    totalDocs: records.length,
    sequenceDocFrequency,
    sequenceVocab,
    talentVocab,
    behaviorNormParams: {
      offensiveIndex: meanStd(offensiveValues),
      ccDensity: meanStd(ccValues),
      reactionLatency: meanStd(latencyValues),
    },
    blockWeights,
    dims: {
      talent: talentDim,
      rotation: rotationDim,
      behavior: BEHAVIOR_DIMS,
      total: talentDim + rotationDim + BEHAVIOR_DIMS,
    },
  };
}

/**
 * Vectorize a single raw match record into the corpus embedding space using a persisted model.
 * This is the live path: fresh user match + reference model → an embedding comparable to the index.
 */
export function vectorizeMatch(raw: RawMatchRecord, model: IReferenceModel): number[] {
  return generateMatchVector(parseMatchEmbeddingData(raw), model);
}

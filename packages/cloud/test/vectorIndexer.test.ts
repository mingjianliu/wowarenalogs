import {
  buildReferenceModel,
  generateMatchVector,
  parseMatchEmbeddingData,
  vectorizeMatch,
} from '../src/vectorIndexer';

const recordA = {
  rotations: { coreSequences: ['Penance -> PW:S (used 3x)', 'Smite -> Smite (used 2x)'] },
  pythonResult: { nodes_info: { '100': {}, '200': {} } },
  offensiveIndex: 0.4,
  ccDensity: 1.2,
  reactionLatency: 2.0,
  defensiveOverlapRatio: 0.1,
  effectiveCastRatio: 0.98,
  ccAvoidanceRate: 0.1,
};

const recordB = {
  rotations: { coreSequences: ['Penance -> PW:S (used 1x)'] },
  pythonResult: { nodes_info: { '100': {}, '300': {} } },
  offensiveIndex: 0.6,
  ccDensity: 0.8,
  reactionLatency: 1.5, // a genuine measured latency — no sentinel handling anymore
  defensiveOverlapRatio: 0,
  effectiveCastRatio: 1.0,
  ccAvoidanceRate: 0,
};

describe('parseMatchEmbeddingData', () => {
  it('reports metricsAvailable true when all six scalars are numbers', () => {
    expect(parseMatchEmbeddingData(recordA).metricsAvailable).toBe(true);
  });

  it('reports metricsAvailable false when a scalar is missing', () => {
    const { offensiveIndex: _offensiveIndex, ...rest } = recordA;
    expect(parseMatchEmbeddingData(rest).metricsAvailable).toBe(false);
  });
});

describe('buildReferenceModel', () => {
  const model = buildReferenceModel([recordA, recordB]);

  it('builds exact sequence and talent vocabularies', () => {
    expect(Object.keys(model.sequenceVocab).sort()).toEqual(['Penance -> PW:S', 'Smite -> Smite'].sort());
    expect(Object.keys(model.talentVocab).sort()).toEqual(['100', '200', '300'].sort());
  });

  it('counts document frequency per sequence', () => {
    expect(model.sequenceDocFrequency['Penance -> PW:S']).toBe(2);
    expect(model.sequenceDocFrequency['Smite -> Smite']).toBe(1);
  });

  it('sets dims from vocab sizes plus 3 behavior dims', () => {
    expect(model.dims.talent).toBe(3);
    expect(model.dims.rotation).toBe(2);
    expect(model.dims.behavior).toBe(3);
    expect(model.dims.total).toBe(8);
  });

  it('includes every real (non-null) reactionLatency value in norm stats — no sentinel exclusion', () => {
    expect(model.behaviorNormParams.reactionLatency.mean).toBeCloseTo(1.75);
    expect(model.behaviorNormParams.reactionLatency.std).toBeCloseTo(0.25);
  });

  it('defaults to equal block weights', () => {
    expect(model.blockWeights.talent).toBeCloseTo(1 / 3);
    expect(model.blockWeights.rotation).toBeCloseTo(1 / 3);
    expect(model.blockWeights.behavior).toBeCloseTo(1 / 3);
  });
});

describe('generateMatchVector', () => {
  const model = buildReferenceModel([recordA, recordB]);

  it('produces a vector of length dims.total that is unit norm', () => {
    const vec = generateMatchVector(parseMatchEmbeddingData(recordA), model);
    expect(vec).toHaveLength(model.dims.total);
    expect(Math.sqrt(vec.reduce((s, v) => s + v * v, 0))).toBeCloseTo(1);
  });

  it('zeroes the behavior block dims when metrics are unavailable', () => {
    const {
      offensiveIndex: _offensiveIndex,
      ccDensity: _ccDensity,
      reactionLatency: _reactionLatency,
      ...rest
    } = recordA;
    const vec = generateMatchVector(parseMatchEmbeddingData(rest), model);
    const behavior = vec.slice(model.dims.talent + model.dims.rotation);
    expect(behavior).toEqual([0, 0, 0]);
  });

  it('zeroes only the latency behavior dim when reactionLatency is null (honest "no data", not a sentinel)', () => {
    const data = { ...parseMatchEmbeddingData(recordA), reactionLatency: null };
    const vec = generateMatchVector(data, model);
    const latencyDim = vec[model.dims.talent + model.dims.rotation + 2];
    expect(latencyDim).toBe(0);
  });

  it('vectorizeMatch reproduces generateMatchVector(parse(raw), model)', () => {
    const expected = generateMatchVector(parseMatchEmbeddingData(recordA), model);
    expect(vectorizeMatch(recordA, model)).toEqual(expected);
  });
});

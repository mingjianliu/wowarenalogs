import { generateMatchVector, parseMatchEmbeddingData, vectorizeMatch } from '../src/vectorIndexer';

describe('Vector Indexing', () => {
  it('should generate a 516-dimension vector from match data', () => {
    const mockData = {
      talentIds: [82556, 82564], // Simulated Discipline Priest talents
      rotationSequences: { 'Penance -> PW:S': 3 },
      totalSequences: 10,
      offensiveIndex: 0.5,
      ccDensity: 1.2,
      reactionLatency: 0.8,
      defensiveOverlapRatio: 0.2,
      effectiveCastRatio: 0.7,
      ccAvoidanceRate: 0.1,
    };
    const mockGlobalIdf = { 'Penance -> PW:S': 50 }; // docFrequency out of 1282

    const vector = generateMatchVector(mockData, mockGlobalIdf, 1282);

    expect(vector.length).toBe(516);
    // Ensure it's normalized
    const magnitude = Math.sqrt(vector.reduce((acc, val) => acc + val * val, 0));
    expect(magnitude).toBeCloseTo(1);
  });

  it('should not collide sequential modulo talent IDs', () => {
    // 82500 % 300 = 100
    // 82800 % 300 = 100
    // Under the old system, both would map to 200 + 100 = 300.
    // Under the new bit-mixed hashing system, they should map to different indices.
    const mockData1 = {
      talentIds: [82500],
      rotationSequences: {},
      totalSequences: 0,
      offensiveIndex: 0,
      ccDensity: 0,
      reactionLatency: 0,
      defensiveOverlapRatio: 0,
      effectiveCastRatio: 0,
      ccAvoidanceRate: 0,
    };
    const mockData2 = {
      talentIds: [82800],
      rotationSequences: {},
      totalSequences: 0,
      offensiveIndex: 0,
      ccDensity: 0,
      reactionLatency: 0,
      defensiveOverlapRatio: 0,
      effectiveCastRatio: 0,
      ccAvoidanceRate: 0,
    };

    const vector1 = generateMatchVector(mockData1, {}, 1);
    const vector2 = generateMatchVector(mockData2, {}, 1);

    // Find the non-zero talent index for each vector
    const index1 = vector1.findIndex((val, i) => i >= 200 && i < 500 && val > 0);
    const index2 = vector2.findIndex((val, i) => i >= 200 && i < 500 && val > 0);

    expect(index1).not.toBe(-1);
    expect(index2).not.toBe(-1);
    expect(index1).not.toBe(index2);
  });
});

describe('parseMatchEmbeddingData', () => {
  it('parses rotation sequences, talents, and scalars from a raw corpus record', () => {
    const raw = {
      rotations: { coreSequences: ['Penance -> PW:S (used 3x)', 'Shield -> Smite (used 2x)'] },
      pythonResult: { nodes_info: { '82556': {}, '82564': {} } },
      offensiveIndex: 0.42,
      ccDensity: 1.46,
      reactionLatency: 0.9,
      defensiveOverlapRatio: 0.25,
      effectiveCastRatio: 0.98,
      ccAvoidanceRate: 0.1,
    };

    const parsed = parseMatchEmbeddingData(raw);

    expect(parsed.rotationSequences).toEqual({ 'Penance -> PW:S': 3, 'Shield -> Smite': 2 });
    expect(parsed.totalSequences).toBe(5);
    expect(parsed.talentIds).toEqual([82556, 82564]);
    expect(parsed.offensiveIndex).toBe(0.42);
    expect(parsed.ccAvoidanceRate).toBe(0.1);
  });

  it('applies defaults when fields are missing', () => {
    const parsed = parseMatchEmbeddingData({});

    expect(parsed.rotationSequences).toEqual({});
    expect(parsed.totalSequences).toBe(0);
    expect(parsed.talentIds).toEqual([]);
    expect(parsed.offensiveIndex).toBe(0.5);
    expect(parsed.ccDensity).toBe(1.0);
    expect(parsed.reactionLatency).toBe(1.5);
    expect(parsed.defensiveOverlapRatio).toBe(0);
    expect(parsed.effectiveCastRatio).toBe(1.0);
    expect(parsed.ccAvoidanceRate).toBe(0);
  });
});

describe('vectorizeMatch (live path)', () => {
  it('reproduces the builder embedding from a raw record + persisted IDF stats', () => {
    const raw = {
      rotations: { coreSequences: ['Penance -> PW:S (used 3x)'] },
      pythonResult: { nodes_info: { '82556': {}, '82564': {} } },
      offensiveIndex: 0.42,
      ccDensity: 1.46,
      reactionLatency: 0.9,
      defensiveOverlapRatio: 0.25,
      effectiveCastRatio: 0.98,
      ccAvoidanceRate: 0.1,
    };
    const idf = { totalDocs: 1282, sequenceDocFrequency: { 'Penance -> PW:S': 50 } };

    // The live path must produce exactly what the corpus builder would store: parse → generate.
    const expected = generateMatchVector(parseMatchEmbeddingData(raw), idf.sequenceDocFrequency, idf.totalDocs);
    const actual = vectorizeMatch(raw, idf);

    expect(actual).toEqual(expected);
    expect(actual.length).toBe(516);
  });
});

import { generateMatchVector } from '../src/vectorIndexer';

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

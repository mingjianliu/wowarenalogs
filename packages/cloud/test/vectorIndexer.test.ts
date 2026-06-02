import { generateMatchVector } from '../src/vectorIndexer';

describe('Vector Indexing', () => {
  it('should generate a 512-dimension vector from match data', () => {
    const mockData = {
      talentIds: [82556, 82564], // Simulated Discipline Priest talents
      rotationSequences: { 'Penance -> PW:S': 3 },
      totalSequences: 10,
      offensiveIndex: 0.5,
      ccDensity: 1.2,
      reactionLatency: 0.8,
    };
    const mockGlobalIdf = { 'Penance -> PW:S': 50 }; // docFrequency out of 1282

    const vector = generateMatchVector(mockData, mockGlobalIdf, 1282);

    expect(vector.length).toBe(512);
    // Ensure it's normalized
    const magnitude = Math.sqrt(vector.reduce((acc, val) => acc + val * val, 0));
    expect(magnitude).toBeCloseTo(1);
  });
});

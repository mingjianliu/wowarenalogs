import { buildComparativePrompt, ComparativeAnalysisData } from '../comparativePrompt';

describe('buildComparativePrompt', () => {
  it('should generate a prompt with populated data', () => {
    const data: ComparativeAnalysisData = {
      playerName: 'Player1',
      spec: 'Restoration Shaman',
      userMetrics: { offensiveIndex: 0.5, ccDensity: 1.2, reactionLatency: 0.8 },
      userCrisisEvents: ['Used Spirit Link Totem at 30% HP'],
      nearestNeighbors: [
        {
          distance: 0.1,
          metrics: { offensiveIndex: 0.8, ccDensity: 2.0, reactionLatency: 0.4 },
          crisisEvents: ['Used Ascendance at 35% HP'],
        },
        {
          distance: 0.2,
          metrics: { offensiveIndex: 0.9, ccDensity: 1.8, reactionLatency: 0.5 },
          crisisEvents: ['Used Earthen Wall Totem at 38% HP'],
        },
      ],
    };

    const prompt = buildComparativePrompt(data);

    expect(prompt).toContain('Player1');
    expect(prompt).toContain('Restoration Shaman');
    expect(prompt).toContain('User [0.50] vs Pro Average [0.85]');
    expect(prompt).toContain('User [1.20] vs Pro Average [1.90]');
    expect(prompt).toContain('User [0.80s] vs Pro Average [0.45s]');
    expect(prompt).toContain('- Used Spirit Link Totem at 30% HP');
    expect(prompt).toContain('- Used Ascendance at 35% HP');
    expect(prompt).toContain('- Used Earthen Wall Totem at 38% HP');
  });

  it('should handle empty crisis events gracefully', () => {
    const data: ComparativeAnalysisData = {
      playerName: 'Player1',
      spec: 'Restoration Shaman',
      userMetrics: { offensiveIndex: 0.5, ccDensity: 1.2, reactionLatency: 0.8 },
      userCrisisEvents: [],
      nearestNeighbors: [
        {
          distance: 0.1,
          metrics: { offensiveIndex: 0.8, ccDensity: 2.0, reactionLatency: 0.4 },
          crisisEvents: [],
        },
      ],
    };

    const prompt = buildComparativePrompt(data);
    expect(prompt).toContain('- No major crisis events recorded.');
    expect(prompt).toContain('- No pro data available.');
  });
});

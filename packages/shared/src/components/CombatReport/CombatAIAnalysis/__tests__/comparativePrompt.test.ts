import { buildComparativePrompt, ComparativeAnalysisData } from '../comparativePrompt';

describe('buildComparativePrompt', () => {
  it('should generate a prompt with populated data', () => {
    const data: ComparativeAnalysisData = {
      playerName: 'Player1',
      spec: 'Restoration Shaman',
      userMetrics: {
        offensiveIndex: 0.5,
        ccDensity: 1.2,
        reactionLatency: 0.8,
        defensiveOverlapRatio: 0.4,
        effectiveCastRatio: 0.6,
        ccAvoidanceRate: 0.3,
      },
      userCrisisEvents: ['Used Spirit Link Totem at 30% HP'],
      nearestNeighbors: [
        {
          distance: 0.1,
          metrics: {
            offensiveIndex: 0.8,
            ccDensity: 2.0,
            reactionLatency: 0.4,
            defensiveOverlapRatio: 0.1,
            effectiveCastRatio: 0.9,
            ccAvoidanceRate: 0.7,
          },
          crisisEvents: ['Used Ascendance at 35% HP'],
        },
        {
          distance: 0.2,
          metrics: {
            offensiveIndex: 0.9,
            ccDensity: 1.8,
            reactionLatency: 0.5,
            defensiveOverlapRatio: 0.2,
            effectiveCastRatio: 0.8,
            ccAvoidanceRate: 0.6,
          },
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
    expect(prompt).toContain(
      'Defensive Overlap Ratio (High = panic trading defensives with teammates): User [0.40] vs Pro Average [0.15]',
    );
    expect(prompt).toContain(
      'Effective Cast Ratio (Low = getting interrupted or poor positioning): User [0.60] vs Pro Average [0.85]',
    );
    expect(prompt).toContain(
      'CC Avoidance Rate (High = proactive use of Fade/Grounding/LoS): User [0.30] vs Pro Average [0.65]',
    );
    expect(prompt).toContain('- Used Spirit Link Totem at 30% HP');
    expect(prompt).toContain('- Used Ascendance at 35% HP');
    expect(prompt).toContain('- Used Earthen Wall Totem at 38% HP');
  });

  it('should handle empty crisis events gracefully', () => {
    const data: ComparativeAnalysisData = {
      playerName: 'Player1',
      spec: 'Restoration Shaman',
      userMetrics: {
        offensiveIndex: 0.5,
        ccDensity: 1.2,
        reactionLatency: 0.8,
        defensiveOverlapRatio: 0.4,
        effectiveCastRatio: 0.6,
        ccAvoidanceRate: 0.3,
      },
      userCrisisEvents: [],
      nearestNeighbors: [
        {
          distance: 0.1,
          metrics: {
            offensiveIndex: 0.8,
            ccDensity: 2.0,
            reactionLatency: 0.4,
            defensiveOverlapRatio: 0.1,
            effectiveCastRatio: 0.9,
            ccAvoidanceRate: 0.7,
          },
          crisisEvents: [],
        },
      ],
    };

    const prompt = buildComparativePrompt(data);
    expect(prompt).toContain('- No major crisis events recorded.');
    expect(prompt).toContain('- No pro data available.');
  });
});

import { classifyCluster, euclidean, IMatchDynamicFeatures, normalize, toFeatureVector } from '../archetypeInference';

describe('archetypeInference — math helpers', () => {
  it('toFeatureVector converts match dynamics to fixed-length array', () => {
    const d = {
      durationSeconds: 120,
      burstWindowCount: 5,
      peakBurstScore: 100,
      burstWindowQuality: { low: 0, moderate: 0, high: 0, critical: 0 },
      ccEventsPerMinute: 2.5,
      tunnelScore: 0.8,
      criticalOrExposedBurstWindows: 2,
      enemyMeleeCount: 1,
      enemyRangedCount: 1,
      setupStyle: 'unknown' as const,
      ownTeamCCPerMin: 1.5,
      enemyTeamCCPerMin: 1.8,
      ownTeamSpecs: [],
      enemyTeamSpecs: [],
    };

    const vec = toFeatureVector(d);
    // [burstWindowCount, ccEventsPerMinute, tunnelScore, log1p(peakBurstScore), criticalOrExposedBurstWindows, log1p(durationSeconds), ownTeamCCPerMin]
    expect(vec).toHaveLength(7);
    expect(vec[0]).toBe(5);
    expect(vec[1]).toBe(2.5);
    expect(vec[2]).toBe(0.8);
    expect(vec[3]).toBeCloseTo(Math.log1p(100), 4);
    expect(vec[4]).toBe(2);
    expect(vec[5]).toBeCloseTo(Math.log1p(120), 4);
    expect(vec[6]).toBe(1.5);
  });

  it('normalize scales vector based on min/max params', () => {
    const v = [10, 20];
    const params = {
      min: [0, 0],
      max: [100, 100],
    };
    const res = normalize(v, params);
    expect(res).toEqual([0.1, 0.2]);
  });

  it('normalize handles zero-range (min=max)', () => {
    const v = [10];
    const params = { min: [10], max: [10] };
    const res = normalize(v, params);
    expect(res).toEqual([0]);
  });

  it('euclidean computes L2 distance', () => {
    const a = [0, 0];
    const b = [3, 4];
    expect(euclidean(a, b)).toBe(5);
  });
});

describe('classifyCluster', () => {
  const mockModel = {
    normParams: {
      min: [0, 0, 0, 0, 0, 0, 0],
      max: [10, 10, 1, 10, 10, 10, 10],
    },
    featureNames: [],
    centroids: [
      [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], // Cluster 0
      [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9], // Cluster 1
    ],
  };

  it('assigns dynamic features to the closest cluster centroid', () => {
    const lowActivity = {
      burstWindowCount: 1,
      ccEventsPerMinute: 1,
      tunnelScore: 0.1,
      peakBurstScore: 1, // log1p(1) = 0.69
      criticalOrExposedBurstWindows: 1,
      durationSeconds: 10, // log1p(10) = 2.4
      ownTeamCCPerMin: 1,
    } as unknown as IMatchDynamicFeatures;

    const res = classifyCluster(lowActivity, mockModel);
    expect(res.clusterIdx).toBe(0);
    expect(res.clusterKey).toBe('cluster_0');

    const highActivity = {
      burstWindowCount: 9,
      ccEventsPerMinute: 9,
      tunnelScore: 0.9,
      peakBurstScore: 10000, // log1p(large)
      criticalOrExposedBurstWindows: 9,
      durationSeconds: 10000, // log1p(large)
      ownTeamCCPerMin: 9,
    } as unknown as IMatchDynamicFeatures;

    const res2 = classifyCluster(highActivity, mockModel);
    expect(res2.clusterIdx).toBe(1);
    expect(res2.clusterKey).toBe('cluster_1');
  });
});

import { computeTfIdf, l2Normalize, meanStd, zScore } from '../vectorMath';

describe('Vector Math Utilities', () => {
  it('should L2 normalize an array of numbers', () => {
    const vec = [3, 4];
    const result = l2Normalize(vec);
    expect(result[0]).toBeCloseTo(0.6);
    expect(result[1]).toBeCloseTo(0.8);
    // magnitude should be 1
    expect(Math.sqrt(result[0] * result[0] + result[1] * result[1])).toBeCloseTo(1);
  });

  it('should compute basic TF-IDF', () => {
    const termFreq = 2; // used 2 times in this document
    const docLength = 10; // total 10 terms in doc
    const totalDocs = 100;
    const docFrequency = 10; // term appears in 10 docs total
    const result = computeTfIdf(termFreq, docLength, totalDocs, docFrequency);
    expect(result).toBeGreaterThan(0);
  });

  it('computeTfIdf is never negative for a ubiquitous term (smoothed IDF)', () => {
    // term in every doc: old formula log(N/(1+df)) went negative; smoothed must not.
    const result = computeTfIdf(1, 10, 100, 100);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it('meanStd computes mean and population std', () => {
    expect(meanStd([2, 4, 4, 4, 5, 5, 7, 9])).toEqual({ mean: 5, std: 2 });
    expect(meanStd([])).toEqual({ mean: 0, std: 0 });
  });

  it('zScore standardizes and is 0 when std is 0', () => {
    expect(zScore(7, 5, 2)).toBeCloseTo(1);
    expect(zScore(5, 5, 0)).toBe(0);
  });
});

import { computeTfIdf, l2Normalize, meanStd, weightedConcat, zScore } from '../vectorMath';

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

  it('weightedConcat L2-normalizes each block, scales by sqrt(weight), and renormalizes', () => {
    const out = weightedConcat(
      [
        [1, 0],
        [1, 0],
      ],
      [0.5, 0.5],
    );
    expect(out).toHaveLength(4);
    expect(out[0]).toBeCloseTo(0.7071);
    expect(out[1]).toBeCloseTo(0);
    expect(out[2]).toBeCloseTo(0.7071);
    expect(out[3]).toBeCloseTo(0);
    expect(Math.sqrt(out.reduce((s, v) => s + v * v, 0))).toBeCloseTo(1);
  });

  it('weightedConcat makes cosine the weighted average of per-block cosines', () => {
    const a = weightedConcat(
      [
        [1, 0],
        [1, 0],
      ],
      [0.5, 0.5],
    );
    const b = weightedConcat(
      [
        [1, 0],
        [0, 1],
      ],
      [0.5, 0.5],
    );
    // block0 cosine = 1, block1 cosine = 0 → weighted avg = 0.5
    const dot = a.reduce((s, v, i) => s + v * b[i], 0);
    expect(dot).toBeCloseTo(0.5);
  });

  it('weightedConcat tolerates a zero block (renormalizes over present blocks)', () => {
    const out = weightedConcat(
      [
        [1, 0],
        [0, 0],
      ],
      [0.5, 0.5],
    );
    expect(Math.sqrt(out.reduce((s, v) => s + v * v, 0))).toBeCloseTo(1);
    expect(out[0]).toBeCloseTo(1);
  });
});

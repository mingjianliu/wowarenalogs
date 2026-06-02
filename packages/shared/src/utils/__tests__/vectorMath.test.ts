import { computeTfIdf, l2Normalize } from '../vectorMath';

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
});

import { findNearestProMatchesLocal } from '../src/vectorSearch';
import fs from 'fs-extra';

jest.mock('fs-extra', () => ({
  existsSync: jest.fn(),
  readJson: jest.fn(),
}));

describe('findNearestProMatchesLocal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return empty array if the reference vectors file does not exist', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);

    const userVector = [1, 0, 0];
    const results = await findNearestProMatchesLocal('Frost Mage', userVector, 2);

    expect(results).toEqual([]);
    expect(fs.existsSync).toHaveBeenCalled();
  });

  it('should filter, compute cosine similarity, sort by distance, and limit results', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const mockMatches = [
      { matchId: 'match_orthogonal', spec: 'Frost Mage', embedding: [0, 1, 0] },
      { matchId: 'match_perfect', spec: 'Frost Mage', embedding: [1, 0, 0] },
      { matchId: 'match_wrong_spec', spec: 'Fire Mage', embedding: [1, 0, 0] },
      { matchId: 'match_partial', spec: 'Frost Mage', embedding: [0.7071, 0.7071, 0] },
    ];

    (fs.readJson as jest.Mock).mockResolvedValue(mockMatches);

    const userVector = [1, 0, 0];
    const results = await findNearestProMatchesLocal('Frost Mage', userVector, 2);

    expect(results).toHaveLength(2);

    expect(results[0].id).toBe('match_perfect');
    expect(results[0].distance).toBeCloseTo(0);
    expect(results[0].data.matchId).toBe('match_perfect');

    expect(results[1].id).toBe('match_partial');
    expect(results[1].distance).toBeCloseTo(0.2929);
    expect(results[1].data.matchId).toBe('match_partial');
  });
});

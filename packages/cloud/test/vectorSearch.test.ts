import fs from 'fs-extra';

import { findNearestProMatchesLocal, normalizeBracket } from '../src/vectorSearch';

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
    const results = await findNearestProMatchesLocal('Frost Mage', userVector, '3v3', 2);

    expect(results).toEqual([]);
    expect(fs.existsSync).toHaveBeenCalled();
  });

  it('should filter, compute cosine similarity, sort by distance, and limit results', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const mockMatches = [
      { matchId: 'match_orthogonal', spec: 'Frost Mage', bracket: '3v3', embedding: [0, 1, 0] },
      { matchId: 'match_perfect', spec: 'Frost Mage', bracket: '3v3', embedding: [1, 0, 0] },
      { matchId: 'match_wrong_spec', spec: 'Fire Mage', bracket: '3v3', embedding: [1, 0, 0] },
      { matchId: 'match_partial', spec: 'Frost Mage', bracket: '3v3', embedding: [0.7071, 0.7071, 0] },
    ];

    (fs.readJson as jest.Mock).mockResolvedValue(mockMatches);

    const userVector = [1, 0, 0];
    const results = await findNearestProMatchesLocal('Frost Mage', userVector, '3v3', 2);

    expect(results).toHaveLength(2);

    expect(results[0].id).toBe('match_perfect');
    expect(results[0].distance).toBeCloseTo(0);
    expect(results[0].data.matchId).toBe('match_perfect');

    expect(results[1].id).toBe('match_partial');
    expect(results[1].distance).toBeCloseTo(0.2929);
    expect(results[1].data.matchId).toBe('match_partial');
  });

  it('should filter by bracket', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const mockMatches = [
      { matchId: 'match_2v2', spec: 'Frost Mage', bracket: '2v2', embedding: [1, 0, 0] },
      { matchId: 'match_3v3', spec: 'Frost Mage', bracket: '3v3', embedding: [1, 0, 0] },
    ];

    (fs.readJson as jest.Mock).mockResolvedValue(mockMatches);

    const userVector = [1, 0, 0];
    const results = await findNearestProMatchesLocal('Frost Mage', userVector, '2v2', 2);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('match_2v2');
  });

  it('should match a solo_shuffle slug query against a "Rated Solo Shuffle" stored label', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const mockMatches = [
      { matchId: 'match_solo', spec: 'Frost Mage', bracket: 'Rated Solo Shuffle', embedding: [1, 0, 0] },
      { matchId: 'match_3v3', spec: 'Frost Mage', bracket: '3v3', embedding: [1, 0, 0] },
    ];

    (fs.readJson as jest.Mock).mockResolvedValue(mockMatches);

    const userVector = [1, 0, 0];
    const results = await findNearestProMatchesLocal('Frost Mage', userVector, 'solo_shuffle', 2);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('match_solo');
  });
});

describe('normalizeBracket', () => {
  it('canonicalizes every known representation to a stable slug', () => {
    expect(normalizeBracket('Rated Solo Shuffle')).toBe('solo_shuffle');
    expect(normalizeBracket('solo_shuffle')).toBe('solo_shuffle');
    expect(normalizeBracket('Solo Shuffle')).toBe('solo_shuffle');
    expect(normalizeBracket('3v3')).toBe('3v3');
    expect(normalizeBracket('2v2')).toBe('2v2');
    expect(normalizeBracket(undefined)).toBe('unknown');
    expect(normalizeBracket(null)).toBe('unknown');
  });
});

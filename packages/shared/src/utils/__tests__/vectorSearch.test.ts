/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs-extra';

import {
  _resetReferenceVectorsCacheForTests,
  findNearestProMatchesLocal,
  loadCellRecords,
  loadReferenceModel,
  normalizeBracket,
} from '../vectorSearch';

jest.mock('fs-extra', () => ({
  existsSync: jest.fn(),
  readJson: jest.fn(),
}));

describe('vectorSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetReferenceVectorsCacheForTests();
  });

  describe('normalizeBracket', () => {
    it('canonicalizes every known representation to a stable slug', () => {
      expect(normalizeBracket('Rated Solo Shuffle')).toBe('solo_shuffle');
      expect(normalizeBracket('solo_shuffle')).toBe('solo_shuffle');
      expect(normalizeBracket('Solo Shuffle')).toBe('solo_shuffle');
      expect(normalizeBracket('3v3')).toBe('3v3');
      expect(normalizeBracket('2v2')).toBe('2v2');
      expect(normalizeBracket('5v5 ')).toBe('5v5');
      expect(normalizeBracket(undefined)).toBe('unknown');
      expect(normalizeBracket(null)).toBe('unknown');
    });
  });

  describe('loadReferenceModel', () => {
    it('returns null if the reference model file does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      const result = await loadReferenceModel();
      expect(result).toBeNull();
    });

    it('returns the parsed model and caches it', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      const mockModel = { version: '1.0' };
      (fs.readJson as jest.Mock).mockResolvedValue(mockModel);

      const result1 = await loadReferenceModel();
      expect(result1).toEqual(mockModel);
      expect(fs.readJson).toHaveBeenCalledTimes(1);

      // Subsequent call should hit the cache
      const result2 = await loadReferenceModel();
      expect(result2).toEqual(mockModel);
      expect(fs.readJson).toHaveBeenCalledTimes(1);
    });
  });

  describe('loadCellRecords', () => {
    it('returns empty array if the reference vectors file does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      const results = await loadCellRecords('Holy Paladin', '3v3');
      expect(results).toEqual([]);
    });

    it('returns matching records for the spec and bracket', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      const mockMatches = [
        { matchId: 'match1', spec: 'Holy Paladin', bracket: '3v3', embedding: [1, 0, 0] },
        { matchId: 'match2', spec: 'Holy Paladin', bracket: '2v2', embedding: [0, 1, 0] },
        { matchId: 'match3', spec: 'Restoration Shaman', bracket: '3v3', embedding: [0, 0, 1] },
      ];
      (fs.readJson as jest.Mock).mockResolvedValue(mockMatches);

      const results = await loadCellRecords('Holy Paladin', '3v3');
      expect(results).toHaveLength(1);
      expect(results[0].matchId).toBe('match1');
    });
  });

  describe('findNearestProMatchesLocal', () => {
    it('returns empty array if the reference vectors file does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      const userVector = [1, 0, 0];
      const results = await findNearestProMatchesLocal('Frost Mage', userVector, '3v3', 2);
      expect(results).toEqual([]);
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
      expect(results[1].id).toBe('match_partial');
      expect(results[1].distance).toBeCloseTo(0.2929);
    });
  });
});

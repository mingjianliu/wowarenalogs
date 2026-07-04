/* eslint-disable @typescript-eslint/no-explicit-any */
/// <reference types="jest" />

import type { NextApiRequest, NextApiResponse } from 'next';

// Must come before the handler import — jest hoists jest.mock() above imports. compare.ts never
// touches Anthropic or Firestore on its synchronous guard branches, but both are mocked so the
// module loads without opening a real client and so we can assert they are never reached.
jest.mock('@anthropic-ai/sdk', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@google-cloud/firestore', () => ({ Firestore: jest.fn() }));
// Cohort loader is mocked so the localContext tests control the pro records instead of reading
// the real reference_vectors.json from disk.
jest.mock('../../../../shared/src/utils/vectorSearch', () => ({
  ...(jest.requireActual('../../../../shared/src/utils/vectorSearch') as Record<string, unknown>),
  loadCellRecords: jest.fn(),
}));

import { CombatUnitSpec } from '@wowarenalogs/parser';

import { loadCellRecords } from '../../../../shared/src/utils/vectorSearch';
import handler from '../compare';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeReq(method = 'POST', body: Record<string, unknown> = {}): NextApiRequest {
  return { method, body } as unknown as NextApiRequest;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status } as unknown as NextApiResponse, status, json };
}

afterEach(() => {
  jest.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/compare', () => {
  // ── Method guard ──────────────────────────────────────────────────────────
  describe('method validation', () => {
    it.each(['GET', 'PUT', 'DELETE', 'PATCH'])('returns 405 with an empty body for %s requests', async (method) => {
      const { res, status, json } = makeRes();
      await handler(makeReq(method), res);
      expect(status).toHaveBeenCalledWith(405);
      expect(json).toHaveBeenCalledWith({});
    });

    it('never constructs an Anthropic client for a non-POST request', async () => {
      const Anthropic = jest.requireMock('@anthropic-ai/sdk').default as jest.Mock;
      const { res } = makeRes();
      await handler(makeReq('GET'), res);
      expect(Anthropic).not.toHaveBeenCalled();
    });
  });

  // ── matchId guard ─────────────────────────────────────────────────────────
  describe('missing matchId', () => {
    it('returns 200 with an empty body when matchId is absent', async () => {
      const { res, status, json } = makeRes();
      await handler(makeReq('POST', { apiKey: 'k' }), res);
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({});
    });

    it('returns 200 with an empty body when matchId is an empty string', async () => {
      const { res, status, json } = makeRes();
      await handler(makeReq('POST', { matchId: '' }), res);
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({});
    });

    it('returns 200 empty when the whole body is missing', async () => {
      const { res, status, json } = makeRes();
      await handler({ method: 'POST' } as unknown as NextApiRequest, res);
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({});
    });

    it('does not reach Anthropic or Firestore when matchId is missing', async () => {
      const Anthropic = jest.requireMock('@anthropic-ai/sdk').default as jest.Mock;
      const { Firestore } = jest.requireMock('@google-cloud/firestore') as { Firestore: jest.Mock };
      const { res } = makeRes();
      await handler(makeReq('POST', {}), res);
      expect(Anthropic).not.toHaveBeenCalled();
      expect(Firestore).not.toHaveBeenCalled();
    });
  });

  // ── Unknown-variant fallthrough ─────────────────────────────────────────────
  // A matchId is present but the variant matches neither 'stats' nor 'exemplar' (and is not
  // unset), so the handler must return empty rather than serving the retired legacy path — and it
  // must do so WITHOUT loading a log, hitting Firestore, or calling the model.
  describe('unknown variant', () => {
    it('returns 200 with an empty body for an unrecognized variant', async () => {
      const { res, status, json } = makeRes();
      await handler(makeReq('POST', { matchId: 'match-1', variant: 'legacy' }), res);
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({});
    });

    it('does not touch Firestore or Anthropic for an unknown variant', async () => {
      const Anthropic = jest.requireMock('@anthropic-ai/sdk').default as jest.Mock;
      const { Firestore } = jest.requireMock('@google-cloud/firestore') as { Firestore: jest.Mock };
      const { res } = makeRes();
      await handler(makeReq('POST', { matchId: 'match-1', variant: 'nonsense' }), res);
      expect(Firestore).not.toHaveBeenCalled();
      expect(Anthropic).not.toHaveBeenCalled();
    });
  });

  // ── localContext path (desktop app: no Firestore/GCS available) ────────────
  describe('localContext', () => {
    const proRecord = (overrides: Record<string, unknown> = {}) => ({
      matchId: 'pro-1',
      spec: 'Holy Paladin',
      bracket: '3v3',
      leaderboardSelection: 'top-100',
      playerName: 'ProOne',
      crisisEvents: ['(0:42): Holy Shock -> Word of Glory -> Divine Protection'],
      metrics: {
        offensiveIndex: 0.2,
        ccDensity: 1.1,
        reactionLatency: 0.8,
        defensiveOverlapRatio: 0,
        effectiveCastRatio: 0.9,
        ccAvoidanceRate: 0.7,
      },
      embedding: [],
      ...overrides,
    });

    const healerLocalContext = () => ({
      playerName: 'Healbot',
      specId: CombatUnitSpec.Paladin_Holy,
      bracket: '3v3',
      teamDtps: 5000,
      raw: {
        rotations: { coreSequences: [], crisisEvents: ['(0:30): Holy Shock -> Word of Glory'] },
        pythonResult: { nodes_info: {} },
        offensiveIndex: 0.3,
        ccDensity: 1.0,
        reactionLatency: 1.2,
        defensiveOverlapRatio: 0,
        effectiveCastRatio: 0.85,
        ccAvoidanceRate: 0.6,
      },
    });

    beforeEach(() => {
      (loadCellRecords as jest.Mock).mockResolvedValue([
        proRecord({ matchId: 'pro-1', playerName: 'ProOne' }),
        proRecord({ matchId: 'pro-2', playerName: 'ProTwo' }),
        proRecord({ matchId: 'pro-3', playerName: 'ProThree' }),
      ]);
    });

    it('serves the exemplar comparison from localContext without touching Firestore', async () => {
      const { Firestore } = jest.requireMock('@google-cloud/firestore') as { Firestore: jest.Mock };
      const { res, status, json } = makeRes();
      await handler(makeReq('POST', { matchId: 'match-1', localContext: healerLocalContext() }), res);

      expect(Firestore).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(200);
      const body = json.mock.calls[0][0];
      expect(body.verifiedComparison).toBeDefined();
      expect(body.verifiedComparison.player).toBe('Healbot');
      expect(body.verifiedComparison.spec).toBe('Holy Paladin');
      expect(body.verifiedComparison.cohort.n).toBe(3);
      expect(body.userCrises).toEqual(['(0:30): Holy Shock -> Word of Glory']);
      expect(body.proCrises.length).toBeGreaterThan(0);
    });

    it('serves the stats variant from localContext without touching Firestore', async () => {
      const { Firestore } = jest.requireMock('@google-cloud/firestore') as { Firestore: jest.Mock };
      const { res, status, json } = makeRes();
      await handler(makeReq('POST', { matchId: 'match-1', variant: 'stats', localContext: healerLocalContext() }), res);

      expect(Firestore).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(200);
      const body = json.mock.calls[0][0];
      expect(body.verifiedComparison).toBeDefined();
      expect(body.verifiedComparison.cohort.n).toBe(3);
    });

    it('skips the optional report (no Anthropic call) when no apiKey is provided', async () => {
      const Anthropic = jest.requireMock('@anthropic-ai/sdk').default as jest.Mock;
      const { res, json } = makeRes();
      await handler(makeReq('POST', { matchId: 'match-1', localContext: healerLocalContext() }), res);

      expect(Anthropic).not.toHaveBeenCalled();
      expect(json.mock.calls[0][0].report).toBeUndefined();
    });

    it('re-checks the healer gate server-side: non-healer localContext returns empty without Firestore fallback', async () => {
      const { Firestore } = jest.requireMock('@google-cloud/firestore') as { Firestore: jest.Mock };
      const { res, status, json } = makeRes();
      const local = { ...healerLocalContext(), specId: CombatUnitSpec.Warrior_Arms };
      await handler(makeReq('POST', { matchId: 'match-1', localContext: local }), res);

      expect(Firestore).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({});
    });

    it('returns empty when the cohort cell has no records for the spec+bracket', async () => {
      (loadCellRecords as jest.Mock).mockResolvedValue([]);
      const { res, status, json } = makeRes();
      await handler(makeReq('POST', { matchId: 'match-1', localContext: healerLocalContext() }), res);
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({});
    });
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
/// <reference types="jest" />

import type { NextApiRequest, NextApiResponse } from 'next';

// Must come before the handler import — jest hoists jest.mock() above imports. compare.ts never
// touches Anthropic or Firestore on its synchronous guard branches, but both are mocked so the
// module loads without opening a real client and so we can assert they are never reached.
jest.mock('@anthropic-ai/sdk', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@google-cloud/firestore', () => ({ Firestore: jest.fn() }));

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
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { NextApiRequest, NextApiResponse } from 'next';

import { handler } from '../blizzardApi';

// Mock node-fetch
const mockFetch = jest.fn();
jest.mock('node-fetch', () => {
  return function fetchMock(...args: any[]) {
    return mockFetch(...args);
  };
});

// Mock global fetch as well since the handler uses the global fetch API
global.fetch = jest.fn().mockImplementation((url: string, ...args: any[]) => {
  if (url.includes('battle.net/oauth/token')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ access_token: 'fake-token' }),
    });
  }
  return mockFetch(url, ...args);
}) as any;

describe('blizzardApi handler', () => {
  let req: Partial<NextApiRequest>;
  let res: Partial<NextApiResponse>;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      method: 'GET',
      query: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  it('returns 400 if route is missing', async () => {
    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns 400 if region is invalid (SSRF injection attempt)', async () => {
    req.query = { route: ['evil.com/x', 'profile', 'index'] };

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid region' });
  });

  it('allows valid regions and calls fetch', async () => {
    req.query = { route: ['us', 'profile', 'index'], namespace: 'static-us', locale: 'en_US' };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('{"data": "ok"}'),
    });

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: 'ok' });
  });
});

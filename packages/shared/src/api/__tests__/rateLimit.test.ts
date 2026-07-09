import { _resetRateLimiterForTests, checkRateLimit, clientIpFrom } from '../rateLimit';

describe('rateLimit', () => {
  beforeEach(() => {
    _resetRateLimiterForTests();
  });

  test('allows exactly limit requests in one window, blocks request limit+1', () => {
    const limit = 3;
    const windowMs = 10000;
    const now = Date.now();

    // 1st request
    const r1 = checkRateLimit('user1', limit, windowMs, now);
    expect(r1.allowed).toBe(true);
    expect(r1.retryAfterSeconds).toBe(0);

    // 2nd request
    const r2 = checkRateLimit('user1', limit, windowMs, now);
    expect(r2.allowed).toBe(true);

    // 3rd request
    const r3 = checkRateLimit('user1', limit, windowMs, now);
    expect(r3.allowed).toBe(true);

    // 4th request
    const r4 = checkRateLimit('user1', limit, windowMs, now);
    expect(r4.allowed).toBe(false);
  });

  test('blocked result carries a positive retryAfterSeconds <= window seconds', () => {
    const limit = 1;
    const windowMs = 5000;
    const now = Date.now();

    // 1st request
    checkRateLimit('user1', limit, windowMs, now);

    // 2nd request (blocked, 2 seconds into the window)
    const r2 = checkRateLimit('user1', limit, windowMs, now + 2000);
    expect(r2.allowed).toBe(false);
    // window start + windowMs - nowMs = now + 5000 - (now + 2000) = 3000ms.
    // 3000 / 1000 = 3 seconds.
    expect(r2.retryAfterSeconds).toBe(3);
    expect(r2.retryAfterSeconds).toBeGreaterThan(0);
    expect(r2.retryAfterSeconds).toBeLessThanOrEqual(windowMs / 1000);
  });

  test('a new window after windowMs elapses allows again', () => {
    const limit = 1;
    const windowMs = 5000;
    const now = Date.now();

    expect(checkRateLimit('user1', limit, windowMs, now).allowed).toBe(true);
    expect(checkRateLimit('user1', limit, windowMs, now).allowed).toBe(false);

    // After windowMs - 1ms, still blocked
    expect(checkRateLimit('user1', limit, windowMs, now + windowMs - 1).allowed).toBe(false);

    // After windowMs, allowed again
    const r3 = checkRateLimit('user1', limit, windowMs, now + windowMs);
    expect(r3.allowed).toBe(true);
  });

  test('two different keys do not interfere', () => {
    const limit = 1;
    const windowMs = 5000;
    const now = Date.now();

    expect(checkRateLimit('user1', limit, windowMs, now).allowed).toBe(true);
    expect(checkRateLimit('user2', limit, windowMs, now).allowed).toBe(true);

    expect(checkRateLimit('user1', limit, windowMs, now).allowed).toBe(false);
    expect(checkRateLimit('user2', limit, windowMs, now).allowed).toBe(false);
  });

  describe('clientIpFrom', () => {
    test('x-forwarded-for string "1.2.3.4, 5.6.7.8" -> "1.2.3.4"', () => {
      const req = {
        headers: {
          'x-forwarded-for': '1.2.3.4, 5.6.7.8',
        },
      };
      expect(clientIpFrom(req)).toBe('1.2.3.4');
    });

    test('array header takes first element', () => {
      const req = {
        headers: {
          'x-forwarded-for': ['2.3.4.5, 6.7.8.9', '9.10.11.12'],
        },
      };
      expect(clientIpFrom(req)).toBe('2.3.4.5');
    });

    test('missing header falls back to socket.remoteAddress', () => {
      const req = {
        headers: {},
        socket: {
          remoteAddress: '127.0.0.1',
        },
      };
      expect(clientIpFrom(req)).toBe('127.0.0.1');
    });

    test('nothing -> "unknown"', () => {
      const req = {
        headers: {},
      };
      expect(clientIpFrom(req)).toBe('unknown');
    });
  });
});

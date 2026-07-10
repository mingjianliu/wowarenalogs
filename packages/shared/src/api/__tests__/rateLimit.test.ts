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

    test('missing headers field entirely -> "unknown"', () => {
      const req = {};
      expect(clientIpFrom(req)).toBe('unknown');
    });
  });

  describe('heterogeneous windows & FIFO eviction', () => {
    test('pruning sweeps respect individual windowMs', () => {
      const now = Date.now();
      // First key has a long window (100s), second key has a short window (10s)
      checkRateLimit('key1', 1, 100_000, now);
      checkRateLimit('key2', 1, 10_000, now);

      // Trigger a prune at now + 15s using a new key
      checkRateLimit('key_trigger', 1, 5_000, now + 15_000);

      // key2 should have been pruned (15s > 10s short window)
      // key1 should NOT have been pruned (15s < 100s long window)
      // We can verify this by checking if key1 still blocks (under limit 1)
      expect(checkRateLimit('key1', 1, 100_000, now + 15_000).allowed).toBe(false);
      // and key2 is allowed again (since it was pruned, it resets to count=1)
      expect(checkRateLimit('key2', 1, 10_000, now + 15_000).allowed).toBe(true);
    });

    test('evicts oldest entries when map size exceeds 10000', () => {
      const now = Date.now();

      // Seed the map with key0
      checkRateLimit('key0', 1, 10_000, now);

      // Seed 10,001 keys to exceed the 10,000 threshold.
      // Use windowMs = 100,000 so they do not expire naturally.
      for (let i = 1; i <= 10001; i++) {
        checkRateLimit(`key_${i}`, 1, 100_000, now);
      }

      // Trigger prune by adding one more key
      checkRateLimit('key_trigger', 1, 100_000, now);

      // The map size should have dropped to around 8000 (FIFO eviction target is <= 8000)
      // key0 (being the oldest) should definitely have been evicted.
      expect(checkRateLimit('key0', 1, 10_000, now).allowed).toBe(true);
    });

    test('deletes expired keys when map size exceeds 10000', () => {
      const now = Date.now();

      // Seed key_expired that is already expired
      checkRateLimit('key_expired', 1, 5_000, now - 6_000);

      // Seed 10,001 keys to exceed the 10,000 threshold.
      for (let i = 1; i <= 10001; i++) {
        checkRateLimit(`key_${i}`, 1, 100_000, now);
      }

      // Trigger prune by adding one more key
      checkRateLimit('key_trigger', 1, 100_000, now);

      // key_expired should have been deleted by the natural expiration check
      expect(checkRateLimit('key_expired', 1, 5_000, now).allowed).toBe(true);
    });
  });
});

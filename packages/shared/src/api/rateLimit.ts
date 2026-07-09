// T14: minimum-bar abuse protection for the Anthropic-spending endpoint.
// In-memory = per-serverless-instance; good enough to stop naive loops.
// This is acceptable on serverless environments and serves as a per-instance limiter.

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets (only meaningful when !allowed). */
  retryAfterSeconds: number;
}

const map = new Map<string, { windowStart: number; count: number }>();

export function checkRateLimit(key: string, limit: number, windowMs: number, nowMs = Date.now()): RateLimitResult {
  const entry = map.get(key);

  if (!entry || nowMs - entry.windowStart >= windowMs) {
    if (map.size > 10000) {
      for (const [k, val] of map.entries()) {
        if (nowMs - val.windowStart >= windowMs) {
          map.delete(k);
        }
      }
    }
    const newEntry = { windowStart: nowMs, count: 1 };
    map.set(key, newEntry);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  entry.count += 1;
  if (entry.count <= limit) {
    return { allowed: true, retryAfterSeconds: 0 };
  } else {
    const retryAfterSeconds = Math.ceil((entry.windowStart + windowMs - nowMs) / 1000);
    return { allowed: false, retryAfterSeconds: Math.max(0, retryAfterSeconds) };
  }
}

/** First hop of x-forwarded-for (trimmed), else req.socket.remoteAddress, else 'unknown'. */
export function clientIpFrom(req: {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}): string {
  let ip: string | undefined;
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    const rawHeader = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
    if (rawHeader && typeof rawHeader === 'string') {
      const parts = rawHeader.split(',');
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed) {
          ip = trimmed;
          break;
        }
      }
    }
  }
  if (!ip && req.socket?.remoteAddress) {
    ip = req.socket.remoteAddress;
  }
  return ip || 'unknown';
}

export function _resetRateLimiterForTests(): void {
  map.clear();
}

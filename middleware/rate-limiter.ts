import { McpUserError } from '../utils/response-formatter';

interface Bucket {
  tokens: number;
  lastRefill: number; // epoch ms
}

const RATE = 60; // tokens per minute
const WINDOW_MS = 60_000; // 1 minute window
const buckets = new Map<string, Bucket>();

/**
 * Implements an in-process continuous refill token bucket rate limiter.
 * Throws McpUserError if rate limit is exceeded.
 * 
 * NOTE: This is in-process only. For multi-instance deployments (horizontal scaling, PM2 cluster, 
 * or container replicas), this bucket is not shared. Consider replacing with a Redis-backed 
 * sliding window limiter (e.g. ioredis) for production scale.
 */
export async function rateLimiter(customerId: string): Promise<void> {
  const now = Date.now();
  const bucket = buckets.get(customerId) ?? { tokens: RATE, lastRefill: now };

  // Refill proportionally to time elapsed
  const elapsed = now - bucket.lastRefill;
  bucket.tokens = Math.min(RATE, bucket.tokens + (elapsed / WINDOW_MS) * RATE);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    throw new McpUserError('Rate limit exceeded: 60 calls/minute', 'RATE_LIMIT_EXCEEDED');
  }

  bucket.tokens -= 1;
  buckets.set(customerId, bucket);
}

// Memory leak prevention: Evict inactive buckets every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [customerId, bucket] of buckets.entries()) {
    if (bucket.lastRefill < cutoff) {
      buckets.delete(customerId);
    }
  }
}, 5 * 60_000);

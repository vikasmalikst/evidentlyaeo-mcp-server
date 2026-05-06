import { McpUserError } from '../utils/response-formatter';

interface Bucket {
  tokens: number;
  lastRefill: number; // epoch ms
}

const RATE = 60; // tokens per minute
const WINDOW_MS = 60_000; // 1 minute window
const buckets = new Map<string, Bucket>();

const TOOL_COSTS: Record<string, number> = {
  dashboard_get_summary: 1,
  query_performance: 2,
  citations_source_attribution: 2,
  recommendations_list: 1,
  domain_readiness_get_audit: 3,
};

/**
 * Implements an in-process continuous refill token bucket rate limiter.
 * Throws McpUserError if rate limit is exceeded.
 * 
 * NOTE: This is in-process only. For multi-instance deployments (horizontal scaling, PM2 cluster, 
 * or container replicas), this bucket is not shared. Consider replacing with a Redis-backed 
 * sliding window limiter (e.g. ioredis) for production scale.
 */
export async function rateLimiter(customerId: string, toolName?: string): Promise<void> {
  const now = Date.now();
  const bucket = buckets.get(customerId) ?? { tokens: RATE, lastRefill: now };

  // Refill proportionally to time elapsed
  const elapsed = now - bucket.lastRefill;
  bucket.tokens = Math.min(RATE, bucket.tokens + (elapsed / WINDOW_MS) * RATE);
  bucket.lastRefill = now;

  const cost = TOOL_COSTS[toolName ?? ''] ?? 1;

  if (bucket.tokens < cost) {
    throw new McpUserError('Rate limit exceeded: 60 tokens/minute', 'RATE_LIMIT_EXCEEDED');
  }

  bucket.tokens -= cost;
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

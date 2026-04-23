import { LRUCache } from 'lru-cache';

const TTL_MS = 30 * 60_000; // 30 minutes

const cache = new LRUCache<string, unknown>({
  max: 200,
  ttl: TTL_MS,
});

/**
 * CAUTION: The dbToken (Shadow Token) must NEVER be included in the params list.
 * The cache serves data, not tokens.
 */
export function buildCacheKey(
  toolName: string,
  customerId: string,
  brandId: string,
  params: Record<string, unknown>
): string {
  const sorted = Object.keys(params)
    .sort()
    .map(k => `${k}=${JSON.stringify(params[k])}`)
    .join('&');
  return `v2:${toolName}:${customerId}:${brandId}:${sorted}`;
}

export function getCached(key: string): unknown | null {
  return cache.get(key) ?? null;
}

export function setCached(key: string, data: unknown): void {
  cache.set(key, data);
}
import { z } from 'zod';
import { promptsAnalyticsService } from '../../services/prompts-analytics.service';
import { validateBrandOwnership } from '../middleware/brand-guard';
import { McpUserError, McpSystemError } from '../utils/response-formatter';
import { brandIdSchema, dateRangeSchema, collectorsSchema } from './schemas';
import { getCached, setCached, buildCacheKey } from '../cache/tool-cache';

/**
 * Queries and Topics Tool Schema & Handler
 * 
 * Implements a shared fetch pattern with a unified cache to prevent redundant analytical passes.
 */

export const queryPerformanceSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
  limit: z.number().int().min(1).max(50).optional().describe('Top N queries to return. Default 20.'),
});

export const topicsPerformanceSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
});

/**
 * Internal shared fetcher for prompt analytics
 */
async function fetchPromptAnalytics(inputs: any, customerId: string) {
  const { brandId, startDate, endDate, collectors } = inputs;
  
  // Use global cache
  const cacheKey = buildCacheKey('prompts_shared', customerId, brandId, { startDate, endDate, collectors });

  const cached = getCached(cacheKey);
  if (cached) {
    return { data: cached, cacheHit: true };
  }

  try {
    const result = await promptsAnalyticsService.getPromptAnalytics({
      brandId,
      customerId,
      startDate,
      endDate,
      collectors,
    });
    
    setCached(cacheKey, result);
    return { data: result, cacheHit: false };
  } catch (error: any) {
    throw new McpSystemError('Failed to fetch analytics', error.message);
  }
}

/**
 * Get performance data for top-performing queries (Execute Query Performance)
 */
export async function executeQueryPerformance(inputs: any, ctx: any, dbToken: string) {
  const { brandId, limit = 20 } = inputs;
  
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);
  
  const { data, cacheHit } = await fetchPromptAnalytics(inputs, ctx.customerId);

  // Extract prompts across all topics
  const allPrompts = (data.topics || []).flatMap((t: any) => t.prompts || []);
  
  // Sort by visibility or volume (descending)
  const sortedPrompts = allPrompts.sort((a: any, b: any) => (b.visibilityScore || 0) - (a.visibilityScore || 0));

  return {
    queries: sortedPrompts.slice(0, limit),
    metadata: { cacheHit }
  };
}

/**
 * Get performance data aggregated by topics (Execute Topics Performance)
 */
export async function executeTopicsPerformance(inputs: any, ctx: any, dbToken: string) {
  await validateBrandOwnership(inputs.brandId, ctx.customerId, dbToken);
  
  const { data, cacheHit } = await fetchPromptAnalytics(inputs, ctx.customerId);

  // Extract topic-level summaries
  const topics = (data.topics || []).map((t: any) => ({
    name: t.name,
    promptCount: t.promptCount,
    volumeCount: t.volumeCount,
    visibilityScore: t.visibilityScore,
    sentimentScore: t.sentimentScore,
    mentions: t.mentions,
    soaScore: t.soaScore
  }));

  return {
    topics,
    metadata: { cacheHit }
  };
}

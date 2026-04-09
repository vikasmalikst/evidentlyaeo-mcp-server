import { z } from 'zod';
import { promptsAnalyticsService } from '../../services/prompts-analytics.service';
import { validateBrandOwnership } from '../middleware/brand-guard';
import { McpSystemError } from '../utils/response-formatter';
import { brandIdSchema, dateRangeSchema, collectorsSchema } from './schemas';
import { getCached, setCached, buildCacheKey } from '../cache/tool-cache';

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

async function fetchPromptAnalytics(inputs: any, customerId: string) {
  const { brandId, startDate, endDate, collectors } = inputs;
  const cacheKey = buildCacheKey('prompts_shared', customerId, brandId, {
    startDate,
    endDate,
    collectors,
  });

  const cached = getCached(cacheKey);
  if (cached) return { data: cached, cacheHit: true };

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

export async function executeQueryPerformance(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, limit = 20 } = inputs;

  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const { data, cacheHit } = await fetchPromptAnalytics(inputs, ctx.customerId);

  const allPrompts = ((data as any).topics || []).flatMap((t: any) => t.prompts || []);
  const sortedPrompts = allPrompts.sort(
    (a: any, b: any) => (b.visibilityScore || 0) - (a.visibilityScore || 0)
  );
  const topPrompts = sortedPrompts.slice(0, limit);

  if (topPrompts.length === 0) {
    return {
      queries: [],
      empty_state_message:
        'No query performance data found for this brand in the selected date range. ' +
        'This means no prompts have been tracked yet, or no results match these filters. ' +
        'Do NOT infer or estimate query performance. Tell the user no data is available.',
      _meta: {
        brand_id: brandId,
        date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
        cache_hit: cacheHit,
      },
    };
  }

  return {
    queries: topPrompts,
    total_returned: topPrompts.length,
    _meta: {
      brand_id: brandId,
      date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      data_source: 'EvidentlyAEO prompt analytics — real tracked queries only',
      cache_hit: cacheHit,
      usage_note:
        'visibilityScore is 0–100. soaScore is Share of Answer 0–100. Report exact values only.',
    },
  };
}

export async function executeTopicsPerformance(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate } = inputs;

  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const { data, cacheHit } = await fetchPromptAnalytics(inputs, ctx.customerId);

  const topics = ((data as any).topics || []).map((t: any) => ({
    topic_name: t.name,
    prompt_count: t.promptCount,
    volume_count: t.volumeCount,
    visibility_score_0_to_100: t.visibilityScore,
    sentiment_score_0_to_100: t.sentimentScore,
    total_mentions: t.mentions,
    share_of_answer_score: t.soaScore,
  }));

  if (topics.length === 0) {
    return {
      topics: [],
      empty_state_message:
        'No topic performance data found for this brand and date range. ' +
        'Do NOT infer topic performance. Tell the user no data is available.',
      _meta: { brand_id: brandId, cache_hit: cacheHit },
    };
  }

  return {
    topics,
    total_topics: topics.length,
    _meta: {
      brand_id: brandId,
      date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      data_source: 'EvidentlyAEO topic analytics — real tracked data only',
      cache_hit: cacheHit,
    },
  };
}

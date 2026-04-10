import { z } from 'zod';
import { promptsAnalyticsService } from '../../services/prompts-analytics.service';
import { validateBrandOwnership } from '../middleware/brand-guard';
import { McpSystemError } from '../utils/response-formatter';
import { brandIdSchema, dateRangeSchema, collectorsSchema, fieldsSchema } from './schemas';
import { annotateEmptyArray, projectFields } from '../utils/data-sanitizer';
import { getCached, setCached, buildCacheKey } from '../cache/tool-cache';

const queryTypeSchema = z.object({
  queryType: z.enum(['blind', 'brand', 'competitor', 'all']).optional().describe(
    'Filter queries by type. ' +
    '"blind" = queries with no brand name (unprompted visibility). ' +
    '"brand" = queries mentioning this brand explicitly. ' +
    '"competitor" = queries mentioning a competitor brand. ' +
    '"all" = no filter (default). ' +
    'Use "blind" to measure organic AI discoverability.'
  ),
});

export const queryPerformanceSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
  ...fieldsSchema.shape,
  ...queryTypeSchema.shape,
  limit: z.number().int().min(1).max(50).optional().describe(
    'Top N queries to return sorted by visibility score descending. Default 20. Use 5–10 for quick checks.'
  ),
});

export const topicsPerformanceSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
  ...fieldsSchema.shape,
});

async function fetchPromptAnalytics(inputs: any, customerId: string) {
  const { brandId, startDate, endDate, collectors } = inputs;
  const cacheKey = buildCacheKey('prompts_shared', customerId, brandId, { startDate, endDate, collectors });
  const cached = getCached(cacheKey);
  if (cached) return { data: cached, cacheHit: true };

  try {
    const result = await promptsAnalyticsService.getPromptAnalytics({
      brandId, customerId, startDate, endDate, collectors,
    });
    setCached(cacheKey, result);
    return { data: result, cacheHit: false };
  } catch (error: any) {
    throw new McpSystemError('Failed to fetch analytics', error.message);
  }
}

export async function executeQueryPerformance(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, limit = 20, queryType = 'all', fields } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const { data, cacheHit } = await fetchPromptAnalytics(inputs, ctx.customerId);

  let allPrompts = ((data as any).topics || []).flatMap((t: any) => t.prompts || []);

  if (queryType !== 'all') {
    allPrompts = allPrompts.filter((p: any) => p.queryType === queryType);
  }

  const sorted = allPrompts
    .sort((a: any, b: any) => (b.visibilityScore || 0) - (a.visibilityScore || 0))
    .slice(0, limit);

  const result = sorted.length === 0 ? {
    queries: annotateEmptyArray(
      `${queryType === 'all' ? '' : queryType + ' '}queries`,
      `brand ${brandId} in this date range`
    ),
    _meta: {
      brand_id: brandId,
      query_type_filter: queryType,
      date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      cache_hit: cacheHit,
    },
  } : {
    queries: sorted,
    total_returned: sorted.length,
    _meta: {
      brand_id: brandId,
      query_type_filter: queryType,
      date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      data_source: 'EvidentlyAEO prompt analytics — real tracked queries only',
      cache_hit: cacheHit,
      usage_note: 'visibilityScore and soaScore are 0–100. Report exact values only. null = no data for that query.',
    },
  };

  return projectFields(result as any, fields);
}

export async function executeTopicsPerformance(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, fields } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const { data, cacheHit } = await fetchPromptAnalytics(inputs, ctx.customerId);

  const topics = ((data as any).topics || []).map((t: any) => ({
    topic_name: t.name,
    prompt_count: t.promptCount ?? null,
    volume_count: t.volumeCount ?? null,
    visibility_score_0_to_100: t.visibilityScore ?? null,
    sentiment_score_0_to_100: t.sentimentScore ?? null,
    total_mentions: t.mentions ?? null,
    share_of_answer_score: t.soaScore ?? null,
  }));

  const result = topics.length === 0 ? {
    topics: annotateEmptyArray('topics', `brand ${brandId} in this date range`),
    _meta: { brand_id: brandId, cache_hit: cacheHit },
  } : {
    topics,
    total_topics: topics.length,
    _meta: {
      brand_id: brandId,
      date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      data_source: 'EvidentlyAEO topic analytics — real tracked data only',
      cache_hit: cacheHit,
    },
  };

  return projectFields(result as any, fields);
}

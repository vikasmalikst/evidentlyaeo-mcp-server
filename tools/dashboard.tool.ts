import { z } from 'zod';
import { dashboardService } from '../../services/brand-dashboard/dashboard.service';
import { validateBrandOwnership } from '../middleware/brand-guard';
import { McpSystemError } from '../utils/response-formatter';
import { brandIdSchema, dateRangeSchema, collectorsSchema, fieldsSchema } from './schemas';
import { annotateValue, annotateEmptyArray, safeDivide, projectFields } from '../utils/data-sanitizer';

// ─── Shared input schema ───────────────────────────────────────────────────────
const dashboardBaseSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
  ...fieldsSchema.shape,
  queryTags: z.array(z.string()).optional().describe(
    'Optional query tags to filter dashboard data by topic segment.'
  ),
});

// Keep old schema export for any references during migration
export const dashboardKPIsSchema = dashboardBaseSchema;

// ─── Shared internal fetcher ──────────────────────────────────────────────────
async function fetchDashboardPayload(inputs: any, ctx: any) {
  const { brandId, startDate, endDate, collectors, queryTags } = inputs;
  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate
    ? new Date(startDate)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const payload = await dashboardService.getBrandDashboard(
    brandId,
    ctx.customerId,
    { start: start.toISOString(), end: end.toISOString() },
    { collectors, queryTags, skipCache: false }
  );

  return {
    payload,
    dateRangeLabel: `${start.toISOString().split('T')[0]} to ${end.toISOString().split('T')[0]}`,
  };
}

// ─── Tool 1: dashboard_get_summary ───────────────────────────────────────────
export const dashboardGetSummarySchema = dashboardBaseSchema;

export async function executeDashboardGetSummary(inputs: any, ctx: any, dbToken: string) {
  const { brandId, fields } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  try {
    const { payload, dateRangeLabel } = await fetchDashboardPayload(inputs, ctx);
    const hasData = (payload.totalQueries ?? 0) > 0;

    const result = {
      _meta: {
        brand_id: brandId,
        date_range: dateRangeLabel,
        data_source: 'EvidentlyAEO live analytics',
        has_data: hasData,
        no_data_instruction: hasData ? null :
          'No analytics data exists for this brand in this date range. Do NOT estimate any metrics. Tell the user no data is available.',
      },
      overview: hasData ? {
        search_visibility_pct: annotateValue(
          payload.visibilityPercentage ?? null,
          'percent_0_to_100',
          'Percentage of tracked AI queries where this brand appeared in a response'
        ),
        sentiment_score: annotateValue(
          payload.sentimentScore ?? null,
          'score_0_to_100',
          'Average positivity of brand mentions across all collected AI responses'
        ),
        total_prompts_tracked: payload.totalQueries,
        total_ai_responses_collected: payload.totalResponses,
        brand_presence_rate_pct: safeDivide(
          payload.queriesWithBrandPresence,
          payload.totalQueries,
          'Percentage of tracked prompts where brand was mentioned at least once',
          100
        ),
      } : null,
      top_topics: hasData
        ? (payload.topTopics || []).slice(0, 5).map((t: any) => ({
            topic_name: t.topic,
            avg_visibility_pct: t.avgVisibility ?? null,
            avg_share_of_voice_pct: t.avgShare ?? null,
            brand_presence_pct: t.brandPresencePercentage ?? null,
          }))
        : annotateEmptyArray('topics', `brand ${brandId}`),
    };

    return projectFields(result as any, fields);
  } catch (error: any) {
    throw new McpSystemError('Failed to fetch dashboard summary', error.message);
  }
}

// ─── Tool 2: dashboard_list_competitors ──────────────────────────────────────
export const dashboardListCompetitorsSchema = dashboardBaseSchema;

export async function executeDashboardListCompetitors(inputs: any, ctx: any, dbToken: string) {
  const { brandId, fields } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  try {
    const { payload, dateRangeLabel } = await fetchDashboardPayload(inputs, ctx);
    const competitors = payload.competitorVisibility || [];

    const result = {
      _meta: {
        brand_id: brandId,
        date_range: dateRangeLabel,
        data_source: 'EvidentlyAEO competitor tracking',
      },
      competitors: competitors.length > 0
        ? competitors.map((comp: any) => ({
            competitor_name: comp.competitor,
            visibility_pct: comp.visibility ?? null,
            share_of_voice_pct: comp.share ?? null,
            sentiment_score_0_to_100: comp.sentiment ?? null,
            total_mentions: comp.mentions ?? null,
            brand_presence_pct: comp.brandPresencePercentage ?? null,
          }))
        : annotateEmptyArray('competitors',
            `brand ${brandId} — Do NOT list competitor names from general knowledge`),
      total_competitors_tracked: competitors.length,
    };

    return projectFields(result as any, fields);
  } catch (error: any) {
    throw new McpSystemError('Failed to fetch competitor data', error.message);
  }
}

// ─── Tool 3: dashboard_llm_breakdown ─────────────────────────────────────────
export const dashboardLlmBreakdownSchema = dashboardBaseSchema;

export async function executeDashboardLlmBreakdown(inputs: any, ctx: any, dbToken: string) {
  const { brandId, fields } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  try {
    const { payload, dateRangeLabel } = await fetchDashboardPayload(inputs, ctx);
    const llmData = payload.llmVisibility || [];

    const result = {
      _meta: {
        brand_id: brandId,
        date_range: dateRangeLabel,
        data_source: 'EvidentlyAEO per-LLM analytics',
        usage_note: 'Each entry shows brand performance within that specific AI engine. Do NOT compare to external benchmarks.',
      },
      llm_breakdown: llmData.length > 0
        ? llmData.map((llm: any) => ({
            llm_provider: llm.provider,
            visibility_pct: llm.visibility ?? null,
            share_of_voice_pct: llm.share ?? null,
            sentiment_score_0_to_100: llm.sentiment ?? null,
            top_topic: llm.topTopic ?? null,
          }))
        : annotateEmptyArray('LLM breakdown entries', `brand ${brandId}`),
      total_llms_tracked: llmData.length,
    };

    return projectFields(result as any, fields);
  } catch (error: any) {
    throw new McpSystemError('Failed to fetch LLM breakdown', error.message);
  }
}

// ─── Tool 4: dashboard_get_action_items ──────────────────────────────────────
export const dashboardGetActionItemsSchema = dashboardBaseSchema;

export async function executeDashboardGetActionItems(inputs: any, ctx: any, dbToken: string) {
  const { brandId, fields } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  try {
    const { payload, dateRangeLabel } = await fetchDashboardPayload(inputs, ctx);
    const items = (payload.actionItems || []).slice(0, 10);

    const result = {
      _meta: {
        brand_id: brandId,
        date_range: dateRangeLabel,
        data_source: 'EvidentlyAEO action item engine',
        usage_note: 'Report these action items exactly as listed. Do NOT add, modify, or generate additional recommendations.',
      },
      action_items: items.length > 0
        ? items
        : annotateEmptyArray('action items', `brand ${brandId}`),
      total_action_items: items.length,
    };

    return projectFields(result as any, fields);
  } catch (error: any) {
    throw new McpSystemError('Failed to fetch action items', error.message);
  }
}

// ─── Legacy handler (deprecated alias — kept for backward compatibility) ──────
export async function executeDashboardKPIs(inputs: any, ctx: any, dbToken: string) {
  // Delegates to the summary tool; old callers still work
  return executeDashboardGetSummary(inputs, ctx, dbToken);
}

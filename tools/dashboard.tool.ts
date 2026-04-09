import { z } from 'zod';
import { dashboardService } from '../../services/brand-dashboard/dashboard.service';
import { validateBrandOwnership } from '../middleware/brand-guard';
import { McpSystemError } from '../utils/response-formatter';
import { brandIdSchema, dateRangeSchema, collectorsSchema } from './schemas';

export const dashboardKPIsSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
  queryTags: z.array(z.string()).optional().describe('Optional query tags to filter by.'),
});

export async function executeDashboardKPIs(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, collectors, queryTags } = inputs;

  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  try {
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const dateRangeLabel = `${start.toISOString().split('T')[0]} to ${end.toISOString().split('T')[0]}`;

    const payload = await dashboardService.getBrandDashboard(
      brandId,
      ctx.customerId,
      { start: start.toISOString(), end: end.toISOString() },
      { collectors, queryTags, skipCache: false }
    );

    const competitors = (payload.competitorVisibility || []).map((comp: any) => ({
      competitor_name: comp.competitor,
      visibility_pct: comp.visibility,
      share_of_voice_pct: comp.share,
      sentiment_score_0_to_100: comp.sentiment,
      total_mentions: comp.mentions,
      brand_presence_pct: comp.brandPresencePercentage,
    }));

    // Explicit empty state handling
    const hasData = payload.totalQueries > 0;

    return {
      _meta: {
        brand_id: brandId,
        date_range: dateRangeLabel,
        data_source: 'EvidentlyAEO live analytics database',
        has_data: hasData,
        no_data_instruction: hasData
          ? null
          : 'No analytics data exists for this brand in the selected date range. Do NOT estimate or infer metrics. Tell the user no data is available and suggest checking the date range or ensuring data collection is running.',
      },
      overview: hasData
        ? {
            search_visibility_pct: {
              value: payload.visibilityPercentage ?? null,
              unit: 'percent_0_to_100',
              label: 'Percentage of tracked AI queries where this brand appeared in a response',
            },
            sentiment_score: {
              value: payload.sentimentScore ?? null,
              unit: 'score_0_to_100',
              label: 'Average positivity of brand mentions across all collected AI responses',
            },
            total_prompts_tracked: payload.totalQueries,
            total_ai_responses_collected: payload.totalResponses,
            brand_presence_rate_pct: {
              value:
                payload.totalQueries > 0
                  ? parseFloat(
                      ((payload.queriesWithBrandPresence / payload.totalQueries) * 100).toFixed(2)
                    )
                  : null,
              unit: 'percent_0_to_100',
              label: 'Percentage of tracked prompts where this brand was mentioned at least once',
            },
          }
        : null,
      llm_breakdown: hasData
        ? payload.llmVisibility.map((llm: any) => ({
            llm_provider: llm.provider,
            visibility_pct: llm.visibility,
            share_of_voice_pct: llm.share,
            sentiment_score: llm.sentiment,
            top_topic: llm.topTopic,
          }))
        : [],
      competitors: competitors,
      competitors_note:
        competitors.length === 0
          ? 'No competitor data found for this date range. Do NOT list competitors from general knowledge.'
          : `${competitors.length} competitors tracked in this period.`,
      action_items: (payload.actionItems || []).slice(0, 5),
      top_topics: hasData
        ? (payload.topTopics || []).slice(0, 5).map((t: any) => ({
            topic_name: t.topic,
            avg_visibility_pct: t.avgVisibility,
            avg_share_of_voice_pct: t.avgShare,
            brand_presence_pct: t.brandPresencePercentage,
          }))
        : [],
    };
  } catch (error: any) {
    throw new McpSystemError('Failed to fetch dashboard KPIs', error.message);
  }
}

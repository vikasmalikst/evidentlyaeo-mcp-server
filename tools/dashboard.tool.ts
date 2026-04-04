import { z } from 'zod';
import { dashboardService } from '../../services/brand-dashboard/dashboard.service';
import { validateBrandOwnership } from '../middleware/brand-guard';
import { McpUserError, McpSystemError } from '../utils/response-formatter';
import { brandIdSchema, dateRangeSchema, collectorsSchema } from './schemas';

/**
 * Dashboard Tool Schema & Handler
 * 
 * Aggregates high-level metrics including Visibility, Share of Voice, Sentiment, 
 * and detailed competitor comparisons.
 */

export const dashboardKPIsSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
  queryTags: z.array(z.string()).optional().describe('Optional query tags to filter by.'),
});

/**
 * Get high-level KPI overview for a brand
 */
export async function executeDashboardKPIs(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, collectors, queryTags } = inputs;

  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  try {
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const payload = await dashboardService.getBrandDashboard(
      brandId,
      ctx.customerId,
      { start: start.toISOString(), end: end.toISOString() },
      {
        collectors,
        queryTags,
        includeCompetitors: true,
        skipCache: false
      }
    );

    // Extract competitor detail for raw comparison as requested
    const competitors = (payload.competitorVisibility || []).map(comp => ({
      name: comp.competitor,
      visibility: comp.visibility,
      share: comp.share,
      sentiment: comp.sentiment,
      mentions: comp.mentions,
      presencePercentage: comp.brandPresencePercentage
    }));

    return {
      overview: {
        searchVisibility: payload.visibilityPercentage,
        sentimentScore: payload.sentimentScore,
        totalPrompts: payload.totalQueries,
        responsesCollected: payload.totalResponses,
        brandPresenceRate: (payload.queriesWithBrandPresence / (payload.totalQueries || 1)) * 100
      },
      llmBreakdown: payload.llmVisibility.map(llm => ({
        provider: llm.provider,
        visibility: llm.visibility,
        share: llm.share,
        sentiment: llm.sentiment,
        topTopic: llm.topTopic
      })),
      competitors,
      actionItems: (payload.actionItems || []).slice(0, 5),
      topTopics: (payload.topTopics || []).slice(0, 5).map(t => ({
        topic: t.topic,
        visibility: t.avgVisibility,
        share: t.avgShare,
        presenceRate: t.brandPresencePercentage
      }))
    };
  } catch (error: any) {
    throw new McpSystemError('Failed to fetch dashboard KPIs', error.message);
  }
}

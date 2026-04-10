import { z } from 'zod';
import { sourceAttributionService } from '../../services/source-attribution.service';
import { validateBrandOwnership } from '../middleware/brand-guard';
import { McpSystemError } from '../utils/response-formatter';
import { brandIdSchema, dateRangeSchema, collectorsSchema } from './schemas';

const MAX_MCP_CITATIONS = 20;

export const getSourceAttributionSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
  queryTags: z.array(z.string()).optional().describe('Optional list of query tags to filter by.'),
});

export async function executeSourceAttribution(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, collectors, queryTags } = inputs;

  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  try {
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const dateRangeLabel = `${start.toISOString().split('T')[0]} to ${end.toISOString().split('T')[0]}`;

    const result = await sourceAttributionService.getSourceAttribution(
      brandId,
      ctx.customerId,
      { start: start.toISOString(), end: end.toISOString() },
      undefined,
      collectors,
      queryTags
    );

    const hasSources = result.sources && result.sources.length > 0;
    const sortedSources = [...(result.sources || [])].sort(
      (a: any, b: any) =>
        (b.value ?? Number.NEGATIVE_INFINITY) - (a.value ?? Number.NEGATIVE_INFINITY) ||
        (b.mentionRate ?? 0) - (a.mentionRate ?? 0)
    );
    const topSources = sortedSources.slice(0, MAX_MCP_CITATIONS);
    const compactSources = topSources.map((source: any) => ({
      name: source.name,
      url: source.url,
      type: source.type,
      value: source.value,
      citations: source.citations,
      mentionRate: source.mentionRate,
      soa: source.soa,
      sentiment: source.sentiment,
      visibility: source.visibility,
      averagePosition: source.averagePosition,
    }));
    const totalSourcesAvailable = result.totalSources ?? sortedSources.length;
    const returnedSources = compactSources.length;

    return {
      _meta: {
        brand_id: brandId,
        date_range: dateRangeLabel,
        data_source: 'EvidentlyAEO source attribution — real citation data only',
        has_data: hasSources,
        limit_applied: MAX_MCP_CITATIONS,
        returned_sources: returnedSources,
        total_sources_available: totalSourcesAvailable,
        truncated: totalSourcesAvailable > returnedSources,
        ranking: 'value_desc',
        no_data_instruction: hasSources
          ? null
          : 'No citation sources found for this brand in the selected period. Do NOT list likely sources from general knowledge. Tell the user no source data is available.',
      },
      summary: hasSources
        ? {
            total_unique_sources: result.totalSources,
            overall_mention_rate_pct: {
              value: result.overallMentionRate,
              unit: 'percent_0_to_100',
              label: 'Percentage of AI responses that cited at least one tracked source for this brand',
            },
            avg_sentiment_score: {
              value: result.avgSentiment,
              unit: 'score_0_to_100',
              label: 'Average sentiment score across all source citations',
            },
          }
        : null,
      sources: hasSources ? compactSources : [],
    };
  } catch (error: any) {
    throw new McpSystemError('Failed to fetch source attribution', error.message);
  }
}

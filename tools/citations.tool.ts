import { z } from 'zod';
import { sourceAttributionService } from '../../services/source-attribution.service';
import { validateBrandOwnership } from '../middleware/brand-guard';
import { McpSystemError } from '../utils/response-formatter';
import { brandIdSchema, dateRangeSchema, collectorsSchema, fieldsSchema } from './schemas';
import { annotateValue, annotateEmptyArray, projectFields } from '../utils/data-sanitizer';

export const getSourceAttributionSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
  ...fieldsSchema.shape,
  queryTags: z.array(z.string()).optional().describe(
    'Optional list of query tags to filter by topic segment.'
  ),
  topN: z.number().int().min(1).max(50).optional().describe(
    'Return only the top N sources by mention volume. Default returns all. ' +
    'Use 10 for quick summaries to reduce token usage.'
  ),
});

export async function executeSourceAttribution(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, collectors, queryTags, topN, fields } = inputs;

  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  try {
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const dateRangeLabel = `${start.toISOString().split('T')[0]} to ${end.toISOString().split('T')[0]}`;

    const raw = await sourceAttributionService.getSourceAttribution(
      brandId,
      ctx.customerId,
      { start: start.toISOString(), end: end.toISOString() },
      undefined,
      collectors,
      queryTags
    );

    const allSources = raw.sources || [];
    const sources = topN ? allSources.slice(0, topN) : allSources;
    const hasSources = sources.length > 0;

    const result = {
      _meta: {
        brand_id: brandId,
        date_range: dateRangeLabel,
        data_source: 'EvidentlyAEO source attribution — real citation data only',
        has_data: hasSources,
        total_sources_available: allSources.length,
        sources_returned: sources.length,
        no_data_instruction: hasSources ? null :
          'No citation sources found. Do NOT list likely sources from general knowledge.',
      },
      summary: hasSources ? {
        total_unique_sources: raw.totalSources,
        overall_mention_rate_pct: annotateValue(
          raw.overallMentionRate,
          'percent_0_to_100',
          'Percentage of AI responses that cited at least one tracked source for this brand'
        ),
        avg_sentiment_score: annotateValue(
          raw.avgSentiment,
          'score_0_to_100',
          'Average sentiment score across all source citations'
        ),
      } : null,
      sources: hasSources ? sources : annotateEmptyArray('citation sources', `brand ${brandId}`),
    };

    return projectFields(result as any, fields);
  } catch (error: any) {
    throw new McpSystemError('Failed to fetch source attribution', error.message);
  }
}

import { z } from 'zod';
import { sourceAttributionService } from '../../services/source-attribution.service';
import { McpUserError, McpSystemError } from '../utils/response-formatter';
import { brandIdSchema, dateRangeSchema, collectorsSchema } from './schemas';

/**
 * Citations Tool Schema & Handler
 */

export const getSourceAttributionSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
  queryTags: z.array(z.string()).optional().describe('Optional list of query tags to filter by.'),
});

/**
 * Get Source Attribution data for a specific brand
 */
export async function executeSourceAttribution(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, collectors, queryTags } = inputs;

  try {
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const result = await sourceAttributionService.getSourceAttribution(
      brandId,
      ctx.customerId,
      { start: start.toISOString(), end: end.toISOString() },
      undefined, // comparisonRange
      collectors,
      queryTags
    );

    return { 
      sources: result.sources,
      summary: {
        totalSources: result.totalSources,
        overallMentionRate: result.overallMentionRate,
        avgSentiment: result.avgSentiment
      }
    };
  } catch (error: any) {
    throw new McpSystemError('Failed to fetch source attribution', error.message);
  }
}

import { z } from 'zod';
import { supabaseAdmin } from '../../config/database';
import { validateBrandOwnership } from '../middleware/brand-guard';
import { McpUserError, McpSystemError } from '../utils/response-formatter';
import { brandIdSchema, dateRangeSchema, paginationSchema } from './schemas';

export const listRecommendationsSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...paginationSchema.shape,
  priority: z
    .enum(['high', 'medium', 'low', 'all'])
    .optional()
    .describe('Filter by recommendation priority.'),
});

export const getRecommendationDetailSchema = z.object({
  recommendationId: z
    .string()
    .uuid()
    .describe('The unique ID of the specific recommendation to retrieve detail for.'),
});

export async function executeListRecommendations(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, limit = 20, offset = 0, priority } = inputs;

  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  let query = supabaseAdmin
    .from('recommendations')
    .select('id, action, reason, impact_score, priority, category:citation_category, created_at')
    .eq('brand_id', brandId)
    .eq('customer_id', ctx.customerId)
    .order('impact_score', { ascending: false })
    .range(offset, offset + limit - 1);

  if (startDate) query = query.gte('created_at', startDate);
  if (endDate) query = query.lte('created_at', endDate);

  if (priority && priority !== 'all') {
    const PRIORITY_MAP: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' };
    const mappedPriority = PRIORITY_MAP[priority];
    if (mappedPriority) query = query.eq('priority', mappedPriority);
  }

  const { data, error } = await query;

  if (error) throw new McpSystemError('Failed to fetch recommendations', error.message);

  const recs = data || [];

  if (recs.length === 0) {
    return {
      recommendations: [],
      empty_state_message:
        'No recommendations found for this brand in the selected period or priority filter. ' +
        'Do NOT generate or suggest recommendations from general knowledge. ' +
        'Tell the user no AI recommendations are available yet and suggest running a data collection cycle.',
      _meta: { brand_id: brandId, filter_priority: priority ?? 'all' },
    };
  }

  return {
    recommendations: recs.map((r: any) => ({
      id: r.id,
      action: r.action,
      reason: r.reason,
      impact_score_0_to_100: r.impact_score,
      priority: r.priority,
      category: r.category,
      created_at: r.created_at,
    })),
    total_returned: recs.length,
    _meta: {
      brand_id: brandId,
      data_source: 'EvidentlyAEO AI-generated recommendations — based on real collected data',
      usage_note:
        'impact_score is 0–100. Report recommendations exactly as listed. Do NOT add, modify, or prioritize differently than shown.',
    },
  };
}

export async function executeGetRecommendationDetail(inputs: any, ctx: any, dbToken: string) {
  const { recommendationId } = inputs;

  const { data, error } = await supabaseAdmin
    .from('recommendations')
    .select('*')
    .eq('id', recommendationId)
    .eq('customer_id', ctx.customerId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      throw new McpUserError('Recommendation not found or unauthorized', 'NOT_FOUND');
    }
    throw new McpSystemError('Failed to fetch recommendation detail', error.message);
  }

  return {
    recommendation: data,
    _meta: {
      data_source: 'EvidentlyAEO recommendations database — exact stored record',
      usage_note: 'Report this recommendation exactly as stored. Do NOT embellish or add context not present in the data.',
    },
  };
}

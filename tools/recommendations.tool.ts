import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { config } from '../../config/environment';
import { validateBrandOwnership } from '../middleware/brand-guard';
import { McpUserError, McpSystemError } from '../utils/response-formatter';
import { brandIdSchema, dateRangeSchema, paginationSchema } from './schemas';

/**
 * Recommendations Tool Schema & Handler
 * 
 * [!CAUTION] This tool performs direct DB queries on the recommendations table.
 * It MUST use the user-scoped client (supabaseClient with dbToken) to ensure RLS compliance.
 */

export const listRecommendationsSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...paginationSchema.shape,
  priority: z.enum(['high', 'medium', 'low', 'all']).optional().describe('Filter by recommendation priority.'),
});

export const getRecommendationDetailSchema = z.object({
  recommendationId: z.string().uuid().describe('The unique ID of the specific recommendation to retrieve detail for.'),
});

/**
 * List AI Strategy Recommendations for a specific brand
 */
export async function executeListRecommendations(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, limit = 20, offset = 0, priority } = inputs;

  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  // Initialize user-scoped Supabase client with the shadow dbToken
  const userClient = createClient(config.supabase.url, config.supabase.anonKey, {
    global: { headers: { Authorization: `Bearer ${dbToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let query = userClient
    .from('recommendations')
    .select('id, action, reason, impact_score, priority, category:citation_category, created_at')
    .eq('brand_id', brandId)
    .eq('customer_id', ctx.customerId) // Explicit ownership join
    .order('impact_score', { ascending: false })
    .range(offset, offset + limit - 1);

  if (startDate) query = query.gte('created_at', startDate);
  if (endDate) query = query.lte('created_at', endDate);
  if (priority && priority !== 'all') query = query.eq('priority', priority);

  const { data, error } = await query;

  if (error) {
    throw new McpSystemError('Failed to fetch recommendations', error.message);
  }

  return { recommendations: data || [] };
}

/**
 * Get technical details for a specific recommendation
 */
export async function executeGetRecommendationDetail(inputs: any, ctx: any, dbToken: string) {
  const { recommendationId } = inputs;

  // Initialize user-scoped Supabase client with the shadow dbToken
  const userClient = createClient(config.supabase.url, config.supabase.anonKey, {
    global: { headers: { Authorization: `Bearer ${dbToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await userClient
    .from('recommendations')
    .select('*')
    .eq('id', recommendationId)
    .eq('customer_id', ctx.customerId) // Explicit ownership join
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      throw new McpUserError('Recommendation not found or unauthorized', 'NOT_FOUND');
    }
    throw new McpSystemError('Failed to fetch recommendation detail', error.message);
  }

  return { recommendation: data };
}

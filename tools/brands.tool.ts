import { z } from 'zod';
import { McpSystemError, McpUserError } from '../utils/response-formatter';
import { createClient } from '@supabase/supabase-js';
import { config } from '../../config/environment';
import { McpUserContext } from '../auth/token-validator';

// For brands list, we just return the raw data and format it per standard
export const brandsListSchema = z.object({}); // No inputs needed

export async function executeBrandsList(inputs: unknown, ctx: McpUserContext, dbToken: string) {
  const userClient = createClient(config.supabase.url, config.supabase.anonKey, {
    global: { headers: { Authorization: `Bearer ${dbToken}` } },
    auth: { persistSession: false },
  });

  const { data, error } = await userClient
    .from('brands')
    .select('id, name, industry, homepage_url, created_at')
    .eq('customer_id', ctx.customerId);

  if (error) {
    throw new McpSystemError('Failed to fetch brands', error.message);
  }

  if (!data || data.length === 0) {
    return { brands: [] };
  }

  return {
    brands: data.map((b) => ({
      id: b.id,
      name: b.name,
      industry: b.industry,
      homepage_url: b.homepage_url,
      created_at: b.created_at,
    })),
  };
}

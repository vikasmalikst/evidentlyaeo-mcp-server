import { createClient } from '@supabase/supabase-js';
import { config } from '../../config/environment';
import { McpSystemError, McpUserError } from '../utils/response-formatter';
import { BrandRow } from '../../services/brand-dashboard/types';

/**
 * Runs BEFORE every brand-scoped MCP tool. Never skip this.
 * Instantiates a user-scoped client securely so Row Level Security (RLS) is enforced.
 */
export async function validateBrandOwnership(
  brandId: string,
  customerId: string,
  dbToken: string
): Promise<BrandRow> {
  // Create user-scoped client leveraging RLS via standard Supabase shadow token
  const userClient = createClient(config.supabase.url, config.supabase.anonKey, {
    global: {
      headers: { Authorization: `Bearer ${dbToken}` },
    },
    auth: { persistSession: false },
  });

  // Execute lookup logic. If RLS fails, it returns 0 rows.
  const { data, error } = await userClient
    .from('brands')
    .select('id, name, slug')
    .eq('id', brandId)
    .eq('customer_id', customerId)
    .maybeSingle();

  if (error) {
    throw new McpSystemError('Brand lookup failed', error.message);
  }

  if (!data) {
    throw new McpUserError('Brand not found, or access denied by RLS policy.', 'BRAND_NOT_FOUND');
  }

  return data as BrandRow;
}

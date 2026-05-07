import { supabaseAdmin } from '../../config/database';
import { McpSystemError, McpUserError } from '../utils/response-formatter';
export interface BrandRow {
  id: string;
  name: string;
  slug: string;
}

/**
 * Runs BEFORE every brand-scoped MCP tool. Never skip this.
 * Uses supabaseAdmin with explicit customerId filtering to bypass RLS shadow token issues.
 */
export async function validateBrandOwnership(
  brandId: string,
  customerId: string,
  _dbToken: string // Kept in signature for backward compatibility with callers
): Promise<BrandRow> {
  // Execute lookup logic with explicit customer ownership check
  const { data, error } = await supabaseAdmin
    .from('brands')
    .select('id, name, slug')
    .eq('id', brandId)
    .eq('customer_id', customerId)
    .maybeSingle();

  if (error) {
    throw new McpSystemError('Brand lookup failed', error.message);
  }

  if (!data) {
    throw new McpUserError('Brand not found, or access denied.', 'BRAND_NOT_FOUND');
  }

  return data as BrandRow;
}

/**
 * Middleware-friendly helper used in executeToolWithMiddleware.
 */
export async function assertBrandOwnership(
  brandId: string,
  customerId: string
): Promise<void> {
  await validateBrandOwnership(brandId, customerId, '');
}

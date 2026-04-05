import { z } from 'zod';
import { brandService } from '../../services/brand.service';
import { McpUserContext } from '../auth/token-validator';
import { McpSystemError } from '../utils/response-formatter';

// For brands list, we just return the raw data and format it per standard
export const brandsListSchema = z.object({}); // No inputs needed

export async function executeBrandsList(inputs: unknown, ctx: McpUserContext, dbToken: string) {
  // Use core service instead of direct DB query to avoid RLS issues with shadow tokens
  const brands = await brandService.getBrandsByCustomer(ctx.customerId);

  if (!brands || brands.length === 0) {
    return { brands: [] };
  }

  // Return only the fields the MCP client needs — never expose raw internal Brand objects
  return {
    brands: brands.map((b) => ({
      id: b.id,
      name: b.name,
      industry: b.industry,
      homepage_url: (b as any).homepage_url || b.website_url, // Handle internal mapping variations
      created_at: b.created_at,
    })),
  };
}

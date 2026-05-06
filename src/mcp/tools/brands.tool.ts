import { z } from 'zod';
import { brandService } from '../../services/brand.service';
import { McpUserContext } from '../auth/token-validator';
import { McpSystemError } from '../utils/response-formatter';

export const brandsListSchema = z.object({});

export async function executeBrandsList(inputs: unknown, ctx: McpUserContext, dbToken: string) {
  const brands = await brandService.getBrandsByCustomer(ctx.customerId);

  if (!brands || brands.length === 0) {
    return {
      brands: [],
      empty_state_message:
        'No brands found for this account. Please create a brand in the EvidentlyAEO dashboard before using analytics tools. Do NOT infer that brands exist.',
    };
  }

  return {
    brands: brands.map((b) => ({
      id: b.id,
      name: b.name,
      industry: b.industry,
      homepage_url: (b as any).homepage_url || b.website_url,
      created_at: b.created_at,
    })),
    total_brands: brands.length,
    usage_instruction:
      'Use the "id" field from each brand above when calling other tools that require a brandId.',
  };
}

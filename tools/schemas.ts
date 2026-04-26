import { z } from 'zod';

/**
 * Shared Zod Schemas for EvidentlyAEO MCP Tools
 */

export const isoDateSchema = z.string().datetime({ message: 'Must be a valid ISO-8601 date string' });

export const dateRangeSchema = z.object({
  startDate: isoDateSchema.optional().describe(
    'Filter data from this ISO-8601 start date. Defaults to 30 days ago if omitted. ' +
    'Example: "2026-03-01T00:00:00.000Z". Do not infer dates not provided by the user.'
  ),
  endDate: isoDateSchema.optional().describe(
    'Filter data until this ISO-8601 end date. Defaults to now if omitted. ' +
    'Example: "2026-04-01T00:00:00.000Z". Do not infer dates not provided by the user.'
  ),
});

export const paginationSchema = z.object({
  limit: z.number().int().min(1).optional().describe(
    'Maximum number of items to return. Omit to return all results. Use 5–10 for quick summaries.'
  ),
  offset: z.number().int().min(0).optional().describe(
    'Number of items to skip for pagination. Use with limit for paging through large result sets.'
  ),
});

export const brandIdSchema = z.object({
  brandId: z.string().uuid().describe(
    'The UUID of the brand to query. Must come from the brands_list tool — never guess or construct this value.'
  ),
});

export const collectorsSchema = z.object({
  collectors: z.preprocess(
    (val) => Array.isArray(val) 
      ? val.map(v => typeof v === 'string' ? v.toLowerCase() : v) 
      : val,
    z.array(z.string()).optional()
  ).describe(
    'Optional list of AI collector slugs to filter by. ' +
    'Values are case-insensitive. Valid values include: "chatgpt", "perplexity", "gemini", "grok", "google_aio", "copilot". ' +
    'Omit to include all collectors.'
  ),
});

/**
 * Universal fields projection — lets Claude request only specific top-level keys,
 * reducing token usage when only partial data is needed.
 */
export const fieldsSchema = z.object({
  fields: z.array(z.string()).optional().describe(
    'Optional list of top-level field names to include in the response. ' +
    'Use this to reduce token usage when you only need specific data. ' +
    'Example: ["overview", "top_topics"] returns only those keys from the result. ' +
    'Omit to receive all available fields.'
  ),
});

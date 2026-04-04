import { z } from 'zod';

/**
 * Shared Zod Schemas for EvidentlyAEO MCP Tools
 */

// ISO Date string validation
export const isoDateSchema = z.string().datetime({ message: 'Must be a valid ISO-8601 date string' });

// Common Date Range Schema
export const dateRangeSchema = z.object({
  startDate: isoDateSchema.optional().describe('Filter data from this start date (ISO format). Defaults to last 30 days if omitted.'),
  endDate: isoDateSchema.optional().describe('Filter data until this end date (ISO format). Defaults to current date if omitted.'),
});

// Common Pagination Schema
export const paginationSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().describe('Maximum number of items to return. Default is 20.'),
  offset: z.number().int().min(0).optional().describe('Number of items to skip for pagination.'),
});

// Brand ID Schema
export const brandIdSchema = z.object({
  brandId: z.string().uuid().describe('The unique identifier of the brand to query.'),
});

// Collector Slugs Schema
export const collectorsSchema = z.object({
  collectors: z.array(z.string()).optional().describe('Optional list of AI collectors to filter by (e.g. ["chatgpt", "perplexity"]).'),
});

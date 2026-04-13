import { z } from 'zod';
import { sourceAttributionService } from '../../services/source-attribution.service';
import { citationAggregationService } from '../../services/mcp-aggregations/citation-aggregation.service';
import { validateBrandOwnership } from '../middleware/brand-guard';
import { McpSystemError } from '../utils/response-formatter';
import { brandIdSchema, dateRangeSchema, collectorsSchema, fieldsSchema } from './schemas';
import { getCached, setCached, buildCacheKey } from '../cache/tool-cache';
import { annotateEmptyArray, projectFields } from '../utils/data-sanitizer';

/** Round to 1 decimal place. Returns null if value is null/undefined. */
function r1(v: number | null | undefined): number | null {
  if (v == null) return null;
  return Math.round(v * 10) / 10;
}

// -----------------------------------------------------------------------------
// Tool C1: citations_top_sources
// -----------------------------------------------------------------------------

export const citationsTopSourcesSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
  ...fieldsSchema.shape,
  topN: z.number().int().min(1).max(30).optional().describe(
    'Max sources to return, sorted by mention count descending. Default 10. Use 5 for quick summaries.'
  ),
  queryTags: z.array(z.string()).optional().describe(
    'Optional topic segment filter. Omit to return sources across all topics.'
  ),
});

export async function executeCitationsTopSources(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, collectors, topN = 10, fields } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const sources = await citationAggregationService.getTopCitedSources({
    brandId,
    customerId: ctx.customerId,
    startDate,
    endDate,
    collectors,
    limit: topN,
  });

  const result = {
    sources: sources.length > 0 ? sources : annotateEmptyArray('citation sources', `brand ${brandId}`),
    _meta: {
      brand_id: brandId,
      date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      sources_returned: sources.length,
      data_source: 'EvidentlyAEO citations — aggregated from citations table.',
      field_guide: {
        citation_count: 'Total times this domain was cited in AI responses for this brand.',
        mention_rate_pct: '% share of total citations this domain represents.',
        unique_query_count: 'How many distinct tracked queries cited this domain.',
        null_values: 'null means no data was collected. Do NOT report null as 0.',
      }
    }
  };

  return projectFields(result as any, fields);
}

// -----------------------------------------------------------------------------
// Tool C2: citations_source_detail
// -----------------------------------------------------------------------------

export const citationsSourceDetailSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
  domain: z.string().min(1).describe(
    'The exact domain to inspect (e.g. "forbes.com"). Copy from citations_top_sources output. ' +
    'Do NOT pass a full URL — domain only.'
  ),
});

export async function executeCitationsSourceDetail(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, collectors, domain } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const cacheKey = buildCacheKey('citations_shared', ctx.customerId, brandId, { startDate, endDate, collectors });
  const cached = getCached(cacheKey);
  
  let raw;
  let cacheHit = false;
  
  if (cached) {
    raw = cached;
    cacheHit = true;
  } else {
    try {
      raw = await sourceAttributionService.getSourceAttribution(
        brandId,
        ctx.customerId,
        { start: startDate, end: endDate },
        undefined,
        collectors
      );
      setCached(cacheKey, raw);
    } catch (error: any) {
      throw new McpSystemError('Failed to fetch source attribution', error.message);
    }
  }

  const needle = domain.toLowerCase().trim();
  const source = (raw.sources || []).find((s: any) => s.name.toLowerCase().trim() === needle);

  if (!source) {
    return {
      found: false,
      message: `Domain "${domain}" not found in citation data for this period. Call citations_top_sources first to get valid domain names.`,
      _meta: { brand_id: brandId, cache_hit: cacheHit }
    };
  }

  const result = {
    domain: source.name,
    mention_count: source.citations,
    mention_rate_pct: r1(source.mentionRate),
    sentiment_score: r1(source.sentiment),
    source_type: source.type || null,
    total_pages_cited: source.pages?.length || 0,
    top_pages: source.topPages || [],
    topics: source.topics || [],
    _meta: {
      brand_id: brandId,
      date_range: raw.dateRange,
      cache_hit: cacheHit,
    }
  };

  return result;
}

// -----------------------------------------------------------------------------
// Tool C3: citations_competitor_gap
// -----------------------------------------------------------------------------

export const citationsCompetitorGapSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
  ...fieldsSchema.shape,
  topN: z.number().int().min(1).max(30).optional().describe(
    'Max gap domains to return, sorted by competitor_mention_count descending. Default 15.'
  ),
});

export async function executeCitationsCompetitorGap(inputs: any, ctx: any, dbToken: string) {
  const { brandId } = inputs;
  // This tool is a stub as per instructions because service doesn't return cross-brand data yet.
  return {
    gap_sources: annotateEmptyArray('competitor gap sources', `brand ${brandId}`),
    _meta: {
      brand_id: brandId,
      note: 'Competitor citation gap data not yet available from service layer. This tool requires sourceAttributionService to return cross-brand source data.',
      cache_hit: false
    }
  };
}

// -----------------------------------------------------------------------------
// Tool C4: citations_trend
// -----------------------------------------------------------------------------

export const citationsTrendSchema = z.object({
  ...brandIdSchema.shape,
  ...collectorsSchema.shape,
  granularity: z.enum(['week', 'month']).optional().describe(
    'Time period granularity. "week" = 7-day periods. "month" = 30-day periods. Default "week".'
  ),
  periods: z.number().int().min(2).max(12).optional().describe(
    'Number of periods to return. Default 4. Minimum 2 (need at least 2 to compute a delta).'
  ),
});

export async function executeCitationsTrend(inputs: any, ctx: any, dbToken: string) {
  const { brandId, collectors, granularity = 'week', periods = 4 } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  try {
    const trendPeriods = await citationAggregationService.getCitationTrend({
      brandId,
      customerId: ctx.customerId,
      granularity,
      periods,
      collectors,
    });

    return {
      periods: trendPeriods,
      _meta: {
        brand_id: brandId,
        granularity,
        field_guide: {
          delta_citations: 'Change in citation count vs prior period (%). Positive = growing. Negative = declining. null = no prior period.',
          null_values: 'null means no data or no prior period. Do NOT report null as flat.',
        },
      }
    };
  } catch (error: any) {
    throw new McpSystemError('Failed to compute citation trends', error.message);
  }
}

// -----------------------------------------------------------------------------
// Legacy Wrapper
// -----------------------------------------------------------------------------

/** @deprecated Use executeCitationsTopSources */
export async function executeSourceAttribution(inputs: any, ctx: any, dbToken: string) {
  return executeCitationsTopSources(inputs, ctx, dbToken);
}

export const getSourceAttributionSchema = citationsTopSourcesSchema;

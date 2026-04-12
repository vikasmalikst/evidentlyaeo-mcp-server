import { z } from 'zod';
import { sourceAttributionService } from '../../services/source-attribution.service';
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
  const { brandId, startDate, endDate, collectors, queryTags, topN = 10, fields } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const cacheKey = buildCacheKey('citations_shared', ctx.customerId, brandId, { startDate, endDate, collectors, queryTags });
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
        collectors,
        queryTags
      );
      setCached(cacheKey, raw);
    } catch (error: any) {
      throw new McpSystemError('Failed to fetch source attribution', error.message);
    }
  }

  const sources = (raw.sources || [])
    .map((s: any) => ({
      domain: s.name,
      mention_count: s.citations,
      mention_rate_pct: r1(s.mentionRate),
      sentiment_score: r1(s.sentiment),
      source_type: s.type || null,
    }))
    .sort((a: any, b: any) => b.mention_count - a.mention_count)
    .slice(0, topN);

  const result = {
    sources: sources.length > 0 ? sources : annotateEmptyArray('citation sources', `brand ${brandId}`),
    _meta: {
      brand_id: brandId,
      date_range: raw.dateRange,
      data_source: 'EvidentlyAEO source attribution',
      total_sources_available: raw.totalSources,
      sources_returned: sources.length,
      cache_hit: cacheHit,
      field_guide: {
        mention_count: 'Number of AI responses that cited this domain for this brand.',
        mention_rate_pct: '0–100. % of all AI responses that included this domain as a citation.',
        sentiment_score: '0–100. Average sentiment of responses citing this domain. null = no data.',
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

  const daysPerPeriod = granularity === 'month' ? 30 : 7;
  const now = new Date();
  const periodResults = [];

  try {
    for (let i = 0; i < periods; i++) {
      const end = new Date(now.getTime() - i * daysPerPeriod * 24 * 60 * 60 * 1000);
      const start = new Date(now.getTime() - (i + 1) * daysPerPeriod * 24 * 60 * 60 * 1000);
      
      const startIso = start.toISOString();
      const endIso = end.toISOString();
      const label = `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${end.toLocaleDateString('en-US', { day: 'numeric' })}`;

      const cacheKey = buildCacheKey('citations_trend', ctx.customerId, brandId, { start: startIso, end: endIso, collectors });
      const cached = getCached(cacheKey);
      
      let raw;
      if (cached) {
        raw = cached;
      } else {
        raw = await sourceAttributionService.getSourceAttribution(
          brandId,
          ctx.customerId,
          { start: startIso, end: endIso },
          undefined,
          collectors
        );
        setCached(cacheKey, raw);
      }

      periodResults.push({
        period_label: label,
        total_unique_sources: raw.totalSources,
        mention_rate_pct: r1(raw.overallMentionRate),
        avg_sentiment: r1(raw.avgSentiment),
      });
    }

    // Compute deltas (current vs previous)
    const finalPeriods = periodResults.map((p, idx) => {
      const nextIdx = idx + 1;
      const prevPeriod = periodResults[nextIdx];
      let delta_mention_rate = null;
      let delta_sentiment = null;

      if (prevPeriod) {
        // Delta % = ((current - previous) / previous) * 100
        if (prevPeriod.mention_rate_pct !== 0 && prevPeriod.mention_rate_pct != null) {
          delta_mention_rate = r1(((p.mention_rate_pct! - prevPeriod.mention_rate_pct!) / prevPeriod.mention_rate_pct!) * 100);
        }
        if (prevPeriod.avg_sentiment !== 0 && prevPeriod.avg_sentiment != null) {
          delta_sentiment = r1(((p.avg_sentiment! - prevPeriod.avg_sentiment!) / prevPeriod.avg_sentiment!) * 100);
        }
      }

      return {
        ...p,
        delta_mention_rate,
        delta_sentiment
      };
    });

    return {
      periods: finalPeriods,
      _meta: {
        brand_id: brandId,
        granularity,
        field_guide: {
          delta_mention_rate: 'Change in mention_rate_pct vs the previous period. Positive = improving. Negative = declining. null = no previous period to compare.',
          null_values: 'null means no data or no prior period. Do NOT report null as 0 or as flat.',
        },
        cache_hit: false
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

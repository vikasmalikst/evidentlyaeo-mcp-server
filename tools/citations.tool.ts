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
  queryType: z.preprocess(
    (val) => {
      if (typeof val !== 'string') return val;
      const map: Record<string, string> = {
        'neutral': 'neutral', 'blind': 'neutral', 'unprompted': 'neutral',
        'branded': 'branded', 'brand': 'branded', 'biased': 'branded',
        'competitor': 'competitor',
      };
      return map[val.toLowerCase()] ?? val;
    },
    z.enum(['branded', 'neutral', 'competitor']).optional()
  ).describe(
    'Filter citations to only those from queries of this type. ' +
    '"neutral" = blind/unprompted queries (NO brand name in query). SYNONYMS: "blind", "unprompted". ' +
    '"branded" = queries that explicitly named this brand. SYNONYMS: "brand", "biased". ' +
    '"competitor" = queries naming a competitor.'
  ),
  topN: z.number().int().min(1).max(30).optional().describe(
    'Max sources to return, sorted by mention count descending. Default 10. Use 5 for quick summaries.'
  ),
  queryTags: z.array(z.string()).optional().describe(
    'Optional topic segment filter. Omit to return sources across all topics.'
  ),
});

export async function executeCitationsTopSources(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, collectors, queryType, topN = 10, fields } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  // Map canonical queryType back to DB query_tag values (DB stores 'blind'/'brand', not 'neutral'/'branded')
  const dbQueryTagMap: Record<string, string> = {
    'neutral': 'blind',
    'branded': 'brand',
    'competitor': 'competitor',
  };
  const dbQueryTag = queryType ? dbQueryTagMap[queryType] ?? queryType : undefined;

  // ✅ Use same service as frontend. Pass queryType as queryTags if provided.
  const raw = await sourceAttributionService.getSourceAttribution(
    brandId,
    ctx.customerId,
    { start: startDate, end: endDate },
    undefined,
    collectors,
    dbQueryTag ? [dbQueryTag] : undefined
  );

  const allSources = raw.sources || [];
  const totalCitations = allSources.reduce((acc: number, s: any) => acc + (s.citations || 0), 0);

  // ✅ Compute impact score using SAME formula as frontend valueScoreForSource()
  const maxCitations = Math.max(...allSources.map((s: any) => s.citations || 0), 1);
  const maxSentiment = Math.max(...allSources.map((s: any) => s.sentiment || 0), 1);
  const maxTopics = Math.max(...allSources.map((s: any) => (s.topics?.length || 0)), 1);

  const scored = allSources.map((s: any) => {
    const sentimentNorm = maxSentiment > 0 ? Math.min(100, (s.sentiment / maxSentiment) * 100) : 0;
    const citationsNorm = maxCitations > 0 ? (s.citations / maxCitations) * 100 : 0;
    const topicsNorm = maxTopics > 0 ? ((s.topics?.length || 0) / maxTopics) * 100 : 0;
    
    // Weighted formula: mentionRate×0.3 + soa×0.3 + sentiment×0.2 + citations×0.1 + topics×0.1
    const impact_score = Math.round(
      (s.mentionRate || 0) * 0.3 +
      (s.soa || 0) * 0.3 +
      sentimentNorm * 0.2 +
      citationsNorm * 0.1 +
      topicsNorm * 0.1
    );

    // ✅ Compute quadrant using SAME logic as frontend classifyQuadrant()
    const mentionRate = s.mentionRate || 0;
    const soa = s.soa || 0;
    let category: string;
    if (mentionRate >= 50 && soa >= 50 && impact_score >= 40) category = 'priority';
    else if (mentionRate >= 50 && (s.sentiment < 50 || s.citations < 2)) category = 'reputation';
    else if (mentionRate < 50 && (s.sentiment > 60 || s.citations > 1)) category = 'growth';
    else category = 'monitor';

    return {
      domain: s.name,
      source_type: s.type || null,
      impact_score,
      mention_rate_pct: r1(s.mentionRate),
      soa_pct: r1(s.soa),
      sentiment_score: r1(s.sentiment),
      sentiment_label: s.sentiment > 65 ? 'positive' : s.sentiment < 40 ? 'negative' : 'neutral',
      citations_count: s.citations || 0,
      citations_pct: r1(totalCitations > 0 ? (s.citations / totalCitations) * 100 : 0),
      category,  // priority | reputation | growth | monitor
    };
  });

  const sorted = scored.sort((a: any, b: any) => b.impact_score - a.impact_score).slice(0, topN);

  // ✅ Also include source type distribution (mirrors the bar chart)
  const typeDistribution = allSources.reduce((acc: any, s: any) => {
    const t = (s.type || 'unknown').toLowerCase();
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});

  const result = {
    sources: sorted.length > 0 ? sorted : annotateEmptyArray('citation sources', `brand ${brandId}`),
    source_type_distribution: typeDistribution,
    category_summary: {
      priority: scored.filter((s: any) => s.category === 'priority').length,
      reputation: scored.filter((s: any) => s.category === 'reputation').length,
      growth: scored.filter((s: any) => s.category === 'growth').length,
      monitor: scored.filter((s: any) => s.category === 'monitor').length,
    },
    _meta: {
      brand_id: brandId,
      date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      sources_returned: sorted.length,
      total_sources: allSources.length,
      field_guide: {
        impact_score: 'Composite 0–100 score: mentionRate×0.3 + SOA×0.3 + sentiment×0.2 + citations×0.1 + topics×0.1. This is the PRIMARY ranking field.',
        mention_rate_pct: '% of AI responses for this brand that cited this domain.',
        soa_pct: 'Share of AI response text attributed to this domain.',
        sentiment_score: '0–100. Sentiment of brand mentions in this domain\'s responses.',
        citations_pct: '% of total citation events from this domain.',
        category: 'priority = high visibility + high SOA. reputation = high visibility + low sentiment. growth = low visibility + positive signals. monitor = low on all.',
        null_values: 'null = no data. Do NOT report null as 0.',
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

import { z } from 'zod';
import { queryAggregationService } from '../../services/mcp-aggregations/query-aggregation.service';
import { validateBrandOwnership } from '../middleware/brand-guard';
import { McpSystemError } from '../utils/response-formatter';
import { brandIdSchema, dateRangeSchema, collectorsSchema, fieldsSchema } from './schemas';
import { annotateEmptyArray, projectFields } from '../utils/data-sanitizer';
import { getCached, setCached, buildCacheKey } from '../cache/tool-cache';


/** Round to 1 decimal place. Returns null if value is null/undefined. */
function r1(v: number | null | undefined): number | null {
  if (v == null) return null;
  return Math.round(v * 10) / 10;
}

type CompetitorDataState = 'included_with_rows' | 'included_no_rows' | 'explicitly_excluded';

function getCompetitorDataState(
  includeCompetitors: boolean,
  rows: Array<{ competitors?: unknown[] }>
): CompetitorDataState {
  if (!includeCompetitors) return 'explicitly_excluded';
  return rows.some(r => Array.isArray(r.competitors) && r.competitors.length > 0)
    ? 'included_with_rows'
    : 'included_no_rows';
}

function getCollectorCompetitorDataState(
  includeCompetitors: boolean,
  rows: Array<{ competitor_details?: Record<string, unknown> }>
): CompetitorDataState {
  if (!includeCompetitors) return 'explicitly_excluded';
  return rows.some(r => r.competitor_details && Object.keys(r.competitor_details).length > 0)
    ? 'included_with_rows'
    : 'included_no_rows';
}

const COMPETITOR_OVERLAP_INTERNAL_LIMIT = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Zod Schemas
// ─────────────────────────────────────────────────────────────────────────────

const queryTypeSchema = z.object({
  queryType: z.enum(['blind', 'brand', 'all']).optional().describe(
    'Filter by query type. ' +
    '"blind" = neutral queries — queries with NO brand name in them. ' +
    '  SYNONYMS: blind query = neutral query = unprompted query = generic query. ' +
    '  These measure organic AI discoverability — is the brand mentioned when ' +
    '  no one asked about it? This is the most important visibility signal. ' +
    '"brand" = queries that explicitly name this brand (e.g. "What is Acme?"). ' +
    '"all" = no filter, return all query types combined (default).'
  ),
});

/** Schema for queries_summary — Tier 1 default tool */
export const queriesSummarySchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
  ...fieldsSchema.shape,
  ...queryTypeSchema.shape,
  limit: z.number().int().min(1).optional().describe(
    'Max queries to return. Omit to return all results. Use 5–10 for quick overview.'
  ),
  sortBy: z.enum(['visibility_score', 'share_of_answer_score', 'mentions', 'sentiment_score'])
    .optional()
    .describe(
      'Field to sort results by. Default "visibility_score". ' +
      'Use "visibility_score" asc to find worst-performing queries. ' +
      'Use "mentions" desc to find most-discussed queries.'
    ),
  sortOrder: z.enum(['asc', 'desc'])
    .optional()
    .describe(
      'Sort direction. Default "desc" (best first). ' +
      'Use "asc" to surface worst-performing, zero-visibility, or failing queries.'
    ),
  offset: z.number().int().min(0).optional().describe(
    'Pagination offset. Default 0. Use with limit to page through results. ' +
    'Example: offset 0 = first page, offset 100 = second page.'
  ),
  keywordSearch: z.string().optional().describe(
    'Filter queries whose query_text contains this keyword (case-insensitive). ' +
    'Use to find queries about a specific product, feature, or topic without paging through everything.'
  ),
  includeCompetitors: z.boolean().optional().describe(
    'Set true to include a breakdown of competitor visibility scores for every query. ' +
    'Default true when omitted. Set false only when you explicitly need a smaller brand-only payload.'
  ),
});

/** Schema for queries_competitor_overlap — Tier 2 competitive gap tool */
export const queriesCompetitorOverlapSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
  ...fieldsSchema.shape,
  ...queryTypeSchema.shape,
  competitorName: z.string().optional().describe(
    'Filter to a specific competitor name (must match exactly as it appears in the data). ' +
    'Omit to return overlap with ALL tracked competitors.'
  ),
  limit: z.number().int().min(1).max(30).optional().describe(
    'Max queries to return. Default 20. Results are sorted by largest competitive ' +
    'loss (most negative visibilityGap) first so the worst gaps appear at the top.'
  ),
});

/** Schema for queries_collector_breakdown — Tier 3 per-engine drill-down */
export const queriesCollectorBreakdownSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  queryText: z.string().min(1).describe(
    'The exact query text to drill into. Copy the value from queries_summary output. ' +
    'This tool requires a specific query — do not pass a topic name or a category.'
  ),
  includeCompetitors: z.boolean().optional().describe(
    'Set true to include competitor breakdown per collector for this query. ' +
    'Default false. Only use when the user explicitly asks for competitor engine-level data.'
  ),
  ...queryTypeSchema.shape,
});

/** Schema for topics_performance — unchanged from v1 */
export const topicsPerformanceSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
  ...fieldsSchema.shape,
  ...queryTypeSchema.shape,
  includeCompetitors: z.boolean().optional().describe(
    'Set true to include per-competitor visibility, SOA, and sentiment for each topic. ' +
    'Default true when omitted. Set false only when you explicitly need a smaller brand-only payload.'
  ),
});

/** Backward-compat schema alias — delegates to queriesSummarySchema */
export const queryPerformanceSchema = queriesSummarySchema;



export async function executeQueriesSummary(inputs: any, ctx: any, dbToken: string) {
  const { 
    brandId, startDate, endDate, 
    limit, queryType = 'all', 
    fields, collectors,
    sortBy = 'visibility_score',
    sortOrder = 'desc',
    offset = 0,
    keywordSearch
  } = inputs;
  const includeCompetitors = inputs.includeCompetitors ?? true;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const summaries = await queryAggregationService.getQueriesSummary({
    brandId,
    customerId: ctx.customerId,
    startDate,
    endDate,
    collectors,
    queryType,
    limit,
    includeCompetitors,
    sortBy,
    sortOrder,
    offset,
    keywordSearch
  });

  const slimmed = summaries.map(s => ({
    query_text: s.query_text,
    query_type: s.query_type,
    visibility_score: r1(s.visibility_score),
    share_of_answer_score: r1(s.share_of_answer_score),
    brand_sentiment_score: r1(s.sentiment_score),
    brand_sentiment_label: s.sentiment_label,
    total_brand_mentions: s.mentions,
    brand_presence_pct: r1(s.brand_presence_pct),
    topic_name: s.topic,
    ...(includeCompetitors ? {
      competitors: s.competitors?.map(c => ({
        ...c,
        visibility_score: r1(c.visibility_score),
        soa_score: r1(c.soa_score),
      })) ?? []
    } : {}),
  }));

  const competitorDataState = getCompetitorDataState(includeCompetitors, slimmed);

  const sorted = slimmed; // Service already performs sort and limit

  const queryTypeLabel = queryType === 'blind'
    ? 'blind (neutral/unprompted) queries'
    : queryType === 'all' ? 'all query types' : `${queryType} queries`;

  const result = sorted.length === 0 ? {
    queries: annotateEmptyArray(queryTypeLabel, `brand ${brandId} in this date range`),
    _meta: {
      brand_id: brandId,
      query_type_filter: queryType,
      sort_by: sortBy,
      sort_order: sortOrder,
      offset,
      limit_applied: limit,
      keyword_filter: keywordSearch ?? null,
      query_type_note: 'blind = neutral = unprompted (no brand name in query). brand = explicit brand mention.',
      date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      include_competitors_effective: includeCompetitors,
      competitor_data_state: competitorDataState,
      empty_reason: `No ${queryTypeLabel} found for this brand in the selected date range. This means no data was collected — not that performance was zero.`,
    },
  } : {
    queries: sorted,
    total_returned: sorted.length,
    _meta: {
      brand_id: brandId,
      query_type_filter: queryType,
      sort_by: sortBy,
      sort_order: sortOrder,
      offset,
      limit_applied: limit,
      keyword_filter: keywordSearch ?? null,
      query_type_note: 'blind = neutral = unprompted (no brand name in query). brand = explicit brand mention.',
      date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      include_competitors_effective: includeCompetitors,
      competitor_data_state: competitorDataState,
      data_source: 'EvidentlyAEO prompt analytics — real tracked queries only. Do not extrapolate or estimate unlisted queries.',
      field_guide: {
        visibility_score: '0–100. Higher = brand appears more often in AI answers for this query.',
        share_of_answer_score: '0–100. Higher = brand occupies more of the answer content.',
        brand_sentiment_score: '0–100. Average sentiment of brand mentions for this query.',
        brand_sentiment_label: 'positive | neutral | negative based on score.',
        brand_presence_pct: '0–100. % of AI engines that mentioned the brand for this query.',
        null_values: 'null means no data was collected for this metric in the selected period. Do NOT report null as 0 or as a score.',
      },
    },
  };

  return projectFields(result as any, fields);
}



export async function executeQueriesCompetitorOverlap(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, limit = 20, queryType = 'all', competitorName, fields, collectors } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const summaries = await queryAggregationService.getQueriesSummary({
    brandId,
    customerId: ctx.customerId,
    startDate,
    endDate,
    collectors,
    queryType,
    limit: COMPETITOR_OVERLAP_INTERNAL_LIMIT
  });

  const overlapRows: any[] = [];

  for (const s of summaries) {
    if (!s.competitors || s.competitors.length === 0) continue;

    // Filter to specific competitor if requested
    const targetCompetitors = competitorName 
      ? s.competitors.filter(c => c.name.toLowerCase().trim() === competitorName.toLowerCase().trim())
      : s.competitors;

    if (targetCompetitors.length === 0) continue;

    // Find the leading competitor on this query
    const leadingCompetitor = targetCompetitors.reduce((prev, current) => 
      (prev.visibility_score > current.visibility_score) ? prev : current
    );

    const gap = s.visibility_score - leadingCompetitor.visibility_score;

    // Keep if the competitor is winning (gap < 0) or if we just want overlap
    if (gap < 0) {
      overlapRows.push({
        query_text: s.query_text,
        query_type: s.query_type,
        brand_visibility_score: r1(s.visibility_score),
        leading_competitor: {
          name: leadingCompetitor.name,
          visibility_score: r1(leadingCompetitor.visibility_score)
        },
        visibility_gap: r1(gap),
        all_competitors: targetCompetitors.map(c => ({
          name: c.name,
          visibility_score: r1(c.visibility_score),
          soa_score: r1(c.soa_score),
          mentions: c.mentions
        }))
      });
    }
  }

  // Sort by worst gap first (most negative)
  overlapRows.sort((a, b) => a.visibility_gap - b.visibility_gap);

  const sliced = overlapRows.slice(0, limit);

  const uniqueCompetitorsCount = new Set(
    summaries.flatMap(s => (s.competitors || []).map(c => c.name))
  ).size;

  const result = sliced.length === 0 ? {
    competitor_overlap: annotateEmptyArray(
      'competitor overlap queries',
      `brand ${brandId}${competitorName ? ` vs ${competitorName}` : ''} in this date range`
    ),
    _meta: { brand_id: brandId },
  } : {
    competitor_overlap: sliced,
    total_returned: sliced.length,
    _meta: {
      brand_id: brandId,
      competitors_available: uniqueCompetitorsCount,
      competitor_filter: competitorName ?? 'all tracked competitors',
      date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      data_source: 'EvidentlyAEO prompt analytics — only queries with tracked competitor data.',
      field_guide: {
        visibility_gap: 'our_visibility_score − competitor_visibility_score. Negative = competitor leads us on this query. Positive = we lead. Results sorted by worst gap first.',
        null_values: 'null means no data for that metric. Do NOT report null as 0.',
      },
    },
  };

  return projectFields(result as any, fields);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 3 — queries_collector_breakdown  (Tier 3 — per-engine drill-down)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns per-AI-engine (collector) performance for ONE specific query.
 * Shows how the brand performs on ChatGPT vs Perplexity vs Gemini etc.
 * for the exact queryText provided.
 *
 * includeCompetitors: false (default) — brand-only data per collector.
 * includeCompetitors: true — adds competitorVisibilityMap per collector row,
 *   but only if the user explicitly asked about competitor engine performance.
 *
 * Requires queryText to be set — forces Claude to be explicit about which
 * query it is drilling into. Prevents the model from calling this tool
 * on a vague intent and receiving a large multi-query payload.
 */
export async function executeQueriesCollectorBreakdown(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, queryText, includeCompetitors = false } = inputs;
  const detail = await queryAggregationService.getQueryDetail(
    brandId,
    ctx.customerId,
    queryText,
    startDate,
    endDate,
    { includeCompetitors }
  );

  if (!detail) {
    const competitorDataState = getCollectorCompetitorDataState(includeCompetitors, []);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          collector_breakdown: null,
          _meta: {
            brand_id: brandId,
            query_text: queryText,
            found: false,
            include_competitors_effective: includeCompetitors,
            competitor_data_state: competitorDataState,
            message: `No data found for query "${queryText}". Use queries_summary to see available options.`,
          },
        }),
      }],
    };
  }

  const breakdown = detail.per_collector.map((c: any) => {
    const row: any = {
      collector: c.collector_type,
      brand_mentions: c.brand_mentions,
      avg_position: r1(c.brand_positions && c.brand_positions.length > 0 ? c.brand_positions[0] : null),
      soa_score: r1(c.soa_score),
      sentiment_score: r1(c.sentiment_score),
      sentiment_label: c.sentiment_label,
    };
    if (c.competitor_details && Object.keys(c.competitor_details).length > 0) {
      row.competitor_details = Object.fromEntries(
        Object.entries(c.competitor_details as Record<string, any>)
          .map(([k, v]) => [k, {
            ...v,
            visibility_score: r1(v.visibility_score),
            soa_score: r1(v.soa_score),
            sentiment_score: r1(v.sentiment_score),
          }])
      );
    }
    return row;
  });

  const competitorDataState = getCollectorCompetitorDataState(includeCompetitors, breakdown);

  const result = {
    query_text: detail.query_text,
    topic_name: detail.topic,
    overall_visibility: r1(detail.overall.visibility_score),
    overall_soa: r1(detail.overall.soa_score),
    collector_breakdown: breakdown,
    _meta: {
      brand_id: brandId,
      date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      collectors_returned: breakdown.length,
      include_competitors_effective: includeCompetitors,
      competitor_data_state: competitorDataState,
      data_source: 'EvidentlyAEO prompt analytics — optimized drill-down layer.',
    },
  };

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 4 — topics_performance  (unchanged from v1, co-located for clarity)
// ─────────────────────────────────────────────────────────────────────────────

export async function executeTopicsPerformance(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, fields, collectors, queryType = 'all' } = inputs;
  const includeCompetitors = inputs.includeCompetitors ?? true;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const topicSummaries = await queryAggregationService.getTopicsSummary({
    brandId,
    customerId: ctx.customerId,
    startDate,
    endDate,
    collectors,
    queryType,
    includeCompetitors
  });

  const topics = topicSummaries.map(t => ({
    topic_name: t.topic,
    prompt_count: t.query_count,
    visibility_score_0_to_100: r1(t.visibility_score),
    sentiment_score_0_to_100: r1(t.sentiment_score),
    total_brand_mentions: t.mentions,
    share_of_answer_score: r1(t.share_of_answer_score),
    brand_presence_pct: r1(t.brand_presence_pct),
    ...(includeCompetitors ? {
      competitors: (t.competitors ?? []).map(c => ({
        name: c.name,
        visibility_score: r1(c.visibility_score),
        soa_score: r1(c.soa_score),
        sentiment_score: r1(c.sentiment_score),
      }))
    } : {})
  }));

  const competitorDataState = getCompetitorDataState(includeCompetitors, topics);

  const result = topics.length === 0 ? {
    topics: annotateEmptyArray('topics', `brand ${brandId} in this date range`),
    _meta: {
      brand_id: brandId,
      date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      include_competitors_effective: includeCompetitors,
      competitor_data_state: competitorDataState,
      empty_reason: 'No topics found for this brand in the selected date range.',
    },
  } : {
    topics,
    total_topics: topics.length,
    _meta: {
      brand_id: brandId,
      date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      include_competitors_effective: includeCompetitors,
      competitor_data_state: competitorDataState,
      data_source: 'EvidentlyAEO topic analytics — real tracked data only',
      field_guide: {
        visibility_score_0_to_100: '0–100. % of prompts in this topic where brand appeared in AI responses.',
        share_of_answer_score: '0–100. Competitive share of AI answer content for this topic.',
        sentiment_score_0_to_100: '0–100. Avg sentiment of brand mentions in this topic. 50=neutral, >70=positive, <40=negative.',
        brand_presence_pct: '0–100. % of AI responses in this topic that mentioned the brand at least once.',
        prompt_count: 'Total number of tracked queries grouped under this topic.',
        null_values: 'null = no data collected in this period. NEVER report null as 0 or as a score.',
      },
    },
  };

  return projectFields(result as any, fields);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 5 — queries_trend
// ─────────────────────────────────────────────────────────────────────────────

/** Schema for queries_trend */
export const queriesTrendSchema = z.object({
  ...brandIdSchema.shape,
  ...collectorsSchema.shape,
  granularity: z.enum(['week', 'month']).optional().describe(
    'Time period granularity. Default "week" (7-day periods).'
  ),
  periods: z.number().int().min(2).max(8).optional().describe(
    'Number of periods to compare. Default 4. Minimum 2.'
  ),
  includeMovers: z.boolean().optional().describe(
    'Set true to include the top 3 queries that improved most and top 3 that declined most this period. Default false.'
  ),
  ...queryTypeSchema.shape,
});

/**
 * Returns historical trends for query visibility and mentions.
 * Pre-computes deltas so Claude doesn't have to.
 */
export async function executeQueriesTrend(inputs: any, ctx: any, dbToken: string) {
  const { brandId, collectors, granularity = 'week', periods = 4, includeMovers = false, queryType = 'all' } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  try {
    const bucketed = await queryAggregationService.getQueriesTrendBucketed({
      brandId,
      customerId: ctx.customerId,
      collectors,
      queryType,
      granularity,
      periods,
      includeMovers
    });

    const periodResults = bucketed.periods;

    const finalPeriods = periodResults.map((p: any, idx: number) => {
      const prev = periodResults[idx + 1];
      let delta_visibility = null;
      let delta_mentions = null;

      if (prev) {
        if (prev.avg_visibility_score != null) {
          if (prev.avg_visibility_score === 0) {
            delta_visibility = p.avg_visibility_score > 0 ? 100 : 0;
          } else {
            delta_visibility = r1(((p.avg_visibility_score - prev.avg_visibility_score) / prev.avg_visibility_score) * 100);
          }
        }
        if (prev.total_brand_mentions != null) {
          if (prev.total_brand_mentions === 0) {
            delta_mentions = p.total_brand_mentions > 0 ? 100 : 0;
          } else {
            delta_mentions = r1(((p.total_brand_mentions - prev.total_brand_mentions) / prev.total_brand_mentions) * 100);
          }
        }
      }

      const { top_queries, ...cleanPeriod } = p;
      return {
        ...cleanPeriod,
        delta_visibility,
        delta_mentions
      };
    });

    let movers = null;
    if (includeMovers && periodResults.length >= 2) {
      const current = periodResults[0];
      const previous = periodResults[1];

      const currentMap = new Map<string, any>((current.top_queries || []).map((q: any) => [(q.query_text || '').toLowerCase().trim(), q]));
      const prevMap = new Map<string, any>((previous.top_queries || []).map((q: any) => [(q.query_text || '').toLowerCase().trim(), q]));

      const changes: any[] = [];
      for (const [text, p] of Array.from(currentMap.entries())) {
        const prevP = prevMap.get(text);
        if (prevP) {
          const delta = (p.visibility_score ?? 0) - (prevP.visibility_score ?? 0);
          changes.push({
            query_text: p.query_text,
            visibility_current: r1(p.visibility_score),
            visibility_previous: r1(prevP.visibility_score),
            delta: r1(delta)
          });
        }
      }

      changes.sort((a, b) => b.delta - a.delta);
      movers = {
        top_gainers: changes.slice(0, 3).filter(c => c.delta > 0),
        top_losers: [...changes].sort((a, b) => a.delta - b.delta).slice(0, 3).filter(c => c.delta < 0)
      };
    }

    return {
      periods: finalPeriods,
      movers,
      _meta: {
        brand_id: brandId,
        granularity,
        data_source: 'EvidentlyAEO prompt analytics trend comparison'
      }
    };
  } catch (error: any) {
    throw new McpSystemError('Failed to compute query trends', error.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Backward-Compatible Alias (deprecated — remove after server.ts is updated)
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use executeQueriesSummary */
export async function executeQueryPerformance(inputs: any, ctx: any, dbToken: string) {
  return executeQueriesSummary(inputs, ctx, dbToken);
}

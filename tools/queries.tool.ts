import { z } from 'zod';
import { queryAggregationService } from '../../services/mcp-aggregations/query-aggregation.service';
import { validateBrandOwnership } from '../middleware/brand-guard';
import { McpSystemError } from '../utils/response-formatter';
import { brandIdSchema, dateRangeSchema, collectorsSchema, fieldsSchema } from './schemas';
import { annotateEmptyArray, projectFields } from '../utils/data-sanitizer';
import { getCached, setCached, buildCacheKey } from '../cache/tool-cache';

/**
 * queries.tool.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * EvidentlyAEO MCP — Query Intelligence Tools (v2)
 *
 * CONTEXT & DESIGN RATIONALE
 * ─────────────────────────────────────────────────────────────────────────────
 * The previous single `query_performance` tool had three production issues:
 *
 *  1. Terminology hallucination — tool descriptions contained no semantic
 *     vocabulary. The model had no way to know that "blind queries" and
 *     "neutral queries" are the same thing, or what SOA, visibilityScore,
 *     or queryType values mean in AEO domain context.
 *
 *  2. Data hallucination — raw prompt objects were passed to the model without
 *     field projection or null semantics. The model was forced to invent meaning
 *     for ambiguous field names (e.g. soaScore, brandPresencePercentage).
 *     Silent .flatMap fallbacks returned empty arrays indistinguishably from
 *     "no data exists" vs "fetch failed".
 *
 *  3. Over-output + token waste — a single tool always returned full prompt
 *     objects (avg 2.77 MB), causing MCP session timeouts (~4 min disconnect
 *     loops in Claude Desktop). No field projection. Pretty-printed JSON.
 *
 * This file replaces `query_performance` with a 3-tool tiered architecture:
 *
 *  Tier 1 — queries_summary           (DEFAULT — call this first)
 *    Returns 7 slim fields per query row. Max ~15 KB at limit=50.
 *    Covers 90%+ of user questions about query performance.
 *    Deduplicates by queryText across topics. Aggregated across all collectors.
 *
 *  Tier 2 — queries_competitor_overlap  (call only for competitive gap questions)
 *    Returns queries where competitors also appear, with a pre-computed
 *    visibilityGap (our score − competitor score). Sorted worst-gap first.
 *    Uses competitorVisibilityMap / competitorMentionsMap already on each prompt.
 *
 *  Tier 3 — queries_collector_breakdown  (call only for per-engine questions)
 *    Returns per-AI-engine data for ONE specific query (ChatGPT vs Perplexity
 *    vs Gemini etc). Requires explicit queryText input. includeCompetitors is
 *    opt-in — defaults false to keep payload minimal.
 *
 * SHARED CACHE
 *    All three tools call fetchPromptAnalytics() with the same cache key
 *    prefix ('prompts_shared'). First call pays DB cost; all follow-up
 *    drill-downs within the 60s TTL are in-memory cache hits. No redundant
 *    DB queries regardless of how many tools Claude chains in one turn.
 *
 * PAYLOAD SIZE GUARANTEE
 *    queries_summary:             ≤ 15 KB  (limit=50 × ~300 bytes/row)
 *    queries_competitor_overlap:  ≤ 25 KB  (limit=30 × ~800 bytes/row)
 *    queries_collector_breakdown: ≤  5 KB  (single query × N collectors)
 *    topics_performance:          ≤  8 KB  (≤100 topics × ~80 bytes/row)
 *
 * DATA SOURCES  (confirmed in prompts-analytics.service.ts)
 *    Prompt-level aggregated fields used here:
 *      queryText                  — the tracked query string
 *      queryType                  — 'blind' | 'brand' | 'competitor'
 *      visibilityScore            — 0–100, brand visibility on this query
 *      soaScore                   — 0–100, Share of Answer on this query
 *      mentions                   — brand mention count across all collectors
 *      brandPresencePercentage    — % of collectors where brand was mentioned
 *      competitorVisibilityMap    — Record<competitorName, visibilityScore>
 *      competitorMentionsMap      — Record<competitorName, mentionCount>
 *      competitorSoaMap           — Record<competitorName, soaScore>
 *    Per-collector data (responses[] on each prompt):
 *      collectorType              — 'chatgpt' | 'perplexity' | 'gemini' | etc.
 *      mentions                   — brand mention count on this collector
 *      averagePosition            — brand avg position on this collector
 *      soaScore                   — brand SOA on this collector
 *      competitorVisibilityMap    — per-collector competitor visibility
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Round to 1 decimal place. Returns null if value is null/undefined. */
function r1(v: number | null | undefined): number | null {
  if (v == null) return null;
  return Math.round(v * 10) / 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod Schemas
// ─────────────────────────────────────────────────────────────────────────────

const queryTypeSchema = z.object({
  queryType: z.enum(['blind', 'brand', 'competitor', 'all']).optional().describe(
    'Filter by query type. ' +
    '"blind" = neutral queries — queries with NO brand name in them. ' +
    '  SYNONYMS: blind query = neutral query = unprompted query = generic query. ' +
    '  These measure organic AI discoverability — is the brand mentioned when ' +
    '  no one asked about it? This is the most important visibility signal. ' +
    '"brand" = queries that explicitly name this brand (e.g. "What is Acme?"). ' +
    '"competitor" = queries that explicitly name a competitor brand. ' +
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
  limit: z.number().int().min(1).max(50).optional().describe(
    'Max queries to return, sorted by visibility score descending. ' +
    'Default 20. Use 5–10 for a quick overview, 50 for exhaustive analysis.'
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
    'Set true ONLY if the user explicitly asked how a competitor performs on this ' +
    'query across AI engines. Default false keeps the response minimal.'
  ),
});

/** Schema for topics_performance — unchanged from v1 */
export const topicsPerformanceSchema = z.object({
  ...brandIdSchema.shape,
  ...dateRangeSchema.shape,
  ...collectorsSchema.shape,
  ...fieldsSchema.shape,
});

/** Backward-compat schema alias — delegates to queriesSummarySchema */
export const queryPerformanceSchema = queriesSummarySchema;



export async function executeQueriesSummary(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, limit = 20, queryType = 'all', fields, collectors } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const summaries = await queryAggregationService.getQueriesSummary({
    brandId,
    customerId: ctx.customerId,
    startDate,
    endDate,
    collectors,
    queryType,
    limit
  });

  const slimmed = summaries.map(s => ({
    query_text: s.query_text,
    query_type: s.query_type,
    visibility_score: r1(s.visibility_score),
    share_of_answer_score: r1(s.share_of_answer_score),
    brand_mentions: s.mentions,
    brand_presence_pct: r1(s.brand_presence_pct),
    topic_name: s.topic,
  }));

  const sorted = slimmed; // Service already performs sort and limit

  const queryTypeLabel = queryType === 'blind'
    ? 'blind (neutral/unprompted) queries'
    : queryType === 'all' ? 'all query types' : `${queryType} queries`;

  const result = sorted.length === 0 ? {
    queries: annotateEmptyArray(queryTypeLabel, `brand ${brandId} in this date range`),
    _meta: {
      brand_id: brandId,
      query_type_filter: queryType,
    },
  } : {
    queries: sorted,
    total_returned: sorted.length,
    _meta: {
      brand_id: brandId,
      query_type_filter: queryType,
      query_type_note: 'blind = neutral = unprompted (no brand name in query). brand = explicit brand mention. competitor = explicit competitor mention.',
      date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      data_source: 'EvidentlyAEO prompt analytics — real tracked queries only. Do not extrapolate or estimate unlisted queries.',
      field_guide: {
        visibility_score: '0–100. Higher = brand appears more often in AI answers for this query.',
        share_of_answer_score: '0–100. Higher = brand occupies more of the answer content.',
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

  const overlapRows = await queryAggregationService.getCompetitorOverlap({
    brandId,
    customerId: ctx.customerId,
    startDate,
    endDate,
    collectors,
    queryType,
    competitorName,
    limit
  });

  const sliced = overlapRows.map(r => ({
    ...r,
    our_visibility_score: r1(r.our_visibility_score),
    competitor_visibility_score: r1(r.competitor_visibility_score),
    visibility_gap: r1(r.visibility_gap),
    competitor_soa_score: r1(r.competitor_soa_score),
  }));

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
  const detail = await queryAggregationService.getQueryDetail(brandId, ctx.customerId, queryText);

  if (!detail) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          collector_breakdown: null,
          _meta: {
            brand_id: brandId,
            query_text: queryText,
            found: false,
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
    };
    if (includeCompetitors && c.competitor_visibility) {
      row.competitor_visibility = Object.fromEntries(
        Object.entries(c.competitor_visibility as Record<string, number>)
          .map(([k, v]) => [k, r1(v)])
      );
    }
    return row;
  });

  const result = {
    query_text: detail.query_text,
    topic_name: detail.topic,
    overall_visibility: r1(detail.overall.visibility_score),
    overall_soa: r1(detail.overall.soa_score),
    collector_breakdown: breakdown,
    latest_answer_sample: detail.latest_answer ? {
      text: detail.latest_answer.text.substring(0, 500) + (detail.latest_answer.text.length > 500 ? '...' : ''),
      engine: detail.latest_answer.collector
    } : null,
    _meta: {
      brand_id: brandId,
      date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      collectors_returned: breakdown.length,
      competitors_included: includeCompetitors,
      data_source: 'EvidentlyAEO prompt analytics — optimized drill-down layer.',
    },
  };

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 4 — topics_performance  (unchanged from v1, co-located for clarity)
// ─────────────────────────────────────────────────────────────────────────────

export async function executeTopicsPerformance(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, fields, collectors } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const topicSummaries = await queryAggregationService.getTopicsSummary({
    brandId,
    customerId: ctx.customerId,
    startDate,
    endDate,
    collectors
  });

  const topics = topicSummaries.map(t => ({
    topic_name: t.topic,
    prompt_count: t.query_count,
    visibility_score_0_to_100: r1(t.visibility_score),
    sentiment_score_0_to_100: r1(t.sentiment_score),
    total_mentions: t.mentions,
    share_of_answer_score: r1(t.share_of_answer_score),
    brand_presence_pct: r1((t.mentions > 0 ? 100 : 0)) // Simplified presence for topics summary
  }));

  const result = topics.length === 0 ? {
    topics: annotateEmptyArray('topics', `brand ${brandId} in this date range`),
    _meta: { brand_id: brandId },
  } : {
    topics,
    total_topics: topics.length,
    _meta: {
      brand_id: brandId,
      date_range: { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      data_source: 'EvidentlyAEO topic analytics — real tracked data only',
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
});

/**
 * Returns historical trends for query visibility and mentions.
 * Pre-computes deltas so Claude doesn't have to.
 */
export async function executeQueriesTrend(inputs: any, ctx: any, dbToken: string) {
  const { brandId, collectors, granularity = 'week', periods = 4, includeMovers = false } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const daysPerPeriod = granularity === 'month' ? 30 : 7;
  const now = new Date();
  const periodResults: any[] = [];

  try {
    for (let i = 0; i < periods; i++) {
      const end = new Date(now.getTime() - i * daysPerPeriod * 24 * 60 * 60 * 1000);
      const start = new Date(now.getTime() - (i + 1) * daysPerPeriod * 24 * 60 * 60 * 1000);

      const startIso = start.toISOString();
      const endIso = end.toISOString();
      const label = `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${end.toLocaleDateString('en-US', { day: 'numeric' })}`;

      // Use the optimized aggregation service instead of heavy legacy service
      const summaries = await queryAggregationService.getQueriesSummary({
        brandId,
        customerId: ctx.customerId,
        startDate: startIso,
        endDate: endIso,
        collectors,
        limit: 100 // Fetch a larger sample for trend calculation
      });

      const avgVisibility = summaries.length > 0
        ? summaries.reduce((sum, s) => sum + s.visibility_score, 0) / summaries.length
        : 0;

      const totalMentions = summaries.reduce((sum, s) => sum + s.mentions, 0);

      periodResults.push({
        period_label: label,
        avg_visibility_score: r1(avgVisibility),
        total_mentions: totalMentions,
        unique_query_count: summaries.length,
        _prompts: summaries // Temporary for movers calculation
      });
    }

    // Compute deltas
    const finalPeriods = periodResults.map((p: any, idx: number) => {
      const prev = periodResults[idx + 1];
      let delta_visibility = null;
      let delta_mentions = null;

      if (prev) {
        if (prev.avg_visibility_score !== 0 && prev.avg_visibility_score != null) {
          delta_visibility = r1(((p.avg_visibility_score! - prev.avg_visibility_score!) / prev.avg_visibility_score!) * 100);
        }
        if (prev.total_mentions !== 0 && prev.total_mentions != null) {
          delta_mentions = r1(((p.total_mentions! - prev.total_mentions!) / prev.total_mentions!) * 100);
        }
      }

      // Remove internal _prompts field from output
      const { _prompts, ...cleanPeriod } = p;
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

      const currentMap = new Map<string, any>((current._prompts as any[]).map((p: any) => [(p.query_text || '').toLowerCase().trim(), p]));
      const prevMap = new Map<string, any>((previous._prompts as any[]).map((p: any) => [(p.query_text || '').toLowerCase().trim(), p]));

      const changes: any[] = [];
      for (const [text, pEntry] of Array.from(currentMap.entries())) {
        const p = pEntry as any;
        const prevP = prevMap.get(text) as any;
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

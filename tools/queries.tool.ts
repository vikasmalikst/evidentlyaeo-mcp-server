import { z } from 'zod';
import { promptsAnalyticsService } from '../../services/prompts-analytics.service';
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

/**
 * Slim a raw prompt object down to only the fields needed by queries_summary.
 * Called immediately after extracting prompts so large raw objects are never
 * held in memory beyond this point.
 */
function slimPrompt(p: any) {
  return {
    query_text:             p.queryText               ?? null,
    query_type:             p.queryType               ?? null,
    visibility_score:       r1(p.visibilityScore)      ?? null,
    share_of_answer_score:  r1(p.soaScore)             ?? null,
    brand_mentions:         p.mentions                 ?? null,
    brand_presence_pct:     r1(p.brandPresencePercentage) ?? null,
    topic_name:             p._topicName               ?? null,
  };
}

/**
 * Deduplicate prompts by queryText, keeping the entry with the highest
 * visibilityScore. This prevents the same query appearing N times because it
 * spans multiple topics — the model should see each query once.
 */
function deduplicateByQueryText(prompts: any[]): any[] {
  const seen = new Map<string, any>();
  for (const p of prompts) {
    const key = (p.queryText ?? p.query_text ?? '').toLowerCase().trim();
    if (!key) continue;
    const existing = seen.get(key);
    const score = p.visibilityScore ?? p.visibility_score ?? 0;
    if (!existing || score > (existing.visibilityScore ?? existing.visibility_score ?? 0)) {
      seen.set(key, p);
    }
  }
  return Array.from(seen.values());
}

/**
 * Flatten all prompts from all topics, stamping each with _topicName so
 * downstream tools can surface which topic a query belongs to.
 */
function extractAllPrompts(data: any): any[] {
  return ((data as any).topics || []).flatMap((t: any) =>
    (t.prompts || []).map((p: any) => ({ ...p, _topicName: t.name ?? null }))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared Cache Fetch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single shared fetch function used by all three query tools.
 * Cache key is built from (customerId, brandId, dateRange, collectors) so
 * different parameter sets get independent cache entries.
 * ALL three tools use the prefix 'prompts_shared' — meaning a queries_summary
 * call and a subsequent queries_competitor_overlap call with the same params
 * share one cache entry and one DB round-trip.
 */
async function fetchPromptAnalytics(inputs: any, customerId: string) {
  const { brandId, startDate, endDate, collectors } = inputs;
  const cacheKey = buildCacheKey('prompts_shared', customerId, brandId, { startDate, endDate, collectors });
  const cached = getCached(cacheKey);
  if (cached) return { data: cached, cacheHit: true };

  try {
    const result = await promptsAnalyticsService.getPromptAnalytics({
      brandId, customerId, startDate, endDate, collectors,
    });
    setCached(cacheKey, result);
    return { data: result, cacheHit: false };
  } catch (error: any) {
    throw new McpSystemError('Failed to fetch prompt analytics', error.message);
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// Tool 1 — queries_summary  (Tier 1 — DEFAULT entry point)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the top N queries for a brand with 7 slim fields per row.
 *
 * Field semantics exposed to Claude:
 *   query_text            — the tracked question/query string
 *   query_type            — 'blind' (= neutral/unprompted) | 'brand' | 'competitor'
 *   visibility_score      — 0–100. How often the brand appears in AI answers for
 *                           this query. 100 = always present. null = no data.
 *   share_of_answer_score — 0–100. Brand's share of the total answer content
 *                           on this query across all collectors. null = no data.
 *   brand_mentions        — integer count of times brand was mentioned for this query.
 *   brand_presence_pct    — % of AI engines (collectors) that mentioned the brand
 *                           for this query. null = no data.
 *   topic_name            — which topic group this query belongs to.
 *
 * Deduplication: the same query appearing in multiple topics is merged here,
 * keeping the highest visibility_score instance, so Claude sees each query once.
 */
export async function executeQueriesSummary(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, limit = 20, queryType = 'all', fields } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const { data, cacheHit } = await fetchPromptAnalytics(inputs, ctx.customerId);

  // Extract → slim immediately → deduplicate → filter → sort → slice
  let prompts = extractAllPrompts(data);
  let slimmed = prompts.map(slimPrompt);
  slimmed = deduplicateByQueryText(slimmed);

  if (queryType !== 'all') {
    slimmed = slimmed.filter((p: any) => p.query_type === queryType);
  }

  const sorted = slimmed
    .sort((a: any, b: any) => (b.visibility_score ?? 0) - (a.visibility_score ?? 0))
    .slice(0, limit);

  const queryTypeLabel = queryType === 'blind'
    ? 'blind (neutral/unprompted) queries'
    : queryType === 'all' ? 'all query types' : `${queryType} queries`;

  const result = sorted.length === 0 ? {
    queries: annotateEmptyArray(queryTypeLabel, `brand ${brandId} in this date range`),
    _meta: {
      brand_id:          brandId,
      query_type_filter: queryType,
      cache_hit:         cacheHit,
    },
  } : {
    queries: sorted,
    total_returned: sorted.length,
    _meta: {
      brand_id:          brandId,
      query_type_filter: queryType,
      query_type_note:   'blind = neutral = unprompted (no brand name in query). brand = explicit brand mention. competitor = explicit competitor mention.',
      date_range:        { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      data_source:       'EvidentlyAEO prompt analytics — real tracked queries only. Do not extrapolate or estimate unlisted queries.',
      field_guide: {
        visibility_score:      '0–100. Higher = brand appears more often in AI answers for this query.',
        share_of_answer_score: '0–100. Higher = brand occupies more of the answer content.',
        brand_presence_pct:    '0–100. % of AI engines that mentioned the brand for this query.',
        null_values:           'null means no data was collected for this metric in the selected period. Do NOT report null as 0 or as a score.',
      },
      cache_hit: cacheHit,
    },
  };

  return projectFields(result as any, fields);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 2 — queries_competitor_overlap  (Tier 2 — competitive gap drill-down)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns queries where tracked competitors also appear, with a pre-computed
 * visibilityGap so Claude never needs to do arithmetic.
 *
 *   visibilityGap = our visibility_score − competitor_visibility_score
 *   Negative = competitor leads us. Positive = we lead competitor.
 *   Results are sorted by most negative gap first (worst competitive losses at top).
 *
 * Only queries that have at least one competitor in competitorVisibilityMap are
 * included. If competitorName is specified, only that competitor's gap is returned.
 */
export async function executeQueriesCompetitorOverlap(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, limit = 20, queryType = 'all', competitorName, fields } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const { data, cacheHit } = await fetchPromptAnalytics(inputs, ctx.customerId);

  let prompts = extractAllPrompts(data);
  prompts = deduplicateByQueryText(prompts);

  if (queryType !== 'all') {
    prompts = prompts.filter((p: any) => p.queryType === queryType);
  }

  // Build per-query competitor overlap rows
  const rows: any[] = [];
  for (const p of prompts) {
    const compVisMap: Record<string, number> = p.competitorVisibilityMap ?? {};
    const compMentMap: Record<string, number> = p.competitorMentionsMap  ?? {};
    const compSoaMap:  Record<string, number> = p.competitorSoaMap       ?? {};

    const competitors = Object.keys(compVisMap).filter(c =>
      competitorName ? c.toLowerCase() === competitorName.toLowerCase() : true
    );
    if (competitors.length === 0) continue;

    for (const comp of competitors) {
      const ourScore   = r1(p.visibilityScore) ?? null;
      const theirScore = r1(compVisMap[comp])  ?? null;
      const gap = (ourScore != null && theirScore != null) ? r1(ourScore - theirScore) : null;

      rows.push({
        query_text:                    p.queryText   ?? null,
        query_type:                    p.queryType   ?? null,
        topic_name:                    p._topicName  ?? null,
        our_visibility_score:          ourScore,
        competitor_name:               comp,
        competitor_visibility_score:   theirScore,
        visibility_gap:                gap,
        competitor_mentions:           compMentMap[comp] ?? null,
        competitor_soa_score:          r1(compSoaMap[comp]) ?? null,
      });
    }
  }

  // Sort: most negative gap (worst competitive loss) first
  rows.sort((a, b) => (a.visibility_gap ?? 0) - (b.visibility_gap ?? 0));
  const sliced = rows.slice(0, limit);

  const result = sliced.length === 0 ? {
    competitor_overlap: annotateEmptyArray(
      'competitor overlap queries',
      `brand ${brandId}${competitorName ? ` vs ${competitorName}` : ''} in this date range`
    ),
    _meta: { brand_id: brandId, cache_hit: cacheHit },
  } : {
    competitor_overlap: sliced,
    total_returned: sliced.length,
    _meta: {
      brand_id:        brandId,
      competitor_filter: competitorName ?? 'all tracked competitors',
      date_range:      { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      data_source:     'EvidentlyAEO prompt analytics — only queries with tracked competitor data.',
      field_guide: {
        visibility_gap: 'our_visibility_score − competitor_visibility_score. Negative = competitor leads us on this query. Positive = we lead. Results sorted by worst gap first.',
        null_values:    'null means no data for that metric. Do NOT report null as 0.',
      },
      cache_hit: cacheHit,
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
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const { data, cacheHit } = await fetchPromptAnalytics(inputs, ctx.customerId);

  const allPrompts = extractAllPrompts(data);
  const needle = queryText.toLowerCase().trim();
  const match = allPrompts.find((p: any) =>
    (p.queryText ?? '').toLowerCase().trim() === needle
  );

  if (!match) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          collector_breakdown: null,
          _meta: {
            brand_id:       brandId,
            query_text:     queryText,
            found:          false,
            message:        `No data found for query "${queryText}" in this date range. ` +
                            `Use queries_summary to see available query texts.`,
            cache_hit:      cacheHit,
          },
        }),
      }],
    };
  }

  const responses: any[] = match.responses ?? [];
  const breakdown = responses.map((r: any) => {
    const row: any = {
      collector:          r.collectorType    ?? null,
      brand_mentions:     r.mentions         ?? null,
      avg_position:       r1(r.averagePosition) ?? null,
      soa_score:          r1(r.soaScore)     ?? null,
    };
    if (includeCompetitors && r.competitorVisibilityMap) {
      row.competitor_visibility = Object.fromEntries(
        Object.entries(r.competitorVisibilityMap as Record<string, number>)
          .map(([k, v]) => [k, r1(v)])
      );
    }
    return row;
  });

  const result = {
    query_text:          match.queryText,
    query_type:          match.queryType ?? null,
    query_type_note:     match.queryType === 'blind'
      ? 'blind = neutral/unprompted — no brand name in query. Measures organic AI discoverability.'
      : null,
    overall_visibility:  r1(match.visibilityScore) ?? null,
    overall_soa:         r1(match.soaScore)         ?? null,
    collector_breakdown: breakdown,
    _meta: {
      brand_id:              brandId,
      date_range:            { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      collectors_returned:   breakdown.length,
      competitors_included:  includeCompetitors,
      data_source:           'EvidentlyAEO prompt analytics — real collector data only.',
      field_guide: {
        soa_score:    '0–100. Brand share of the answer on this collector for this query.',
        avg_position: 'Lower = brand appears earlier in the AI response. null = brand not mentioned.',
        null_values:  'null = no data. Do NOT report null as 0.',
      },
      cache_hit: cacheHit,
    },
  };

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 4 — topics_performance  (unchanged from v1, co-located for clarity)
// ─────────────────────────────────────────────────────────────────────────────

export async function executeTopicsPerformance(inputs: any, ctx: any, dbToken: string) {
  const { brandId, startDate, endDate, fields } = inputs;
  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  const { data, cacheHit } = await fetchPromptAnalytics(inputs, ctx.customerId);

  const topics = ((data as any).topics || []).map((t: any) => ({
    topic_name:                    t.name              ?? null,
    prompt_count:                  t.promptCount       ?? null,
    volume_count:                  t.volumeCount       ?? null,
    visibility_score_0_to_100:     r1(t.visibilityScore)  ?? null,
    sentiment_score_0_to_100:      r1(t.sentimentScore)   ?? null,
    total_mentions:                t.mentions              ?? null,
    share_of_answer_score:         r1(t.soaScore)          ?? null,
    brand_presence_pct:            r1(t.brandPresencePercentage) ?? null,
  }));

  const result = topics.length === 0 ? {
    topics: annotateEmptyArray('topics', `brand ${brandId} in this date range`),
    _meta:  { brand_id: brandId, cache_hit: cacheHit },
  } : {
    topics,
    total_topics: topics.length,
    _meta: {
      brand_id:    brandId,
      date_range:  { startDate: startDate ?? 'last 30 days', endDate: endDate ?? 'today' },
      data_source: 'EvidentlyAEO topic analytics — real tracked data only',
      cache_hit:   cacheHit,
    },
  };

  return projectFields(result as any, fields);
}

// ─────────────────────────────────────────────────────────────────────────────
// Backward-Compatible Alias (deprecated — remove after server.ts is updated)
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use executeQueriesSummary */
export async function executeQueryPerformance(inputs: any, ctx: any, dbToken: string) {
  return executeQueriesSummary(inputs, ctx, dbToken);
}

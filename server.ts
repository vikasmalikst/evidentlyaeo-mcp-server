import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { LRUCache } from 'lru-cache';

import { validateTokenAndIssueShadow, assertScope, McpUserContext } from './auth/token-validator';
import { config } from '../config/environment';
import { supabaseAdmin } from '../config/database';
// import { rateLimiter } from './middleware/rate-limiter';
import { assertBrandOwnership } from './middleware/brand-guard';
import { logAudit } from './audit/audit-logger';
import { errorResponse, successResponse, McpUserError, McpSystemError } from './utils/response-formatter';
import { buildCacheKey, getCached, setCached } from './cache/tool-cache';

import { executeBrandsList, brandsListSchema } from './tools/brands.tool';
import {
  executeListRecommendations,
  listRecommendationsSchema,
  executeGetRecommendationDetail,
  getRecommendationDetailSchema
} from './tools/recommendations.tool';
import {
  executeGetDomainAudit,
  getDomainAuditSchema
} from './tools/domain-readiness.tool';
import {
  executeCitationsTopSources, citationsTopSourcesSchema,
  executeCitationsSourceDetail, citationsSourceDetailSchema,
  executeCitationsCompetitorGap, citationsCompetitorGapSchema,
  executeCitationsTrend, citationsTrendSchema,

} from './tools/citations.tool';
import {
  executeQueriesSummary, queriesSummarySchema,
  executeQueriesCompetitorOverlap, queriesCompetitorOverlapSchema,
  executeQueriesCollectorBreakdown, queriesCollectorBreakdownSchema,
  executeTopicsPerformance, topicsPerformanceSchema,

  executeQueriesTrend, queriesTrendSchema,
} from './tools/queries.tool';
import {
  executeDashboardGetSummary, dashboardGetSummarySchema,
  executeDashboardListCompetitors, dashboardListCompetitorsSchema,
  executeDashboardLlmBreakdown, dashboardLlmBreakdownSchema,
  executeDashboardGetActionItems, dashboardGetActionItemsSchema,

} from './tools/dashboard.tool';
import { METRIC_DICTIONARY, DICTIONARY_URI, DICTIONARY_MIME } from './content/dictionary.content';
import { PROMPTS } from './content/expert-persona.prompt';

// --------------------------------------------------------------------------------
// Tool Registration Helper
// --------------------------------------------------------------------------------
function registerTools(server: McpServer, sessionId: string) {
  // `as any` casts on schema.shape and callbacks work around a known MCP SDK + Zod
  // type-explosion bug (github.com/modelcontextprotocol/typescript-sdk/issues/985)
  // that causes TypeScript compiler OOM. Remove once SDK ships a fix (tracked in v2).
  server.tool(
    'brands_list',
    'Returns all brands owned by the authenticated customer, including brand name, industry, homepage URL, and creation date. Call this when a brandId is missing. Do NOT call this if the user already provided a valid brandId.',
    brandsListSchema.shape as any,
    {
      title: 'List Brands',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('brands_list', 'read:brands', inputs, executeBrandsList, sessionId);
    }
  );

  // --------------------------------------------------------------------------------
  // Production Tool Suite
  // --------------------------------------------------------------------------------

  server.tool(
    'dashboard_get_summary',
    'Returns core KPI summary for a brand: Search Visibility %, Sentiment Score, Brand Presence Rate, total prompts tracked, and top 5 topics. Call this first for any brand performance question.',
    dashboardGetSummarySchema.shape as any,
    {
      title: 'Get Dashboard Summary',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('dashboard_get_summary', 'read:dashboard', inputs, executeDashboardGetSummary, sessionId);
    }
  );

  server.tool(
    'dashboard_list_competitors',
    'Returns competitor comparison data: visibility %, share of answer %, sentiment, and mention counts for all tracked competitors. Call this ONLY when the user asks about competitors or competitive gaps at the brand level. For query-level competitor gaps, use queries_competitor_overlap instead.',
    dashboardListCompetitorsSchema.shape as any,
    {
      title: 'List Competitors',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('dashboard_list_competitors', 'read:dashboard', inputs, executeDashboardListCompetitors, sessionId);
    }
  );

  server.tool(
    'dashboard_llm_breakdown',
    'Returns per-LLM performance breakdown: visibility, share of answer, and sentiment split by AI engine (ChatGPT, Perplexity, Gemini, etc.). Call this ONLY when the user asks about specific AI engine performance at the brand level. For per-engine data on a specific query, use queries_collector_breakdown instead.',
    dashboardLlmBreakdownSchema.shape as any,
    {
      title: 'LLM Performance Breakdown',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('dashboard_llm_breakdown', 'read:dashboard', inputs, executeDashboardLlmBreakdown, sessionId);
    }
  );

  server.tool(
    'dashboard_get_action_items',
    'Returns AI-generated action items from the latest dashboard analysis for a brand. Call this when the user asks what to do, what to improve, or for next steps.',
    dashboardGetActionItemsSchema.shape as any,
    {
      title: 'Get Action Items',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('dashboard_get_action_items', 'read:dashboard', inputs, executeDashboardGetActionItems, sessionId);
    }
  );

  // --------------------------------------------------------------------------------
  // Query Intelligence Tools (v2 — 3-tier architecture)
  //
  // Tier 1  queries_summary             — default entry point, always call first
  // Tier 2  queries_competitor_overlap  — competitive gap drill-down
  // Tier 3  queries_collector_breakdown — per-AI-engine single-query drill-down
  // --------------------------------------------------------------------------------

  server.tool(
    'queries_summary',
    'Returns top-performing tracked queries for a brand with slim aggregated scores: ' +
    'visibility % (0–100), Share of Answer / SOA (0–100), mention count, brand presence %, and query type. ' +
    'Query types: ' +
    '  "blind"      = Neutral queries — NO brand name in the question. ' +
    '                 SYNONYMS: blind = neutral = unprompted = generic query. ' +
    '                 Measures organic AI discoverability (is the brand mentioned when nobody asked about it?). ' +
    '                 This is the most important visibility signal. ' +
    '  "brand"      = Queries that explicitly name this brand. ' +
    '  "all"        = All query types combined (default). ' +
    'ALWAYS call this first for any question about query performance, top queries, ' +
    'neutral/blind/unprompted visibility, SOA, or query-level metrics. ' +
    'Set includeCompetitors: true when the user asks about competitor visibility on specific queries. ' +
    'Do NOT call queries_collector_breakdown unless the user specifically asks ' +
    'about a named AI engine (ChatGPT, Perplexity, etc.) AND a specific query. ' +
    'Do NOT call queries_competitor_overlap unless the user asks about ' +
    'competitive gaps or which queries competitors are winning.',
    queriesSummarySchema.shape as any,
    {
      title: 'Queries Summary',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('queries_summary', 'read:queries', inputs, executeQueriesSummary, sessionId);
    }
  );

  server.tool(
    'queries_competitor_overlap',
    'Returns queries where tracked competitors also appear in AI responses, ' +
    'with a side-by-side visibility comparison and a pre-computed visibilityGap. ' +
    'visibilityGap = our visibility_score − competitor_visibility_score. ' +
    '  Negative gap = competitor leads us on that query (we are losing). ' +
    '  Positive gap = we lead the competitor on that query. ' +
    'Results are sorted by largest competitive loss first (worst gaps at top). ' +
    'CALL THIS when the user asks: which queries are competitors winning, ' +
    'where are we losing AI visibility to competitors, what are our competitive ' +
    'query gaps, or how we compare on blind/brand queries vs a named competitor. ' +
    'Do NOT call this for brand-level competitor comparison — ' +
    'use dashboard_list_competitors for that instead.',
    queriesCompetitorOverlapSchema.shape as any,
    {
      title: 'Competitor Query Overlap',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('queries_competitor_overlap', 'read:queries', inputs, executeQueriesCompetitorOverlap, sessionId);
    }
  );

  server.tool(
    'queries_collector_breakdown',
    'Returns per-AI-engine (collector) performance for ONE specific query. ' +
    'Shows how the brand performs on ChatGPT vs Perplexity vs Gemini etc. ' +
    'for that exact query, including visibility, SOA, mentions, and avg position. ' +
    'ONLY call this when the user asks about a specific AI engine AND a specific query simultaneously. ' +
    'Requires queryText — copy the exact value from a queries_summary result. ' +
    'Do NOT use this for brand-level per-engine data — use dashboard_llm_breakdown instead.',
    queriesCollectorBreakdownSchema.shape as any,
    {
      title: 'Collector Query Breakdown',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('queries_collector_breakdown', 'read:queries', inputs, executeQueriesCollectorBreakdown, sessionId);
    }
  );

  server.tool(
    'topics_performance',
    'Returns performance data aggregated by topic group ' +
    'including avg visibility score, SOA, sentiment, brand presence %, and prompt count per topic. ' +
    'CALL THIS when the user asks about topic-level performance, how topics compare, ' +
    'or which content categories drive the most AI visibility. ' +
    'Set includeCompetitors: true when the user asks how a competitor performs on a topic ' +
    'or wants a topic-vs-competitor comparison. ' +
    'Do NOT call this for individual query-level data — use queries_summary for that.',
    topicsPerformanceSchema.shape as any,
    {
      title: 'Topics Performance',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('topics_performance', 'read:queries', inputs, executeTopicsPerformance, sessionId);
    }
  );

  server.tool(
    'queries_trend',
    'Returns week-over-week or month-over-month change in overall query visibility, mention volume, ' +
    'and optionally the individual queries that moved most (gainers and losers). ' +
    'Deltas are pre-computed — do NOT call queries_summary twice for different dates to compute manually. ' +
    'CALL THIS when the user asks about visibility trends, whether performance is improving or declining, ' +
    'what changed this week/month, or which queries gained or lost the most. ' +
    'Set includeMovers: true ONLY when the user explicitly asks which queries moved the most. ' +
    'Do NOT use this for current snapshot data — use queries_summary for that.',
    queriesTrendSchema.shape as any,
    {
      title: 'Queries Trend',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('queries_trend', 'read:queries', inputs, executeQueriesTrend, sessionId);
    }
  );



  // ─────────────────────────────────────────────────────────────────
  // Citation Intelligence Tools (v2 — 4-tool tiered architecture)
  //
  // Tier 1  citations_top_sources       — default, call first for any citation question
  // Tier 2  citations_source_detail     — single domain deep dive
  // Tier 2  citations_competitor_gap    — domains citing competitors not brand
  // Tier 3  citations_trend             — period-over-period trend
  // ─────────────────────────────────────────────────────────────────

  server.tool(
    'citations_top_sources',
    'Use this tool to get top citation sources for a brand. Sort by impact_score (the main metric on the Citations Sources page). Also returns category (priority/reputation/growth/monitor) and source_type_distribution.',
    citationsTopSourcesSchema.shape as any,
    {
      title: 'Top Citation Sources',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('citations_top_sources', 'read:citations', inputs, executeCitationsTopSources, sessionId);
    }
  );

  server.tool(
    'citations_source_detail',
    'Returns full citation analytics for ONE specific domain. ' +
    'Includes mention count, sentiment breakdown, and per-collector data for that domain. ' +
    'ONLY call this when the user names a specific website or domain (e.g. "How does Forbes cite me?"). ' +
    'Requires the exact domain string — call citations_top_sources first if you do not know it. ' +
    'Do NOT call this to get a list of sources — use citations_top_sources for that.',
    citationsSourceDetailSchema.shape as any,
    {
      title: 'Source Detail',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('citations_source_detail', 'read:citations', inputs, executeCitationsSourceDetail, sessionId);
    }
  );

  server.tool(
    'citations_competitor_gap',
    'Returns domains that cite tracked competitors but NOT this brand — sorted by opportunity size. ' +
    'Use this to identify citation gap opportunities and outreach targets for AEO content strategy. ' +
    'CALL THIS when the user asks: which sources cite competitors but not us, ' +
    'where are we missing citations, what are our citation gap opportunities, ' +
    'or where should we build backlinks/content for AI citation. ' +
    'Do NOT call this for general citation performance — use citations_top_sources instead.',
    citationsCompetitorGapSchema.shape as any,
    {
      title: 'Citation Competitor Gap',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('citations_competitor_gap', 'read:citations', inputs, executeCitationsCompetitorGap, sessionId);
    }
  );

  server.tool(
    'citations_trend',
    'Returns week-over-week or month-over-month change in citation volume, mention rate, and sentiment. ' +
    'Deltas are pre-computed server-side — do NOT call this tool twice for different dates and compute manually. ' +
    'CALL THIS when the user asks about trends, changes, growth, improvement, or decline in citations over time. ' +
    'Do NOT call this for current snapshot data — use citations_top_sources for that. ' +
    'Do NOT call citations_source_attribution for trend questions.',
    citationsTrendSchema.shape as any,
    {
      title: 'Citations Trend',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('citations_trend', 'read:citations', inputs, executeCitationsTrend, sessionId);
    }
  );



  server.tool(
    'recommendations_list',
    'Returns strategy recommendations for a brand with actions, reasons, and impact scores. Call this when the user asks what to improve next. Do NOT call this for raw KPI retrieval.',
    listRecommendationsSchema.shape as any,
    {
      title: 'List Recommendations',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('recommendations_list', 'read:recommendations', inputs, executeListRecommendations, sessionId);
    }
  );

  server.tool(
    'recommendations_get_detail',
    'Returns full detail for a specific recommendation ID. Call this only after obtaining an ID from recommendations_list. Do NOT call this to list recommendations.',
    getRecommendationDetailSchema.shape as any,
    {
      title: 'Get Recommendation Detail',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('recommendations_get_detail', 'read:recommendations', inputs, executeGetRecommendationDetail, sessionId);
    }
  );

  server.tool(
    'domain_readiness_get_audit',
    'Returns the latest domain readiness audit for a brand. Call this for website/domain readiness questions. Do NOT call this for citation, query, or dashboard KPI analysis.',
    getDomainAuditSchema.shape as any,
    {
      title: 'Get Domain Audit',
      readOnlyHint: true
    },
    async (inputs: any) => {
      return await executeToolWithMiddleware('domain_readiness_get_audit', 'read:domain', inputs, executeGetDomainAudit, sessionId);
    }
  );
}

function registerResources(server: McpServer) {
  server.resource(
    'metric-dictionary',
    DICTIONARY_URI,
    {
      mimeType: DICTIONARY_MIME,
      description:
        'Definitions for all EvidentlyAEO metrics: Visibility, SOA, Presence Rate, Sentiment, Blind/Brand queries, and null value rules. Reference this before interpreting any metric values.',
    },
    async () => ({
      contents: [{
        uri: DICTIONARY_URI,
        mimeType: DICTIONARY_MIME,
        text: METRIC_DICTIONARY,
      }],
    })
  );
}

function registerPrompts(server: McpServer) {
  for (const prompt of PROMPTS) {
    server.prompt(
      prompt.name,
      prompt.description,
      prompt.arguments as any,
      async (args: any) => ({
        messages: prompt.getMessages(args),
      })
    );
  }
}

// --------------------------------------------------------------------------------
// Shared Middleware Chain logic
// --------------------------------------------------------------------------------
async function executeToolWithMiddleware<T>(
  toolName: string,
  requiredScope: string,
  inputs: unknown,
  handler: (inputs: any, ctx: McpUserContext, dbToken: string) => Promise<T>,
  sessionId: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const t0 = Date.now();
  const session = serverCache.get(sessionId);

  if (!session?.ctx) {
    return errorResponse(new McpSystemError('Missing request context', 'NO_CONTEXT'));
  }

  const { ctx, dbToken } = session;
  const inputsObj = (inputs as Record<string, unknown>) || {};
  const auditBase = {
    userId: ctx.userId,
    customerId: ctx.customerId,
    toolName,
    inputs: inputsObj,
    scopeUsed: requiredScope,
  };

  try {
    assertScope(ctx.scopes, requiredScope);
    // await rateLimiter(ctx.customerId, toolName);

    if (inputsObj?.brandId && typeof inputsObj.brandId === 'string') {
      await assertBrandOwnership(inputsObj.brandId, ctx.customerId);
    }

    const cacheKey = buildCacheKey(
      toolName,
      ctx.customerId,
      (inputsObj?.brandId as string) ?? 'global',
      inputsObj
    );
    const cached = getCached(cacheKey);
    if (cached) {
      const responseText = JSON.stringify(cached);
      logAudit({
        ...auditBase,
        outcome: 'success',
        durationMs: Date.now() - t0,
        cacheHit: true,
        responseBytes: responseText.length,
        estimatedTokens: Math.ceil(responseText.length / 4),
      });
      return successResponse(cached);
    }

    const result = await handler(inputs, ctx, dbToken);
    setCached(cacheKey, result);
    const responseText = JSON.stringify(result);

    logAudit({
      ...auditBase,
      outcome: 'success',
      durationMs: Date.now() - t0,
      cacheHit: false,
      responseBytes: responseText.length,
      estimatedTokens: Math.ceil(responseText.length / 4),
    });

    return successResponse(result);
  } catch (error) {
    logAudit({
      ...auditBase,
      outcome: error instanceof McpUserError ? 'user_error' : 'system_error',
      errorCode: error instanceof McpUserError ? error.code : 'INTERNAL_ERROR',
      durationMs: Date.now() - t0,
    });

    return errorResponse(error);
  }
}

// --------------------------------------------------------------------------------
// Session Management & Router
// --------------------------------------------------------------------------------

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  ctx: McpUserContext;
  dbToken: string;
}

const transportCache = new LRUCache<string, SessionEntry>({
  max: 100,
  ttl: 1000 * 60 * 60,
});

const authCache = new LRUCache<string, { ctx: McpUserContext; dbToken: string }>({
  max: 500,
  ttl: 1000 * 60 * 15,
});

const serverCache = {
  get: (sid: string): SessionEntry | undefined => {
    const transport = transportCache.get(sid);
    const auth = authCache.get(sid);
    if (!transport) return undefined;
    if (auth) {
      transport.ctx = auth.ctx;
      transport.dbToken = auth.dbToken;
    }
    return transport;
  },
  set: (sid: string, entry: SessionEntry) => {
    transportCache.set(sid, entry);
    authCache.set(sid, { ctx: entry.ctx, dbToken: entry.dbToken });
  },
  has: (sid: string) => transportCache.has(sid),
  keys: () => transportCache.keys(),
};

const router = Router();
const getRequestTimestamps = new Map<string, number[]>();

// Required: Inspector and clients probe the endpoint with GET first
router.get('/', (req, res) => {
  const clientIp = req.ip || 'unknown';
  const now = Date.now();
  const timestamps = getRequestTimestamps.get(clientIp) || [];

  // Allow at most 100 GETs per 10 seconds per IP (polling-friendly).
  const recentTimestamps = timestamps.filter(t => now - t < 10_000);
  if (recentTimestamps.length >= 100) {
    return res.status(429).json({ error: 'Too many health checks. Slow down.' });
  }

  recentTimestamps.push(now);
  getRequestTimestamps.set(clientIp, recentTimestamps);

  res.set({
    'Cache-Control': 'public, max-age=30',
    'X-Content-Type-Options': 'nosniff',
  });

  res.status(200).json({
    name: 'EvidentlyAEO MCP Server',
    version: '1.0.0',
    transport: 'streamable-http',
    protocolVersion: '2024-11-05',
  });
});

router.get('/health', async (_req, res) => {
  try {
    const { error } = await supabaseAdmin.from('api_keys').select('id').limit(1);
    if (error) throw error;
    res.status(200).json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'unreachable' });
  }
});

// Required: Handle CORS preflights for MCP Inspector
router.options('/', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400', // Cache preflight for 24h
  });
  res.status(204).send();
});

router.post('/', async (req, res) => {
  try {
    // 1. Authenticate
    const rawToken =
      req.headers.authorization?.split(' ')[1] ||
      (req.query.token as string)?.replace(/^Bearer\s+/i, '') ||
      '';

    if (!rawToken) {
      return res.status(401)
        .set('WWW-Authenticate',
          `Bearer realm="EvidentlyAEO MCP", ` +
          `authorization_uri="${config.frontendUrl}/auth", ` +
          `token_uri="${config.apiUrl}/oauth/token"`)
        .json(
          errorResponse(new McpUserError('Authentication required. Please log in at /auth.', 'UNAUTHORIZED'))
        );
    }

    const { ctx, dbToken } = await validateTokenAndIssueShadow(rawToken);

    // 2. Route by session state
    const incomingSessionId = req.headers['mcp-session-id'] as string | undefined;
    const body = req.body as Record<string, unknown>;
    const bodyMethod = body?.method as string | undefined;

    console.log(`[MCP POST] method=${bodyMethod ?? 'unknown'} sessionId=${incomingSessionId ?? 'none'} cacheHas=${incomingSessionId ? serverCache.has(incomingSessionId) : 'n/a'} cacheKeys=${JSON.stringify([...serverCache.keys()])}`);

    if (incomingSessionId && serverCache.has(incomingSessionId)) {
      // --- Existing session: refresh auth context and dispatch ---
      const session = serverCache.get(incomingSessionId)!;
      session.ctx = ctx;
      session.dbToken = dbToken;
      serverCache.set(incomingSessionId, session);
      await session.transport.handleRequest(req, res, req.body);

    } else if (!incomingSessionId && isInitializeRequest(req.body)) {
      // --- New session: only accept initialize requests ---
      const newSessionId = randomUUID();
      const server = new McpServer({
        name: 'EvidentlyAEO',
        version: '1.0.0',
        instructions: `You are an AEO (Answer Engine Optimization) analytics assistant powered by the EvidentlyAEO platform.

MANDATORY RULES — follow these on every response:
1. ALWAYS call the relevant tool first before answering any analytics question. Never answer from memory or training data.
2. ONLY report numbers, scores, and facts that are explicitly present in the tool response's "result" field.
3. If a metric is null, missing, or the result array is empty — say "No data available for this metric in the selected period." Do NOT fabricate or estimate values.
4. Never add industry averages, benchmarks, or comparisons that are not present in the tool data.
5. When reporting percentages or scores, always state the metric name and unit exactly as labeled in the data (e.g., "Search Visibility is 67.4%", not just "67.4").
6. If the user asks about something outside these tools (brands, queries, citations, recommendations, domain audit), say: "That information is not available through the EvidentlyAEO MCP tools."
7. Date ranges: always confirm which date range the data covers when reporting metrics.
8. For competitor data: only name and compare competitors that appear explicitly in the tool response.
9. ALWAYS include the token consumption values (input and output tokens) in your final response whenever they are provided in the tool results or context.`,
      } as any);
      const transport = new StreamableHTTPServerTransport({
        // sessionIdGenerator tells the transport what ID to use and to operate in stateful mode
        sessionIdGenerator: () => newSessionId,
        // onsessioninitialized fires after the transport assigns its ID — use this to cache
        // under the exact ID the transport will send to the client in the response header
        onsessioninitialized: (sid) => {
          serverCache.set(sid, { server, transport, ctx, dbToken });
          transport.onclose = () => {
            transportCache.delete(sid);
            authCache.delete(sid);
          };
        },
      });

      // Register tools FIRST, connect SECOND (wires tools into transport)
      registerTools(server, newSessionId);
      registerResources(server);
      registerPrompts(server);
      await server.connect(transport);

      // Ensure the session ID is sent to the client in the response header
      res.setHeader('Mcp-Session-Id', newSessionId);

      // Dispatch — transport calls sessionIdGenerator(), sets _initialized, fires onsessioninitialized,
      // and sends the Mcp-Session-Id response header automatically
      await transport.handleRequest(req, res, req.body);

    } else {
      // Non-initialize POST with no valid session — reject cleanly
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session. Send initialize first.' },
        id: null,
      });
    }
  } catch (err) {
    const status = err instanceof McpUserError ? 401 : 500;
    return res.status(status).json(errorResponse(err));
  }
});


export default router;

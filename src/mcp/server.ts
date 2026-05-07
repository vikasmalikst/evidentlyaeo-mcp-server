import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { LRUCache } from 'lru-cache';

import { validateTokenAndIssueShadow, assertScope, McpUserContext } from './auth/token-validator.js';
import { config } from '../config/environment.js';
import { supabaseAdmin } from '../config/database.js';
// import { rateLimiter } from './middleware/rate-limiter.js';
import { assertBrandOwnership } from './middleware/brand-guard.js';
import { logAudit } from './audit/audit-logger.js';
import { errorResponse, successResponse, McpUserError, McpSystemError } from './utils/response-formatter.js';
import { buildCacheKey, getCached, setCached } from './cache/tool-cache.js';

import { executeBrandsList, brandsListSchema } from './tools/brands.tool.js';
import {
  executeListRecommendations,
  listRecommendationsSchema,
  executeGetRecommendationDetail,
  getRecommendationDetailSchema
} from './tools/recommendations.tool.js';
import {
  executeGetDomainAudit,
  getDomainAuditSchema
} from './tools/domain-readiness.tool.js';
import {
  executeCitationsTopSources, citationsTopSourcesSchema,
  executeCitationsSourceDetail, citationsSourceDetailSchema,
  executeCitationsCompetitorGap, citationsCompetitorGapSchema,
  executeCitationsTrend, citationsTrendSchema,

} from './tools/citations.tool.js';
import {
  executeQueriesSummary, queriesSummarySchema,
  executeQueriesCompetitorOverlap, queriesCompetitorOverlapSchema,
  executeQueriesCollectorBreakdown, queriesCollectorBreakdownSchema,
  executeTopicsPerformance, topicsPerformanceSchema,

  executeQueriesTrend, queriesTrendSchema,
} from './tools/queries.tool.js';
import {
  executeDashboardGetSummary, dashboardGetSummarySchema,
  executeDashboardListCompetitors, dashboardListCompetitorsSchema,
  executeDashboardLlmBreakdown, dashboardLlmBreakdownSchema,
  executeDashboardGetActionItems, dashboardGetActionItemsSchema,

} from './tools/dashboard.tool.js';
import { METRIC_DICTIONARY, DICTIONARY_URI, DICTIONARY_MIME } from './content/dictionary.content.js';
import { PROMPTS } from './content/expert-persona.prompt.js';

// --------------------------------------------------------------------------------
// Tool Registration Helper
// --------------------------------------------------------------------------------
function registerTools(server: McpServer, sessionId: string) {
  // `as any` casts on schema.shape and callbacks work around a known MCP SDK + Zod
  // type-explosion bug (github.com/modelcontextprotocol/typescript-sdk/issues/985)
  // that causes TypeScript compiler OOM. Remove once SDK ships a fix (tracked in v2).
  server.tool(
    'brands_list',
    'Returns all brands owned by the authenticated customer, including brand name, industry, homepage URL, and creation date. Requires no inputs beyond authentication.',
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
    'Returns core brand-level KPI summary: Search Visibility %, Sentiment Score, Brand Presence Rate, total prompts tracked, and the top 5 performing topics. Scoped to a single brand and optional date range.',
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
    'Returns brand-level competitor comparison data: visibility %, share of answer %, sentiment score, and mention counts for all tracked competitors relative to this brand.',
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
    'Returns brand-level performance broken down by AI engine: visibility %, share of answer %, and sentiment score split across ChatGPT, Perplexity, Gemini, and other tracked AI platforms.',
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
    'Returns AI-generated prioritised action items from the latest dashboard analysis for a brand, each with an action description, rationale, and impact score.',
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
  // Tier 1  queries_summary             — broad aggregated query metrics
  // Tier 2  queries_competitor_overlap  — competitive gap drill-down
  // Tier 3  queries_collector_breakdown — per-AI-engine single-query drill-down
  // --------------------------------------------------------------------------------

  server.tool(
    'queries_summary',
    'Returns tracked queries for a brand with aggregated per-query scores: visibility % (0–100), Share of Answer / SOA (0–100), mention count, brand presence %, and query type. ' +
    '\n\nQuery type values: ' +
    '\n- "blind": Neutral queries that do not contain the brand name. Measures organic AI discoverability — whether the brand is mentioned when not explicitly asked about. Also referred to as neutral, unprompted, or generic queries.' +
    '\n- "brand": Queries that explicitly name the brand.' +
    '\n- "all": All query types combined (default when type is omitted).' +
    '\n\nWhen includeCompetitors is true, each query result also includes competitor visibility scores and presence data for side-by-side comparison.',
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
    'Returns queries where tracked competitors appear in AI responses alongside this brand, with a side-by-side visibility comparison per query. ' +
    '\n\nEach result includes: ' +
    '\n- visibilityGap: this brand\'s visibility_score minus the competitor\'s visibility_score. A negative gap means the competitor leads on that query. A positive gap means this brand leads. ' +
    '\n- Results are sorted by largest competitive loss first (most negative gaps at top). ' +
    '\n\nFilterable by competitor, query type, date range, and topic.',
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
    'Returns per-AI-engine performance for a single specific query, identified by exact queryText. Shows visibility %, SOA, mention count, and average position on that query broken down by each AI engine (ChatGPT, Perplexity, Gemini, etc.). ' +
    '\n\nqueryText must be an exact match to a tracked query string.',
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
    'Returns performance data aggregated by topic group: average visibility score, SOA, sentiment, brand presence %, and prompt count per topic. ' +
    '\n\nWhen includeCompetitors is true, each topic result also includes competitor performance data for that topic, enabling topic-vs-competitor comparison.',
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
    'Returns period-over-period change in overall query visibility, mention volume, and SOA. Deltas are pre-computed server-side for the requested granularity (weekly or monthly). ' +
    '\n\nWhen includeMovers is true, results also include individual queries with the largest positive and negative visibility changes during the period.',
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
  // Tier 1  citations_top_sources       — aggregated citation source rankings
  // Tier 2  citations_source_detail     — single domain deep dive
  // Tier 2  citations_competitor_gap    — domains citing competitors not brand
  // Tier 3  citations_trend             — period-over-period trend
  // ─────────────────────────────────────────────────────────────────

  server.tool(
    'citations_top_sources',
    'Returns top citation sources for a brand sorted by impact_score. Each source includes domain, impact score, citation category (priority / reputation / growth / monitor), and source type distribution across AI engines.',
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
    'Returns full citation analytics for a single domain: mention count, sentiment breakdown, and per-AI-engine data for that domain\'s citations of the brand. Requires the exact domain string as input.',
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
    'Returns domains that cite tracked competitors but do not cite this brand, sorted by opportunity size. Each result includes the domain, the competitor(s) it cites, and a gap score representing the citation opportunity.',
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
    'Returns period-over-period change in citation volume, mention rate, and sentiment. Deltas are pre-computed server-side for the requested granularity (weekly or monthly).',
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
    'Returns strategy recommendations for a brand: each recommendation includes an action description, reasoning, impact score, and associated metric category.',
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
    'Returns full detail for a single recommendation by ID: complete action plan, supporting evidence, affected metrics, and estimated impact. Requires a valid recommendation ID.',
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
    'Returns the latest domain readiness audit for a brand\'s website: structured data score, schema markup coverage, page speed signal, crawlability status, and an overall readiness score.',
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

When answering analytics questions, use the available tools to retrieve current data. Report only values explicitly present in tool results — if a metric is null, missing, or the result is empty, state that no data is available for that metric in the selected period rather than estimating. When reporting metrics, include the metric name and unit as labeled in the data. Confirm the date range covered when reporting any time-scoped metric. For competitor data, reference only competitors that appear in the tool result. If a question falls outside the scope of available tools, say so clearly.`,
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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { LRUCache } from 'lru-cache';

import { validateTokenAndIssueShadow, assertScope, McpUserContext } from './auth/token-validator';
import { config } from '../config/environment';
import { rateLimiter } from './middleware/rate-limiter';
import { logAudit } from './audit/audit-logger';
import { errorResponse, successResponse, McpUserError, McpSystemError } from './utils/response-formatter';

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
  executeSourceAttribution, 
  getSourceAttributionSchema 
} from './tools/citations.tool';
import { 
  executeQueryPerformance,
  queryPerformanceSchema,
  executeTopicsPerformance, 
  topicsPerformanceSchema 
} from './tools/queries.tool';
import { 
  executeDashboardKPIs, 
  dashboardKPIsSchema 
} from './tools/dashboard.tool';

// --------------------------------------------------------------------------------
// Tool Registration Helper
// --------------------------------------------------------------------------------
function registerTools(server: McpServer, sessionId: string) {
  server.tool(
    'brands.list',
    'Returns all brands owned by the authenticated customer, including brand name, industry, homepage URL, and creation date.',
    brandsListSchema.shape,
    async (inputs) => {
      return await executeToolWithMiddleware('brands.list', 'read:brands', inputs, executeBrandsList, sessionId);
    }
  );

  // --------------------------------------------------------------------------------
  // Production Tool Suite
  // --------------------------------------------------------------------------------

  server.tool(
    'dashboard.kpi_overview',
    'Returns high-level analytical KPIs for a brand, including Search Visibility, Share of Voice, Sentiment, Topic Performance, and Competitor Gaps.',
    dashboardKPIsSchema.shape,
    async (inputs) => {
      return await executeToolWithMiddleware('dashboard.kpi_overview', 'read:dashboard', inputs, executeDashboardKPIs, sessionId);
    }
  );

  server.tool(
    'query.performance',
    'Returns performance data for top-performing queries, including visibility scores, mentions, and Share of Answer (SOA).',
    queryPerformanceSchema.shape,
    async (inputs) => {
      return await executeToolWithMiddleware('query.performance', 'read:queries', inputs, executeQueryPerformance, sessionId);
    }
  );

  server.tool(
    'topics.performance',
    'Returns high-level performance data aggregated by topic, including visibility and sentiment across query groups.',
    topicsPerformanceSchema.shape,
    async (inputs) => {
      return await executeToolWithMiddleware('topics.performance', 'read:queries', inputs, executeTopicsPerformance, sessionId);
    }
  );

  server.tool(
    'citations.source_attribution',
    'Returns source attribution data for a brand, showing which domains are citing it and their overall impact.',
    getSourceAttributionSchema.shape,
    async (inputs) => {
      return await executeToolWithMiddleware('citations.source_attribution', 'read:citations', inputs, executeSourceAttribution, sessionId);
    }
  );

  server.tool(
    'recommendations.list',
    'Returns a list of AI-driven strategy recommendations for a specific brand, including actions, reasons, and impact scores.',
    listRecommendationsSchema.shape,
    async (inputs) => {
      return await executeToolWithMiddleware('recommendations.list', 'read:recommendations', inputs, executeListRecommendations, sessionId);
    }
  );

  server.tool(
    'recommendations.get_detail',
    'Returns full technical details for a specific recommendation, including deep explanations and focus sources.',
    getRecommendationDetailSchema.shape,
    async (inputs) => {
      return await executeToolWithMiddleware('recommendations.get_detail', 'read:recommendations', inputs, executeGetRecommendationDetail, sessionId);
    }
  );

  server.tool(
    'domain_readiness.get_audit',
    'Returns the most recent AEO (Answer Engine Optimization) domain readiness audit results for a specific brand.',
    getDomainAuditSchema.shape,
    async (inputs) => {
      return await executeToolWithMiddleware('domain_readiness.get_audit', 'read:domain', inputs, executeGetDomainAudit, sessionId);
    }
  );
}

// --------------------------------------------------------------------------------
// Shared Middleware Chain logic
// --------------------------------------------------------------------------------
async function executeToolWithMiddleware(
  toolName: string,
  requiredScope: string,
  inputs: unknown,
  handler: (inputs: unknown, ctx: McpUserContext, dbToken: string) => Promise<unknown>,
  sessionId: string
) {
  const t0 = Date.now();
  const session = serverCache.get(sessionId);
  
  if (!session?.ctx) {
    return errorResponse(new McpSystemError('Missing request context', 'NO_CONTEXT'));
  }

  const { ctx, dbToken } = session;

  try {
    assertScope(ctx.scopes, requiredScope);
    await rateLimiter(ctx.customerId);

    const result = await handler(inputs, ctx, dbToken);
    
    logAudit({
      userId: ctx.userId,
      customerId: ctx.customerId,
      toolName,
      inputs: inputs as Record<string, unknown>,
      scopeUsed: requiredScope,
      outcome: 'success',
      durationMs: Date.now() - t0,
    });

    return successResponse(result);
  } catch (error) {
    logAudit({
      userId: ctx?.userId ?? 'anonymous',
      customerId: ctx?.customerId ?? 'unknown',
      toolName,
      inputs: (inputs as Record<string, unknown>) || {},
      scopeUsed: requiredScope,
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

const serverCache = new LRUCache<string, SessionEntry>({
  max: 100,
  ttl: 1000 * 60 * 60,
});

const router = Router();

// Required: Inspector and clients probe the endpoint with GET first
router.get('/', (req, res) => {
  res.status(200).json({
    name: 'EvidentlyAEO MCP Server',
    version: '1.0.0',
    transport: 'streamable-http',
    protocolVersion: '2024-11-05',
  });
});

// Required: Handle CORS preflights for MCP Inspector
router.options('/', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin':      req.headers.origin || '*',
    'Access-Control-Allow-Methods':     'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':     'Content-Type, Authorization, Mcp-Session-Id',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age':           '86400', // Cache preflight for 24h
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
      await session.transport.handleRequest(req, res, req.body);

    } else if (!incomingSessionId && isInitializeRequest(req.body)) {
      // --- New session: only accept initialize requests ---
      const newSessionId = randomUUID();
      const server = new McpServer({ name: 'EvidentlyAEO', version: '1.0.0' });
      const transport = new StreamableHTTPServerTransport({
        // sessionIdGenerator tells the transport what ID to use and to operate in stateful mode
        sessionIdGenerator: () => newSessionId,
        // onsessioninitialized fires after the transport assigns its ID — use this to cache
        // under the exact ID the transport will send to the client in the response header
        onsessioninitialized: (sid) => {
          serverCache.set(sid, { server, transport, ctx, dbToken });
        },
      });

      // Register tools FIRST, connect SECOND (wires tools into transport)
      registerTools(server, newSessionId);
      await server.connect(transport);

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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Router, Request } from 'express';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { LRUCache } from 'lru-cache';

import { validateTokenAndIssueShadow, assertScope } from './auth/token-validator';
import { rateLimiter } from './middleware/rate-limiter';
import { logAudit } from './audit/audit-logger';
import { errorResponse, successResponse, McpUserError, McpSystemError } from './utils/response-formatter';

import { executeBrandsList, brandsListSchema } from './tools/brands.tool';

export const requestContext = new AsyncLocalStorage<{ 
  req: Request, 
  ctx: any, 
  dbToken: string 
}>();

// --------------------------------------------------------------------------------
// Tool Registration Helper
// --------------------------------------------------------------------------------
function registerTools(server: McpServer) {
  server.tool(
    'brands.list',
    'Returns all brands owned by the authenticated customer, including brand name, industry, homepage URL, and creation date.',
    brandsListSchema.shape,
    async (inputs) => {
      return await executeToolWithMiddleware('brands.list', 'read:brands', inputs, executeBrandsList);
    }
  );

  // --- Phase 2 Tool Stubs ---

  server.tool(
    'dashboard.kpi_overview',
    'Returns high-level KPIs for a specific brand.',
    { brandId: z.string().uuid() as any },
    async (inputs) => {
      return await executeToolWithMiddleware('dashboard.kpi_overview', 'read:dashboard', inputs, async () => ({ status: 'stub' }));
    }
  );

  server.tool(
    'query.performance',
    'Returns performance data for top-performing queries.',
    {},
    async (inputs) => {
      return await executeToolWithMiddleware('query.performance', 'read:queries', inputs, async () => ({ status: 'stub' }));
    }
  );

  server.tool(
    'topics.performance',
    'Returns performance data for specific topics.',
    {},
    async (inputs) => {
      return await executeToolWithMiddleware('topics.performance', 'read:queries', inputs, async () => ({ status: 'stub' }));
    }
  );

  server.tool(
    'citations.source_attribution',
    'Returns source attribution data for citations.',
    {},
    async (inputs) => {
      return await executeToolWithMiddleware('citations.source_attribution', 'read:citations', inputs, async () => ({ status: 'stub' }));
    }
  );

  server.tool(
    'recommendations.list',
    'Returns a list of AI-driven recommendations.',
    {},
    async (inputs) => {
      return await executeToolWithMiddleware('recommendations.list', 'read:recommendations', inputs, async () => ({ status: 'stub' }));
    }
  );

  server.tool(
    'recommendations.get_detail',
    'Returns technical details for a specific recommendation.',
    {},
    async (inputs) => {
      return await executeToolWithMiddleware('recommendations.get_detail', 'read:recommendations', inputs, async () => ({ status: 'stub' }));
    }
  );

  server.tool(
    'domain_readiness.get_audit',
    'Returns a domain audit for AEO readiness.',
    {},
    async (inputs) => {
      return await executeToolWithMiddleware('domain_readiness.get_audit', 'read:domain', inputs, async () => ({ status: 'stub' }));
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
  handler: (inputs: any, ctx: any, dbToken: string) => Promise<any>
) {
  const t0 = Date.now();
  const store = requestContext.getStore();
  
  if (!store) {
    return errorResponse(new McpSystemError('Missing request context', 'NO_CONTEXT'));
  }

  const { ctx, dbToken } = store;

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
// Session Manager
// --------------------------------------------------------------------------------

const serverCache = new LRUCache<string, { server: McpServer; transport: StreamableHTTPServerTransport }>({
  max: 100,
  ttl: 1000 * 60 * 60,
});

async function getOrCreateServerForSession(sessionId: string) {
  let session = serverCache.get(sessionId);
  if (!session) {
    const server = new McpServer({ name: 'EvidentlyAEO', version: '1.0.0' });
    registerTools(server);
    
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
    });
    
    await server.connect(transport);
    
    session = { server, transport };
    serverCache.set(sessionId, session);
  }
  return session;
}

// --------------------------------------------------------------------------------
// Express Router
// --------------------------------------------------------------------------------
const router = Router();

router.post('/', async (req, res) => {
  try {
    // 1. Authenticate FIRST - this ensures Test 2 returns UNAUTHORIZED correctly
    const rawToken = req.headers.authorization?.split(' ')[1] || '';
    if (!rawToken) {
      return res.status(401).json(errorResponse(new McpUserError('Missing Authorization header', 'UNAUTHORIZED')));
    }

    const { ctx, dbToken } = await validateTokenAndIssueShadow(rawToken);

    // 2. Identify or generate session
    const sessionId = (req.headers['mcp-session-id'] as string) || (req.query.sessionId as string) || randomUUID();
    
    // 3. Get/Init server for this session
    const { transport } = await getOrCreateServerForSession(sessionId);
    
    // 4. Dispatch to transport within its authenticated context
    await requestContext.run({ req, ctx, dbToken }, async () => {
      await transport.handleRequest(req, res, req.body);
    });
  } catch (err) {
    const status = err instanceof McpUserError ? 401 : 500;
    return res.status(status).json(errorResponse(err));
  }
});

export default router;

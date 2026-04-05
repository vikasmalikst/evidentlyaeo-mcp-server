import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { config } from '../../config/environment';
import { verifyToken } from '../../utils/jwt';
import { authService } from '../../services/auth/auth.service';
import logger from '../../utils/logger';

// ─── Environment-Aware Discovery Base URL ──────────────────────────────────────
const BASE_URL = config.nodeEnv === 'development'
  ? 'http://localhost:4001'
  : config.apiUrl; // e.g. https://api.evidentlyaeo.com

const ALL_SCOPES = [
  'read:brands', 'read:dashboard', 'read:queries',
  'read:citations', 'read:recommendations', 'read:domain'
];

export const wellKnownRouter = Router();

/**
 * GET /.well-known/oauth-authorization-server
 * RFC 8414 OAuth 2.0 Authorization Server Metadata
 * NOTE: response_types_supported and code_challenge_methods_supported are
 * required by the MCP TypeScript SDK's OAuthMetadataSchema Zod validation.
 * Without them, discoverAuthorizationServerMetadata() throws a ZodError and
 * the Inspector/client cannot complete the OAuth flow.
 */
wellKnownRouter.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${config.frontendUrl}/auth`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    response_types_supported: ['code'],                    // Required by MCP SDK OAuthMetadataSchema
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],            // Required: SDK checks for PKCE S256 support
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ALL_SCOPES,
    registration_endpoint: `${BASE_URL}/oauth/register`,
  });
});

/**
 * GET /.well-known/openid-configuration
 * RFC 8414 — Compatibility shim for OIDC-aware discovery clients
 */
wellKnownRouter.get('/.well-known/openid-configuration', (req: Request, res: Response) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${config.frontendUrl}/auth`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    registration_endpoint: `${BASE_URL}/oauth/register`,
    response_types_supported: ['code'],                    // Required by MCP SDK OAuthMetadataSchema
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],            // Required: SDK checks for PKCE S256 support
  });
});

/**
 * GET /.well-known/oauth-protected-resource
 * RFC 9728 — tells clients where the authorization server lives
 */
wellKnownRouter.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
  });
});

// Also handle the path-suffixed variant Inspector tries first
wellKnownRouter.get('/.well-known/oauth-protected-resource/mcp', (req: Request, res: Response) => {
  res.json({
    resource: `${BASE_URL}/mcp`,
    authorization_servers: [BASE_URL],
  });
});


export const oauthRouter = Router();

/**
 * POST /oauth/register
 * RFC 7591 Dynamic Client Registration
 * Inspector requires this to self-register before initiating OAuth flow
 */
oauthRouter.post('/register', (req: Request, res: Response) => {
  const { client_name, redirect_uris } = req.body;

  // Return a unique client_id per registration
  res.status(201).json({
    client_id: randomUUID(),
    client_name: client_name || 'MCP Client',
    redirect_uris: redirect_uris || [],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
});

/**
 * POST /token
 * Adapter endpoint the frontend/client calls to exchange a Supabase Session
 * for an MCP-specific access token.
 */
oauthRouter.post('/token', async (req: Request, res: Response): Promise<void> => {
  try {
    const { grant_type, refresh_token } = req.body;
    let { code, supabase_token } = req.body;
    const secret = process.env.SUPABASE_JWT_SECRET || config.jwt.secret;

    if (!secret) {
      res.status(500).json({ error: 'Server misconfiguration: missing JWT secret' });
      return;
    }

    // ─── SHIM: Transition Logic ───────────────────────────────────────────────
    // TODO: remove after MCP Inspector migration confirmed
    if (grant_type === 'authorization_code' && code && !supabase_token) {
      logger.info('[OAuth] Using authorization_code shim');
      supabase_token = code;
    }

    if (grant_type === 'supabase_exchange' || (grant_type === 'authorization_code' && supabase_token)) {
      if (!supabase_token) {
        res.status(400).json({ error: 'invalid_request', error_description: 'Missing supabase_token' });
        return;
      }

      // 1. Verify the Supabase JWT is genuine and unexpired
      let payload;
      try {
        payload = verifyToken(supabase_token);
      } catch (err) {
        res.status(401).json({ error: 'invalid_grant', error_description: 'Invalid or expired Supabase token' });
        return;
      }

      // 2. Re-fetch customer_id from DB — NEVER trust the token payload for authoritative claims
      const user = await authService.getUserProfile(payload.sub as string);
      if (!user || !user.customer_id) {
        res.status(401).json({ error: 'invalid_grant', error_description: 'User or customer not found' });
        return;
      }

      logger.info('[OAuth] Minting MCP token', { userId: user.id, customerId: user.customer_id });

      // 3. Mint the MCP Access Token (8h)
      const mcpAccessToken = jwt.sign(
        {
          sub: user.id,
          customer_id: user.customer_id,
          aud: 'evidentlyaeo-mcp', // Strict custom audience
          scopes: ALL_SCOPES,
        },
        secret,
        { expiresIn: '8h' }
      );

      // 4. Refresh token for the MCP client (30d)
      const mcpRefreshToken = jwt.sign(
        { sub: user.id, customer_id: user.customer_id, type: 'mcp_refresh' },
        secret,
        { expiresIn: '30d' }
      );

      res.json({
        access_token: mcpAccessToken,
        token_type: 'Bearer',
        expires_in: 28800, // 8 hours in seconds
        refresh_token: mcpRefreshToken,
      });
      return;
    }

    if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        res.status(400).json({ error: 'invalid_request', error_description: 'Missing refresh_token parameter' });
        return;
      }

      let refreshPayload;
      try {
        refreshPayload = jwt.verify(refresh_token, secret) as any;
        if (refreshPayload.type !== 'mcp_refresh') throw new Error();
      } catch (err) {
        res.status(401).json({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' });
        return;
      }

      // Re-fetch from DB — do NOT use refreshPayload.customer_id directly
      const user = await authService.getUserProfile(refreshPayload.sub);
      if (!user || !user.customer_id) {
        res.status(401).json({ error: 'invalid_grant', error_description: 'User or customer not found' });
        return;
      }

      // Re-mint MCP tokens
      const mcpAccessToken = jwt.sign(
        { 
          sub: user.id, 
          customer_id: user.customer_id, 
          aud: 'evidentlyaeo-mcp', 
          scopes: ALL_SCOPES 
        },
        secret,
        { expiresIn: '8h' }
      );
      
      const newMcpRefreshToken = jwt.sign(
        { sub: user.id, customer_id: user.customer_id, type: 'mcp_refresh' },
        secret,
        { expiresIn: '30d' }
      );

      res.json({
        access_token: mcpAccessToken,
        token_type: 'Bearer',
        expires_in: 28800, // 8 hours in seconds
        refresh_token: newMcpRefreshToken,
      });
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  } catch (error) {
    console.error('[OAuth Adapter error]', error);
    res.status(500).json({ error: 'server_error' });
  }
});

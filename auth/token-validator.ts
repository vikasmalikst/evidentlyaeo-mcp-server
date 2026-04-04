import jwt from 'jsonwebtoken';
import { McpUserError } from '../utils/response-formatter';
import { config } from '../../config/environment';

export interface McpUserContext {
  userId: string;
  customerId: string;
  scopes: string[];
}

export interface ValidationResult {
  ctx: McpUserContext;
  dbToken: string;
}

/**
 * Validates the custom MCP token from the AI Client, and if strictly valid,
 * mints a short-lived shadow token securely for passing to Supabase PostgREST.
 */
export async function validateTokenAndIssueShadow(rawMcpToken: string): Promise<ValidationResult> {
  const secret = process.env.SUPABASE_JWT_SECRET || config.jwt.secret;

  if (!secret) {
    throw new Error('Server misconfiguration: missing JWT secret');
  }

  // 1. Validate the MCP token signature, expiry, and custom audience
  let mcpPayload: any;
  try {
    mcpPayload = jwt.verify(rawMcpToken, secret, {
      audience: 'evidentlyaeo-mcp', // Strict evaluation
    });
  } catch (error) {
    throw new McpUserError('Invalid, expired, or rejected MCP access token.', 'UNAUTHORIZED');
  }

  // 2. Extract validated claims
  const { sub: userId, customer_id: customerId, scopes: rawScopes } = mcpPayload;
  const scopes = Array.isArray(rawScopes) ? rawScopes : [];

  if (!userId || !customerId) {
    throw new McpUserError('MCP token is missing required user or customer claims.', 'UNAUTHORIZED');
  }

  // 3. ATOMIC ACTION (Post-Validation): Mint the 1-minute Shadow Token
  // This explicitly mimics a Supabase session for PostgREST RLS
  const dbToken = jwt.sign(
    {
      sub: userId,              // Crucial: auth.uid() relies on this
      customer_id: customerId,  // Crucial: RLS tenant filtering relies on this
      aud: 'authenticated',     // Crucial: PostgREST audience check relies on this
      role: 'authenticated',    // Standard Postgres role
      iss: 'supabase',
      exp: Math.floor(Date.now() / 1000) + 60, // Fast 1-min expiry
    },
    secret,
    { algorithm: 'HS256' }
  );

  return {
    ctx: {
      userId,
      customerId,
      scopes,
    },
    dbToken,
  };
}

/**
 * Ensures the token payload holds the necessary execution scopes prior to operating.
 */
export function assertScope(grantedScopes: string[], requiredScope: string): void {
  if (!grantedScopes.includes(requiredScope)) {
    throw new McpUserError(`Missing required scope: ${requiredScope}`, 'MISSING_SCOPE');
  }
}

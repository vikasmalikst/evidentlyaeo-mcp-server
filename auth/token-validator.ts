import jwt from 'jsonwebtoken';
import { McpUserError } from '../utils/response-formatter';
import { config } from '../../config/environment';
import { validateApiKey } from '../../services/api-key.service';

export interface McpUserContext {
  userId: string;
  customerId: string;
  scopes: string[];
}

export interface ValidationResult {
  ctx: McpUserContext;
  dbToken: string;
}

function mintShadowToken(userId: string, customerId: string, secret: string): string {
  return jwt.sign(
    {
      sub: userId,
      customer_id: customerId,
      aud: 'authenticated',
      role: 'authenticated',
      iss: 'supabase',
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    secret,
    { algorithm: 'HS256' }
  );
}

/**
 * Validates either:
 * - an API key (Claude Desktop + local bridges), or
 * - an MCP JWT token minted through OAuth flow.
 *
 * Then returns a strict user context and a 1-minute shadow DB token.
 */
export async function validateTokenAndIssueShadow(rawToken: string): Promise<ValidationResult> {
  const secret = process.env.SUPABASE_JWT_SECRET || config.jwt.secret;

  if (!secret) {
    throw new Error('Server misconfiguration: missing JWT secret');
  }

  // Path A: API key support (eaeo_*)
  if (rawToken.startsWith('eaeo_')) {
    const keyData = await validateApiKey(rawToken);

    if (!keyData) {
      throw new McpUserError('Invalid or expired API key.', 'UNAUTHORIZED');
    }

    const dbToken = mintShadowToken(keyData.userId, keyData.customerId, secret);

    return {
      ctx: {
        userId: keyData.userId,
        customerId: keyData.customerId,
        scopes: keyData.scopes,
      },
      dbToken,
    };
  }

  // Path B: Existing MCP OAuth JWT support
  let mcpPayload: any;
  try {
    mcpPayload = jwt.verify(rawToken, secret, {
      audience: 'evidentlyaeo-mcp',
    });
  } catch (error) {
    throw new McpUserError('Invalid, expired, or rejected MCP access token.', 'UNAUTHORIZED');
  }

  const { sub: userId, customer_id: customerId, scopes: rawScopes } = mcpPayload;
  const scopes = Array.isArray(rawScopes) ? rawScopes : [];

  if (!userId || !customerId) {
    throw new McpUserError('MCP token is missing required user or customer claims.', 'UNAUTHORIZED');
  }

  const dbToken = mintShadowToken(userId, customerId, secret);

  return {
    ctx: {
      userId,
      customerId,
      scopes,
    },
    dbToken,
  };
}

export function assertScope(grantedScopes: string[], requiredScope: string): void {
  if (!grantedScopes.includes(requiredScope)) {
    throw new McpUserError(`Missing required scope: ${requiredScope}`, 'MISSING_SCOPE');
  }
}

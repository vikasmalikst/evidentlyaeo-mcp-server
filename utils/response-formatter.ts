/**
 * Caller made a bad request or lacks permission. Safe to expose message to AI client.
 */
export class McpUserError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'McpUserError';
  }
}

/**
 * Internal/infrastructure failure. Never expose internal details to AI client.
 */
export class McpSystemError extends Error {
  constructor(message: string, public internalDetail?: string) {
    super(message);
    this.name = 'McpSystemError';
  }
}

/**
 * Formats a successful response payload for the MCP protocol.
 */
export function successResponse(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    isError: false,
  };
}

/**
 * Formats an error response payload for the MCP protocol, ensuring
 * system details never leak.
 */
export function errorResponse(err: unknown) {
  if (err instanceof McpUserError) {
    // Safe: expose to client — their mistake
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              error: true,
              code: err.code,
              message: err.message,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  // System error: log internally but return a generic message to the client
  const detail = err instanceof McpSystemError ? err.internalDetail : String(err);
  console.error('[MCP System Error]', err instanceof Error ? err.message : 'Unknown error', detail);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            error: true,
            code: 'INTERNAL_ERROR',
            message: 'An internal error occurred. Please try again later.',
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

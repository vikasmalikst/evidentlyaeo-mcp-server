const PRETTY = process.env.MCP_PRETTY_JSON === 'true';
const stringify = (d: unknown) => (PRETTY ? JSON.stringify(d, null, 2) : JSON.stringify(d));

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
 * Wraps all successful tool responses in a grounding envelope.
 * The envelope explicitly tells the LLM: this is real data, report only this.
 */
export function successResponse(data: unknown) {
  const envelope = {
    status: 'success',
    data_is_real: true,
    data_source: 'EvidentlyAEO platform — live database values, not estimates',
    generated_at: new Date().toISOString(),
    agent_instruction:
      'You MUST report only the values present in the "result" field below. ' +
      'Do NOT add industry benchmarks, estimates, or comparisons not present in this data. ' +
      'If a value is null or missing, say "data not available" — never guess.',
    result: data,
  };
  return {
    content: [{ type: 'text' as const, text: stringify(envelope) }],
    isError: false,
  };
}

/**
 * Wraps error responses and tells the LLM to NOT guess the answer.
 */
export function errorResponse(err: unknown) {
  if (err instanceof McpUserError) {
    return {
      content: [
        {
          type: 'text' as const,
          text: stringify({
            status: 'error',
            data_is_real: false,
            agent_instruction:
              'A user-facing error occurred. Inform the user exactly as described in "message". Do NOT guess or infer the answer.',
            code: err.code,
            message: err.message,
          }),
        },
      ],
      isError: true,
    };
  }

  const detail = err instanceof McpSystemError ? err.internalDetail : String(err);
  console.error('[MCP System Error]', err instanceof Error ? err.message : 'Unknown error', detail);

  return {
    content: [
      {
        type: 'text' as const,
        text: stringify({
          status: 'error',
          data_is_real: false,
          agent_instruction:
            'An internal server error occurred. Tell the user the data could not be retrieved and ask them to retry. Do NOT infer or estimate the answer.',
          code: 'INTERNAL_ERROR',
          message: 'An internal error occurred. Please try again later.',
        }),
      },
    ],
    isError: true,
  };
}

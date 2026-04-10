/**
 * MCP Prompt Definitions
 * These are pre-built prompts users can invoke directly in Claude
 * using the /prompt command or Prompt menu.
 */

export const PROMPTS = [
  {
    name: 'aeo-expert',
    description:
      'Activates AEO expert mode. Claude will analyze your brand\'s AI search performance, ' +
      'identify gaps, and provide data-backed strategic recommendations. Always fetches live data first.',
    arguments: [
      {
        name: 'brandId',
        description: 'The UUID of the brand to analyze. Get this from brands_list.',
        required: true,
      },
      {
        name: 'focus',
        description: 'Optional focus area: "visibility", "competitors", "sentiment", "recommendations", or "all".',
        required: false,
      },
    ],
    getMessages: (args: Record<string, string>) => [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text:
            `You are an expert AEO (Answer Engine Optimization) analyst. ` +
            `Analyze brand ID: ${args.brandId}. ` +
            `Focus area: ${args.focus || 'all'}. ` +
            `Steps: ` +
            `1. Call dashboard_get_summary to get core KPIs. ` +
            `2. Call dashboard_list_competitors to identify competitive gaps. ` +
            `3. Call recommendations_list to get strategic actions. ` +
            `4. Synthesize ONLY the data returned — no external knowledge. ` +
            `5. Present a structured analysis: Current State → Gaps → Top 3 Actions.`,
        },
      },
    ],
  },
  {
    name: 'quick-summary',
    description:
      'Returns a concise 5-bullet performance summary for a brand using only real platform data.',
    arguments: [
      {
        name: 'brandId',
        description: 'The UUID of the brand to summarize.',
        required: true,
      },
    ],
    getMessages: (args: Record<string, string>) => [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text:
            `Give me a 5-bullet performance summary for brand ID: ${args.brandId}. ` +
            `Call dashboard_get_summary first. ` +
            `Use ONLY the data returned. ` +
            `Format: • [Metric]: [Value] — [one-line interpretation]. ` +
            `If any metric is null, write: • [Metric]: No data available this period.`,
        },
      },
    ],
  },
  {
    name: 'data-only',
    description:
      'Strict data-only mode. Claude will return raw numbers with zero interpretation or commentary.',
    arguments: [
      {
        name: 'brandId',
        description: 'The UUID of the brand to query.',
        required: true,
      },
      {
        name: 'tool',
        description: 'Which tool to call: "summary", "competitors", "llm", "queries", "citations", "recommendations", "domain".',
        required: true,
      },
    ],
    getMessages: (args: Record<string, string>) => [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text:
            `DATA-ONLY MODE. Brand ID: ${args.brandId}. Tool: ${args.tool}. ` +
            `Call the requested tool and return ONLY the raw JSON result. ` +
            `No interpretation, no commentary, no recommendations. ` +
            `Just the exact data structure returned by the tool.`,
        },
      },
    ],
  },
];

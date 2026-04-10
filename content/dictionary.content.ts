/**
 * MCP Metric Dictionary Resource
 * Registered as a static MCP Resource so Claude can reference definitions
 * without consuming tool call budget.
 */

export const DICTIONARY_URI = 'evidentlyaeo://dictionary/metrics';
export const DICTIONARY_MIME = 'text/plain';

export const METRIC_DICTIONARY = `
EvidentlyAEO Metric Definitions
================================

SEARCH VISIBILITY (%)
  What it is: The percentage of tracked AI queries where this brand appeared in at least one AI-generated response.
  Scale: 0–100%. Higher is better.
  What NULL means: No responses were collected in this period. Do not treat as 0%.

SHARE OF VOICE / SHARE OF ANSWER (SOA) (%)
  What it is: Of all AI responses that mentioned ANY brand in this category, what percentage mentioned THIS brand.
  This is different from Search Visibility. SOA measures competitive share, not raw presence.
  Scale: 0–100%. A brand with 40% SOA is mentioned in 40% of all brand-mentioning responses.
  What NULL means: No competitive data collected. Do not estimate.

BRAND PRESENCE RATE (%)
  What it is: Percentage of tracked prompts where this brand was mentioned at least once.
  Difference from Visibility: Visibility counts unique queries; Presence Rate counts total prompt volume.

SENTIMENT SCORE (0–100)
  What it is: Average positivity of brand mentions across all AI responses. 
  50 = neutral. Above 70 = positive. Below 40 = negative.
  What NULL means: Sentiment analysis was not run on this data period.

BLIND QUERIES
  What they are: Queries that do not contain any brand name — purely category or problem-based.
  Example: "best CRM software for startups"
  Why important: High visibility on blind queries = strong unprompted brand recognition.

BRAND QUERIES
  What they are: Queries that explicitly mention this brand by name.
  Example: "what is EvidentlyAEO used for"

COMPETITOR QUERIES
  What they are: Queries that mention a competitor's brand name.
  Example: "how does Ahrefs compare to other SEO tools"

IMPACT SCORE (0–100)
  What it is: EvidentlyAEO's internal estimate of how much acting on a recommendation would improve metrics.
  100 = highest possible impact. Not a percentage.

DOMAIN READINESS SCORE
  What it is: A composite score measuring how well the brand's website is structured for AI engine citation.
  Factors include: structured data, content clarity, topical authority signals, and technical SEO.

NULL VALUES
  A null value ALWAYS means: no data was collected for this metric in the selected date range.
  null is NEVER equivalent to 0, low, or absent performance.
  When you see null, tell the user: "No data available for [metric] in this period."
`.trim();

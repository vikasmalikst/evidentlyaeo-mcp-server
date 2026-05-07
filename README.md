# EvidentlyAEO MCP Server

This is the Model Context Protocol (MCP) server for **EvidentlyAEO**, the premier AI Engine Optimization (AEO) analytics platform.

This server allows AI models (like Claude) to connect directly to your EvidentlyAEO brand data to analyze visibility, share of answer, citation intelligence, and competitive gaps.

## Features

- **Brand Intelligence**: List brands and get dashboard summaries.
- **Query Intelligence**: Analyze how your brand performs on specific AI search queries (blind vs. brand).
- **Citation Intelligence**: Identify which sources are citing you and where competitors have a gap.
- **Recommendations**: Get actionable AI-driven optimization advice.

## Architecture

This repository contains the MCP layer and tool definitions. For security and privacy:
- Proprietary business logic services are referenced but not included in this public repository.
- Authentication is handled via API Keys or OAuth shadow tokens.
- All database interactions are performed through environment-configured clients.
- Tool descriptions are optimized for Anthropic/Claude compliance, using declarative parameters instead of behavioral instructions.

## Tool Architecture & Usage

The EvidentlyAEO MCP server follows a tiered tool design. While AI models naturally discover the correct sequence based on parameter requirements, the intended analytical flow is as follows:

### 1. Brand & Dashboard (Entry Points)
- **`brands_list`**: Always call this first if you do not have a `brandId`.
- **`dashboard_get_summary`**: Provides the top-level KPIs for a brand.
- **`dashboard_list_competitors`**: Shows the competitive landscape at the brand level.

### 2. Query Intelligence
- **`queries_summary`**: The primary tool for query-level metrics (Visibility, SOA, Presence). Use this for any "top queries" or "blind vs brand" analysis.
- **`queries_competitor_overlap`**: Used specifically for competitive gap analysis on tracked queries.
- **`queries_trend`**: Returns pre-computed period-over-period performance changes.
- **`queries_collector_breakdown`**: A specialized tool for engine-specific data (ChatGPT vs Perplexity) for a single query.

### 3. Citation Intelligence
- **`citations_top_sources`**: The starting point for citation analysis.
- **`citations_competitor_gap`**: Identifies specific domains that cite competitors but not the brand.
- **`citations_source_detail`**: Provides deep analytics for a single specific referring domain.
- **`citations_trend`**: Tracks citation growth and sentiment changes over time.

### 4. Recommendations & Audit
- **`recommendations_list`**: Returns prioritized optimization advice.
- **`recommendations_get_detail`**: Provides a step-by-step action plan for a specific recommendation.
- **`domain_readiness_get_audit`**: Analyzes technical SEO/AEO signals (Schema, Speed, Structure) for the brand's website.


## Getting Started

### Prerequisites

- Node.js 18+
- An EvidentlyAEO account and API Key.

### Installation

```bash
npm install
npm run build
```

### Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
SUPABASE_URL=your_project_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SUPABASE_JWT_SECRET=your_jwt_secret
```

## License

MIT License. See [LICENSE](LICENSE) for details.

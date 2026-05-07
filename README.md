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

The EvidentlyAEO MCP server provides a comprehensive suite of tools organized into functional tiers for deep AEO analysis:

### Brand & Dashboard
Entry-point tools for broad brand performance:
- **`brands_list`**: Returns all brands associated with the authenticated account.
- **`dashboard_get_summary`**: Retrieves top-level KPI summaries including visibility score, sentiment score, and top topics.
- **`dashboard_list_competitors`**: Provides a brand-level competitive landscape comparison.

### Query Intelligence
Tools for analyzing performance on tracked search prompts:
- **`queries_summary`**: Aggregated performance metrics (Visibility, SOA, Presence) at the query level, filterable by type (blind vs. brand).
- **`queries_competitor_overlap`**: Detailed comparison of visibility gaps between the brand and competitors for specific queries.
- **`queries_trend`**: Pre-computed period-over-period changes in query performance.
- **`queries_collector_breakdown`**: Engine-specific performance (e.g., ChatGPT vs. Perplexity) for a single query.

### Citation Intelligence
Tools for mapping the brand's presence across the web:
- **`citations_top_sources`**: Ranking of citation sources by impact score and category.
- **`citations_competitor_gap`**: Identification of domains citing competitors but not the primary brand.
- **`citations_source_detail`**: Granular citation analytics for a specific domain.
- **`citations_trend`**: Growth and sentiment trends for citation sources over time.

### Recommendations & Audit
Tools for actionable optimization and technical readiness:
- **`recommendations_list`**: Prioritized list of strategic AEO improvements.
- **`recommendations_get_detail`**: Full action plan and supporting evidence for a specific recommendation.
- **`domain_readiness_get_audit`**: Technical audit of SEO/AEO signals including schema markup and structured data coverage.

## Privacy Policy

EvidentlyAEO is committed to data privacy and security.

### Data Collection & Usage
This MCP server processes data necessary to provide AEO analytics, including brand identifiers, query performance metrics, and citation data. All data is retrieved from the EvidentlyAEO platform on behalf of the authenticated user.

### Storage & Retention
User data is stored securely and retained only as long as necessary to provide analytical services or as required by legal obligations. We do not store conversation history from the AI model.

### Third-Party Sharing
We do not sell user data to third parties. Data is shared with sub-processors only to the extent necessary to provide the service (e.g., database hosting).

### Contact Information
For privacy-related inquiries, please contact us at support@evidentlyaeo.com.


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

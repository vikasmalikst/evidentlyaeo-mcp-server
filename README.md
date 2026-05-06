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

<div align="center">
  <h1>@cyanheads/congressgov-mcp-server</h1>
  <p><b>Access U.S. congressional data - bills, votes, members, committees - through MCP. STDIO & Streamable HTTP.</b>
  <div>10 Tools • 5 Resources • 2 Prompts</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/congressgov-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/congressgov-mcp-server) [![Version](https://img.shields.io/badge/Version-0.3.6-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.27.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/)

[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

**Public Hosted Server:** [https://congressgov.caseyjhand.com/mcp](https://congressgov.caseyjhand.com/mcp)

</div>

---

## Tools

Ten read-only tools for querying U.S. legislative data:

| Tool | Description |
|:---|:---|
| `congressgov_bill_lookup` | Browse and retrieve U.S. legislative bill data — actions, sponsors, summaries, text, related bills |
| `congressgov_enacted_laws` | Browse enacted public and private laws by congress |
| `congressgov_member_lookup` | Discover congressional members by state/district/congress, retrieve legislative portfolios |
| `congressgov_committee_lookup` | Browse congressional committees and their legislation, reports, and nominations |
| `congressgov_roll_votes` | Retrieve House roll call vote data and individual member voting positions |
| `congressgov_senate_nominations` | Browse presidential nominations to federal positions and track the Senate confirmation process |
| `congressgov_bill_summaries` | Browse recent CRS bill summaries — the "what's happening" feed |
| `congressgov_crs_reports` | Browse and retrieve nonpartisan CRS policy analysis reports |
| `congressgov_committee_reports` | Browse and retrieve committee reports accompanying legislation |
| `congressgov_daily_record` | Browse the daily Congressional Record — floor speeches, debates, and proceedings |

### `congressgov_bill_lookup`

Browse and retrieve U.S. legislative bill data from Congress.gov.

- Filter by congress number, bill type, and date range
- Retrieve detailed sub-resources: actions, amendments, committees, cosponsors, related bills, subjects, summaries, text versions, and titles
- Pagination support for browsing large result sets

---

### `congressgov_member_lookup`

Discover congressional members and their legislative activity.

- Browse by state, district, congress number, and chamber
- Retrieve a member's sponsored and cosponsored legislation
- Look up specific members by bioguide ID

---

### `congressgov_committee_lookup`

Browse congressional committees and their legislation, reports, and nominations.

- Filter by chamber (House, Senate, Joint)
- Retrieve committee bills, reports, and nominations
- Look up specific committees by committee code

---

### `congressgov_roll_votes`

Retrieve House roll call vote data and individual member voting positions.

- Browse roll call votes by congress and session
- Retrieve individual member voting positions per roll call

---

### `congressgov_bill_summaries`

Browse recent CRS bill summaries.

- Filter by congress and bill type
- Browse chronologically to see what's moving through Congress

---

### `congressgov_crs_reports`

Browse and retrieve CRS reports — nonpartisan policy analyses written by subject-matter experts at the Library of Congress.

- Browse the full report catalog
- Retrieve individual reports by product number

---

### `congressgov_daily_record`

Browse the daily Congressional Record — floor speeches, debates, and legislative text published each day Congress is in session.

- Browse volumes by congress number
- Retrieve specific issue articles

## Resources

| URI Pattern | Description |
|:---|:---|
| `congress://current` | Current congress number, session dates, chamber info |
| `congress://bill-types` | Reference table of valid bill type codes |
| `congress://member/{bioguideId}` | Member profile by bioguide ID |
| `congress://bill/{congress}/{billType}/{billNumber}` | Bill detail by congress, type, and number |
| `congress://committee/{committeeCode}` | Committee detail by committee code |

## Prompts

| Prompt | Description |
|:---|:---|
| `congressgov_bill_analysis` | Structured framework for analyzing a bill |
| `congressgov_legislative_research` | Research framework for a policy area across Congress |

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) or in Docker from the same codebase

Congress.gov-specific:

- Type-safe client for the Congress.gov REST API v3
- Authentication via free API key from [api.data.gov](https://api.data.gov/signup/)
- Automatic pagination and response normalization
- Rate limiting awareness (5,000 requests/hour per key)
- All tools are read-only and idempotent

## Getting started

### Public Hosted Instance

A public instance is available at `https://congressgov.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "congressgov-mcp-server": {
      "type": "streamable-http",
      "url": "https://congressgov.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "congressgov-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/congressgov-mcp-server@latest"],
      "env": {
        "CONGRESS_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "congressgov-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/congressgov-mcp-server@latest"],
      "env": {
        "CONGRESS_API_KEY": "your-api-key"
      }
    }
  }
}
```

Get a free API key at [api.data.gov/signup](https://api.data.gov/signup/) (5,000 requests/hour).

### Prerequisites

- [Bun v1.3.2](https://bun.sh/) or higher.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/congressgov-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd congressgov-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `CONGRESS_API_KEY` | **Required.** API key from [api.data.gov](https://api.data.gov/signup/) | — |
| `CONGRESS_API_BASE_URL` | Congress.gov API base URL | `https://api.congress.gov/v3` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

## Running the server

### Local development

- **Build and run the production version:**

  ```sh
  bun run rebuild
  bun run start:http   # or start:stdio
  ```

- **Run checks and tests:**
  ```sh
  bun run devcheck     # Lints, formats, type-checks
  bun run test         # Runs test suite
  ```

### Docker

```sh
docker build -t congressgov-mcp-server .
docker run -e CONGRESS_API_KEY=your-api-key -p 3010:3010 congressgov-mcp-server
```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). Ten Congress.gov tools. |
| `src/mcp-server/resources/definitions/` | Resource definitions. Congress, bill, member, and committee resources. |
| `src/mcp-server/prompts/definitions/` | Prompt definitions. Bill analysis and legislative research prompts. |
| `src/services/congress-api/` | Congress.gov API client — auth, pagination, rate limiting. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- All tools are read-only with `readOnlyHint: true` and `idempotentHint: true`

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

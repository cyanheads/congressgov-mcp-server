<div align="center">
  <h1>@cyanheads/congressgov-mcp-server</h1>
  <p><b>Access U.S. congressional data - bills, votes, members, committees - through MCP. STDIO & Streamable HTTP.</b>
  <div>11 Tools • 5 Resources • 2 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/congressgov-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/congressgov-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/congressgov-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/congressgov-mcp-server/releases/latest/download/congressgov-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=congressgov-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY29uZ3Jlc3Nnb3YtbWNwLXNlcnZlciJdLCJlbnYiOnsiQ09OR1JFU1NfQVBJX0tFWSI6InlvdXItYXBpLWtleSJ9fQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22congressgov-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/congressgov-mcp-server%22%5D%2C%22env%22%3A%7B%22CONGRESS_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://congressgov.caseyjhand.com/mcp](https://congressgov.caseyjhand.com/mcp)

</div>

---

## Tools

Eleven read-only tools for querying U.S. legislative data:

| Tool | Description |
|:---|:---|
| `congressgov_bill_lookup` | Browse and retrieve U.S. legislative bill data — actions, sponsors, summaries, text, related bills |
| `congressgov_enacted_laws` | Browse enacted public and private laws by congress |
| `congressgov_member_lookup` | Discover congressional members by state/district/congress, retrieve legislative portfolios |
| `congressgov_committee_lookup` | Browse congressional committees and their legislation, reports, and nominations |
| `congressgov_roll_votes` | Retrieve House and Senate roll call votes and individual member voting positions |
| `congressgov_senate_nominations` | Browse presidential nominations to federal positions and track the Senate confirmation process |
| `congressgov_bill_summaries` | Browse recent CRS bill summaries — the "what's happening" feed |
| `congressgov_crs_reports` | Browse and retrieve nonpartisan CRS policy analysis reports |
| `congressgov_committee_reports` | Browse and retrieve committee reports accompanying legislation |
| `congressgov_daily_record` | Browse the daily Congressional Record — floor speeches, debates, and proceedings |
| `congressgov_search_bills` | Keyword-search bill titles and CRS summaries via a local full-text mirror (opt-in, off by default) |

### `congressgov_bill_lookup`

Browse and retrieve U.S. legislative bill data from Congress.gov.

- Filter by congress number, bill type, and update-date range
- Retrieve detailed sub-resources: actions, amendments, committees, cosponsors, related bills, subjects, summaries, text versions, and titles
- `list` defaults to `order='recent'` (newest update-date first); pass `order='oldest'` for ascending
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
- Detail and sub-resource lookups need only `committeeCode` — `chamber` is auto-detected from the code
- Committee bills default to `order='recent'` (newest-first); pass `order='oldest'` for ascending update-date order

---

### `congressgov_roll_votes`

Retrieve House and Senate roll call votes and individual member voting positions.

- Set `chamber` to `house` (default, from the Congress.gov API) or `senate` (from the Senate's official LIS feed — the API exposes no Senate votes)
- `list` browses votes by congress and session, newest first; pass `order='oldest'` for ascending
- `get` returns the question, result, tallies, party breakdown, and associated bill/nomination/amendment
- `members` returns each member's recorded position

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

---

### `congressgov_search_bills`

Keyword-search bill titles and CRS summaries against a local full-text mirror — the discovery path the Congress.gov API itself lacks.

- **Opt-in:** off by default. Requires `CONGRESS_MIRROR_ENABLED=true` and a locally built index (`bun run mirror:init`) — until then the tool is visible but not callable
- Narrow with `congress`, `billType`, and `originChamber` filters
- Returns BM25-ranked matches with each bill's derived id, ready for a follow-up `congressgov_bill_lookup` call

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
- Optional API key from [api.data.gov](https://api.data.gov/signup/) — defaults to `DEMO_KEY` (30 req/hr); own key gets 5,000 req/hr
- Automatic pagination and response normalization
- Rate limiting awareness
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

Get a free API key at [api.data.gov/signup](https://api.data.gov/signup/) for 5,000 req/hr. Without a key the server falls back to `DEMO_KEY` (30 req/hr).

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
| `CONGRESS_API_KEY` | Optional. API key from [api.data.gov](https://api.data.gov/signup/). Omit to use `DEMO_KEY` (30 req/hr); own key: 5,000 req/hr. | `DEMO_KEY` |
| `CONGRESS_API_BASE_URL` | Congress.gov API base URL | `https://api.congress.gov/v3` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs) | `false` |

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
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). Eleven Congress.gov tools. |
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

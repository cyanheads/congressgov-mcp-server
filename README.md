<div align="center">
  <h1>@cyanheads/congressgov-mcp-server</h1>
  <p><b>Access U.S. congressional data - bills, votes, members, committees - through MCP. STDIO & Streamable HTTP.</b>
  <div>11 Tools • 5 Resources • 2 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.7.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/congressgov-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/congressgov-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/congressgov-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/congressgov-mcp-server/releases/latest/download/congressgov-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=congressgov-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY29uZ3Jlc3Nnb3YtbWNwLXNlcnZlciJdLCJlbnYiOnsiQ09OR1JFU1NfQVBJX0tFWSI6InlvdXItYXBpLWtleSJ9fQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22congressgov-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/congressgov-mcp-server%22%5D%2C%22env%22%3A%7B%22CONGRESS_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://congressgov.caseyjhand.com/mcp](https://congressgov.caseyjhand.com/mcp)

</div>

---

## Overview

U.S. congressional data from the Congress.gov API v3 and the Senate's official vote feed — bills, enacted laws, members, committees, roll call votes, and presidential nominations. Browse legislative activity, read bill and report text, and track the Senate confirmation pipeline from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

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

### Resources

| Resource | Description |
|:---|:---|
| `congress://current` | Current congress number, session dates, chamber info |
| `congress://bill-types` | Reference table of valid bill type codes |
| `congress://member/{bioguideId}` | Member profile by bioguide ID |
| `congress://bill/{congress}/{billType}/{billNumber}` | Bill detail by congress, type, and number |
| `congress://committee/{committeeCode}` | Committee detail by committee code |

Bill, member, and committee data is also reachable through `congressgov_bill_lookup`, `congressgov_member_lookup`, and `congressgov_committee_lookup` (operation `get`) — many MCP clients are tool-only and never surface resources.

### Prompts

| Prompt | Description |
|:---|:---|
| `congressgov_bill_analysis` | Structured framework for analyzing a bill |
| `congressgov_legislative_research` | Research framework for a policy area across Congress |

## Capability reference

### `congressgov_bill_lookup` <sub>tool</sub>

- Operations: `list` (browse by congress/billType/date range — no keyword search), `get` (full detail), or drill into `actions`, `amendments`, `cosponsors`, `committees`, `subjects`, `summaries`, `text`, `titles`, `related`
- `list` defaults to `order='recent'` (newest update-date first); `limit` 1–250, `offset` pagination
- `content` reads a text version's actual document text: select the version with `textVersionIndex` (0-based, against `text`'s order), the window with `characterOffset`/`characterLimit` (1–100,000 chars, default 25,000), and follow `nextOffset` to walk a full bill
- Typed failures on `content`: `document_unavailable`, `format_unavailable`, `document_fetch_failed`, `document_too_large`, `offset_past_end`, alongside the shared `not_found` / `rate_limited` / `invalid_request` / `upstream_error` set

---

### `congressgov_enacted_laws` <sub>tool</sub>

- `list` filters by congress and `lawType` (`pub` public laws, `priv` private) — the enactment-status filter `congressgov_bill_lookup` doesn't offer
- `get` returns the origin bill record; the law citation lives on the bill's `laws[]` array (e.g. `{"number":"118-2","type":"Public Law"}`)
- `lawNumber` accepts either the bare number (`90`) or the full `{congress}-{number}` citation a `list` row carries; a citation naming a different congress than the `congress` param is rejected rather than silently resolved
- `limit` 1–250, `offset` pagination for `list`

---

### `congressgov_member_lookup` <sub>tool</sub>

- No name search — `list` filters by `stateCode` (+ optional `district`, which requires `stateCode`), `congress`, and `currentMember`
- `get` returns the full profile by `bioguideId` (e.g. `P000197`); `sponsored`/`cosponsored` return that member's legislative portfolio
- `limit` 1–250, `offset` pagination

---

### `congressgov_committee_lookup` <sub>tool</sub>

- Committee codes are chamber-prefix (`h`/`s`/`j`) + abbreviation + 2-digit number (e.g. `hsju00`); `get` and sub-resources infer chamber from the prefix, or accept an explicit override
- `committeeCode` also accepts a committee name, resolved automatically (all-token match, then a bigram-similarity fallback labeled `approximate: true`) against the full cross-chamber roster
- `list` with `filter` name-matches the same way, paging past the 250-row upstream cap to search the complete roster before filtering
- `bills` sub-resource defaults to `order='recent'` (newest update-date first, computed client-side since upstream ignores sort); rows carry no titles — chain `congressgov_bill_lookup get` per row
- `nominations` sub-resource is Senate-only

---

### `congressgov_roll_votes` <sub>tool</sub>

- `chamber` is `house` (default, Congress.gov API) or `senate` (the Senate's official LIS XML feed — the API exposes no Senate votes)
- `list` browses by congress + session (1 or 2), newest-first by default (computed client-side for strict ordering); `get` returns tallies and party breakdown, `members` returns each member's recorded position
- Roll call numbers reset each session and are specific to one chamber
- `limit` 1–250, `offset` pagination for `list` and `members`

---

### `congressgov_senate_nominations` <sub>tool</sub>

- Nominations use `PN` numbering; `list` browses by congress, `get` returns detail, `actions`/`committees`/`hearings` cover the confirmation pipeline, `nominees` returns individuals in a batch (requires `ordinal`)
- Multi-part parents (e.g. `PN851`) carry no activity of their own — sub-resources live on partitioned children (`851-1`, `851-2`, …); a bare-parent sub-resource call on such a nomination returns an enrichment notice pointing at the partitioned form
- `ordinal` is discovered from the nomination's `nominees` array via `get` first

---

### `congressgov_bill_summaries` <sub>tool</sub>

- Filters by `congress` and `billType` (requires `congress`); date filters apply to the CRS summary's update time, not the bill's action date
- Defaults to summaries updated in the last 7 days when neither date bound is supplied
- For summaries of one specific bill, use `congressgov_bill_lookup` with `operation='summaries'` instead

---

### `congressgov_crs_reports` <sub>tool</sub>

- Report IDs use letter-number codes (e.g. `R40097`, `RL33612`, `IF12345`)
- `list` browses the catalog; `get` returns full detail (authors, topics, summary, download formats) by `reportNumber`
- `limit` 1–250, `offset` pagination for `list`

---

### `congressgov_committee_reports` <sub>tool</sub>

- Report types: `hrpt` (House), `srpt` (Senate), `erpt` (Executive); `list` browses by congress + optional `reportType`, `get` returns citation/title/committees/associated bill
- `text` lists each format's `{type, url}` link (report formats arrive one per entry, unlike bill text versions); `content` then reads the actual text, a bounded character window at a time via `characterOffset`/`characterLimit` (1–100,000 chars, default 25,000)
- Typed failures on `content`: `document_unavailable`, `format_unavailable`, `document_fetch_failed`, `document_too_large`, `offset_past_end`

---

### `congressgov_daily_record` <sub>tool</sub>

- Hierarchical navigation: `list` (volumes) → `issues` (within a volume) → `articles` (within an issue)
- `content` reads one article's text, selected by `articleIndex` (0-based) and bounded by `characterOffset`/`characterLimit`; the Congressional Record publishes Formatted Text and PDF only (no XML)
- Typed failures on `content`: `document_unavailable`, `format_unavailable`, `document_fetch_failed`, `document_too_large`, `offset_past_end`

---

### `congressgov_search_bills` <sub>tool</sub>

- **Opt-in:** off by default and absent from `tools/list` entirely until `CONGRESS_MIRROR_ENABLED=true`
- Keyword-searches a local SQLite FTS5 mirror of bill titles + CRS summaries — the discovery path the Congress.gov API itself lacks; policy area and full bill text are not indexed
- Narrows with `congress`, `billType`, and `originChamber`; returns BM25-ranked matches with each bill's derived id, ready for a follow-up `congressgov_bill_lookup` call
- With the flag set but the index not yet built (`bun run mirror:init`), the tool answers with an empty result and a build-the-index notice instead of an error
- `limit` 1–100 (a narrower cap than the other tools' 1–250), `offset` pagination

---

### `congress://current` <sub>resource</sub>

- Current congress number, session dates, and chamber info — baseline context for other queries
- Cached publicly for 1 hour

---

### `congress://bill-types` <sub>resource</sub>

- Static reference table of the 8 valid bill type codes (`hr`, `s`, `hjres`, `sjres`, `hconres`, `sconres`, `hres`, `sres`) with chamber and an example citation
- Cached publicly for 24 hours — fixed by chamber rules, not fetched upstream

---

### `congress://member/{bioguideId}` <sub>resource</sub>

- `bioguideId` must match one uppercase letter followed by 6 digits (e.g. `P000197`)
- Returns the member profile — name, state, party, terms, leadership, office, legislation counts

---

### `congress://bill/{congress}/{billType}/{billNumber}` <sub>resource</sub>

- `congress` and `billNumber` must be positive integers; `billType` must be a valid bill type code
- Returns bill detail — sponsor, status, policy area, committees, latest action

---

### `congress://committee/{committeeCode}` <sub>resource</sub>

- `committeeCode` must match `h`/`s`/`j` followed by 3–8 lowercase alphanumeric characters (e.g. `hsju00`); chamber is inferred from the first letter
- Returns committee detail — name, chamber, subcommittees, history, legislation counts

---

### `congressgov_bill_analysis` <sub>prompt</sub>

- Arguments: `congress`, `billType`, `billNumber` — all required strings
- Returns one user message framing a structured analysis (summary, sponsors, committee referrals, action timeline, related legislation, policy implications, outlook) and naming which tools to call for each section

---

### `congressgov_legislative_research` <sub>prompt</sub>

- Arguments: `topic` required; `congress` optional (defaults to the current congress)
- The discovery plan is configuration-aware: with `CONGRESS_MIRROR_ENABLED` it opens with `congressgov_search_bills`; without it, it asks for a seed (a bill, member, committee, or CRS report id) since no registered tool accepts a topic string
- Synthesizes findings into landscape, key players, substance, recent activity, and outlook

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Congress.gov-specific:

- Type-safe client for the Congress.gov REST API v3, plus a second client for the Senate's official LIS XML feed (`fast-xml-parser`) backing Senate roll votes
- Optional API key from [api.data.gov](https://api.data.gov/signup/) — defaults to `DEMO_KEY` (30 req/hr); own key gets 5,000 req/hr
- Bounded document-text retrieval for bill text, committee reports, and Congressional Record articles — a 25 MB fetch ceiling, 30s deadline, and a `www.congress.gov` host allowlist
- Opt-in local SQLite FTS5 mirror (`CONGRESS_MIRROR_ENABLED`) adds keyword search over bill titles and CRS summaries, the one discovery path the API itself lacks
- All tools are read-only and idempotent

Agent-friendly output:

- Effective-query echo and total-count enrichment on every browse/list operation, plus a notice when a query resolves to zero matches or an offset runs past the end
- Character-exact document windows — `content` operations return `offset`/`nextOffset` so walking a multi-megabyte bill or report never skips or repeats a character
- Typed failure reasons on document reads (`document_unavailable`, `format_unavailable`, `document_too_large`, `offset_past_end`, …) alongside the shared upstream-error set, each resolved to a recovery hint

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
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
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
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "CONGRESS_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "congressgov-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "CONGRESS_API_KEY=your-api-key",
        "ghcr.io/cyanheads/congressgov-mcp-server:latest"
      ]
    }
  }
}
```

Get a free API key at [api.data.gov/signup](https://api.data.gov/signup/) for 5,000 req/hr. Without a key the server falls back to `DEMO_KEY` (30 req/hr).

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 CONGRESS_API_KEY=your-api-key bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

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

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set required vars
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `CONGRESS_API_KEY` | API key from [api.data.gov](https://api.data.gov/signup/). Omit to use `DEMO_KEY` (30 req/hr); own key: 5,000 req/hr. | `DEMO_KEY` |
| `CONGRESS_API_BASE_URL` | Congress.gov API base URL. | `https://api.congress.gov/v3` |
| `CONGRESS_MIRROR_ENABLED` | Enable the local bill search mirror and the `congressgov_search_bills` tool. | `false` |
| `CONGRESS_MIRROR_PATH` | Filesystem path to the SQLite mirror index. | `.mirror/bills.sqlite3` |
| `CONGRESS_MIRROR_REFRESH_CRON` | Cron schedule for the in-process mirror refresh (HTTP transport only). Unset runs `mirror:refresh` manually. | — |
| `CONGRESS_MIRROR_CONGRESSES` | Comma-separated congress numbers to mirror (e.g. `118,119`). | current congress + 1 prior |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`; `auto` resolves to `stateful`. | `stateless` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version:**

  ```sh
  bun run rebuild
  bun run start:http   # or start:stdio
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t congressgov-mcp-server .
docker run --rm -e CONGRESS_API_KEY=your-api-key -p 3010:3010 congressgov-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/congressgov-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts and inits services. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`) — eleven Congress.gov tools. |
| `src/mcp-server/resources/definitions/` | Resource definitions (`*.resource.ts`) — congress, bill, member, and committee resources. |
| `src/mcp-server/prompts/definitions/` | Prompt definitions (`*.prompt.ts`) — bill analysis and legislative research. |
| `src/services/congress-api/` | Congress.gov API client — auth, pagination, rate limiting. |
| `src/services/congress-documents/` | Bounded document-text fetch — host allowlist, byte ceiling, character window. |
| `src/services/congress-mirror/` | Local SQLite FTS5 bill-search mirror — ingest, normalize, schema. |
| `src/services/senate-lis/` | Senate LIS XML client for Senate roll call votes. |
| `scripts/` | Mirror lifecycle CLI scripts (`mirror:init` / `mirror:refresh` / `mirror:verify`). |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- All tools are read-only, with `readOnlyHint: true` and `idempotentHint: true` annotations
- Wrap external API calls: validate raw → normalize to a domain type → return the output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.

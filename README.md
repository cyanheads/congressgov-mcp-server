<div align="center">
  <h1>@cyanheads/congressgov-mcp-server</h1>
  <p><b>Access U.S. congressional data - bills, votes, members, committees - through MCP. STDIO & Streamable HTTP.</b>
  <div>11 Tools • 5 Resources • 2 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.7.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/congressgov-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/congressgov-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/congressgov-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/congressgov-mcp-server/releases/latest/download/congressgov-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=congressgov-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY29uZ3Jlc3Nnb3YtbWNwLXNlcnZlciJdLCJlbnYiOnsiQ09OR1JFU1NfQVBJX0tFWSI6InlvdXItYXBpLWtleSJ9fQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22congressgov-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fcongressgov-mcp-server%22%5D%2C%22env%22%3A%7B%22CONGRESS_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://congressgov.caseyjhand.com/mcp](https://congressgov.caseyjhand.com/mcp)

</div>

---

## Overview

U.S. congressional data from the Congress.gov API v3 and the Senate's official vote feed: bills, enacted laws, members, committees, roll call votes, nominations, CRS and committee reports, and the Congressional Record. Browse legislative activity, read bill and report text, and follow the Senate confirmation pipeline from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `congressgov_bill_lookup` | Browse and retrieve bills: actions, sponsors, summaries, text, related bills |
| `congressgov_enacted_laws` | Browse enacted public and private laws by congress |
| `congressgov_member_lookup` | Find members by state, district, or congress, and retrieve their legislative portfolios |
| `congressgov_committee_lookup` | Browse committees and their legislation, reports, and nominations |
| `congressgov_roll_votes` | Retrieve House and Senate roll call votes and each member's position |
| `congressgov_senate_nominations` | Browse presidential nominations and track Senate confirmation |
| `congressgov_bill_summaries` | Browse recently updated CRS bill summaries |
| `congressgov_crs_reports` | Browse and retrieve nonpartisan CRS policy reports |
| `congressgov_committee_reports` | Browse and read committee reports accompanying legislation |
| `congressgov_daily_record` | Browse and read the daily Congressional Record |
| `congressgov_search_bills` | Keyword-search bill titles and CRS summaries via a local full-text mirror (opt-in) |

### Resources

| Resource | Description |
|:---|:---|
| `congress://current` | Current congress number, session dates, chamber info |
| `congress://bill-types` | Reference table of valid bill type codes |
| `congress://member/{bioguideId}` | Member profile by bioguide ID |
| `congress://bill/{congress}/{billType}/{billNumber}` | Bill detail by congress, type, and number |
| `congress://committee/{committeeCode}` | Committee detail by committee code |

Bill, member, and committee data is also reachable through `congressgov_bill_lookup`, `congressgov_member_lookup`, and `congressgov_committee_lookup` (operation `get`), since many MCP clients are tool-only and never surface resources.

### Prompts

| Prompt | Description |
|:---|:---|
| `congressgov_bill_analysis` | Structured framework for analyzing a bill |
| `congressgov_legislative_research` | Research framework for a policy area across Congress |

## Capability reference

### `congressgov_bill_lookup` <sub>tool</sub>

- `list` browses one `congress`, narrowed by `billType` and a `fromDateTime`/`toDateTime` range on the record's update date, newest first unless `order: 'oldest'`; `get`, `actions`, `amendments`, `cosponsors`, `committees`, `subjects`, `summaries`, `text`, `titles`, `related`, and `content` need `congress` + `billType` + `billNumber`
- `content` reads the text version at `textVersionIndex` (0-based in `text` order, 0 is the most recent) and returns one character window in `content.text` with `totalCharacters`, `truncated`, and `nextOffset`
- `summaries` takes an optional `versionCode` (`00` introduced, `49` public law) and applies the same page budget and row window as `congressgov_bill_summaries`, steered by `characterOffset`/`characterLimit`; a cut row carries `textTotalCharacters`, `textTruncated`, and `textNextOffset`

---

### `congressgov_enacted_laws` <sub>tool</sub>

- `list` browses one `congress`, optionally by `lawType` (`pub` or `priv`), the enactment filter `congressgov_bill_lookup` lacks; `get` needs `lawType` + `lawNumber`, taken from a list row's `laws[].number` (`118-90`) or its bare number (`90`)
- `get` returns the origin bill record, with the law citation on its `laws[]` array

---

### `congressgov_member_lookup` <sub>tool</sub>

- No name search: `list` filters by `stateCode` (plus `district`, `0` for at-large, which requires `stateCode`), `congress`, and `currentMember`
- `get` returns the profile for a `bioguideId` (e.g. `P000197`); `sponsored` and `cosponsored` return that member's legislation

---

### `congressgov_committee_lookup` <sub>tool</sub>

- `committeeCode` is a chamber prefix (`h`/`s`/`j`), letters, and a 2-digit suffix (e.g. `hsju00`); `get`, `bills`, `reports`, and the Senate-only `nominations` infer `chamber` from the prefix
- A committee name in `committeeCode` resolves when exactly one committee matches, and otherwise returns the candidate rows with a notice; `list` with `filter` name-matches every committee in scope, past the 250-row page cap, and fuzzy hits carry `approximate: true`
- `bills` is newest first by default (`order`), and its rows carry no titles, so chain `congressgov_bill_lookup` `get` per row

---

### `congressgov_roll_votes` <sub>tool</sub>

- `chamber` is `house` (default, Congress.gov API) or `senate` (the Senate's LIS feed); every call needs `congress` + `session` (1 or 2), and `get`/`members` add `voteNumber`, which resets each session and is specific to one chamber
- `list` is newest first unless `order: 'oldest'`; `get` returns the question, result, tallies, and party breakdown, and `members` returns each member's position
- Senate votes start at the 101st Congress (1989), and Senate rows pair the feed's year-less `voteDate` with a derived `voteDateIso`

---

### `congressgov_senate_nominations` <sub>tool</sub>

- `list` browses one `congress`; `get`, `actions`, `committees`, `hearings`, and `nominees` need a `nominationNumber` (`1000` for PN1000), and `nominees` also needs an `ordinal` from the `nominees` array `get` returns
- Multi-part nominations (e.g. PN851) keep their activity on partitioned children (`851-1`, `851-2`, …); an empty sub-resource call on the bare number returns a notice pointing there

---

### `congressgov_bill_summaries` <sub>tool</sub>

- Optional `congress` and `billType` (which requires `congress`); `fromDateTime`/`toDateTime` filter on the summary's update time, not the bill's action date, and cover the last 7 days when both are omitted
- A page stops adding rows at 50,000 serialized characters (at least one row always returns, and `pagination.nextOffset` resumes); a summary over 25,000 characters arrives windowed with `textTotalCharacters`, `textTruncated`, and `textNextOffset`
- For one bill's summaries, or to read a windowed summary to the end, use `congressgov_bill_lookup` `summaries`

---

### `congressgov_crs_reports` <sub>tool</sub>

- `list` browses the catalog; `get` takes a `reportNumber` such as `R40097`, `RL33612`, or `IF12345`
- `get` returns authors, topics, summary, and download formats

---

### `congressgov_committee_reports` <sub>tool</sub>

- `list` browses one `congress`, optionally by `reportType` (`hrpt` House, `srpt` Senate, `erpt` Executive); `get`, `text`, and `content` need `reportType` + `reportNumber`
- `get` returns the citation, title, committees, and associated bill; `text` lists `{type, url}` format links, and `content` reads the report as one character window

---

### `congressgov_daily_record` <sub>tool</sub>

- Navigation runs `list` (volumes) → `issues` (by `volumeNumber`) → `articles` (by `volumeNumber` + `issueNumber`)
- `content` reads the article at `articleIndex` (0-based across the issue) as one character window; Record articles publish Formatted Text and PDF only, so `format: 'xml'` fails as `format_unavailable`

---

### `congressgov_search_bills` <sub>tool</sub>

- `query` keywords (AND-combined) over bill titles and CRS summaries, narrowed by `congress`, `billType`, and `originChamber`; `limit` 1–100, `offset` pagination
- BM25-ranked rows carry `billId` plus `congress`/`billType`/`billNumber` for `congressgov_bill_lookup`, and a `summaryPreview`; policy area and full bill text are not indexed
- Listed only when `CONGRESS_MIRROR_ENABLED=true`; until `bun run mirror:init` builds the index, it returns an empty result with a notice

---

### `congress://current` <sub>resource</sub>

- Current congress number, session dates, and chamber info, the baseline for other queries
- Cached publicly for 1 hour

---

### `congress://bill-types` <sub>resource</sub>

- The 8 bill type codes (`hr`, `s`, `hjres`, `sjres`, `hconres`, `sconres`, `hres`, `sres`) with description, chamber, and an example citation
- Static, with no upstream call; cached publicly for 24 hours

---

### `congress://member/{bioguideId}` <sub>resource</sub>

- `bioguideId` is one uppercase letter and 6 digits (e.g. `P000197`)
- Returns the member profile: name, state, party, terms, leadership, office, legislation counts

---

### `congress://bill/{congress}/{billType}/{billNumber}` <sub>resource</sub>

- `congress` and `billNumber` are positive integers; `billType` is one of the 8 bill type codes
- Returns bill detail: sponsor, status, policy area, committees, latest action

---

### `congress://committee/{committeeCode}` <sub>resource</sub>

- `committeeCode` is `h`/`s`/`j` followed by 3–8 lowercase alphanumeric characters (e.g. `hsju00`); chamber comes from the first letter
- Returns committee detail: name, chamber, subcommittees, history, legislation counts

---

### `congressgov_bill_analysis` <sub>prompt</sub>

- Arguments: `congress`, `billType`, and `billNumber`, all required
- Returns one user message framing a seven-part analysis, from summary to outlook, with the tools to call for each part

---

### `congressgov_legislative_research` <sub>prompt</sub>

- Arguments: `topic` required; `congress` optional, defaulting to the current congress
- With `CONGRESS_MIRROR_ENABLED`, the plan opens with `congressgov_search_bills`; without it, the prompt asks for a seed bill, member, committee, or CRS report ID, since no other tool takes a topic

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Congress.gov-specific:

- Type-safe client for the Congress.gov REST API v3, plus a client for the Senate's LIS XML feed that backs Senate roll votes
- The Congress.gov API has no keyword search, so tools browse by congress, type, date range, chamber, state, and district, and address bills by `congress` + `billType` + `billNumber`, members by `bioguideId`, and committees by system code; list operations page with `limit` 1–250 (default 20) and `offset`
- `content` on bill text, committee reports, and Record articles reads `format` `text` (default) or `xml` through a `characterOffset`/`characterLimit` window (1–100,000 characters, default 25,000), fetched only from `www.congress.gov` under a 25 MB ceiling and a 30s deadline
- Optional API key from [api.data.gov](https://api.data.gov/signup/): `DEMO_KEY` allows 30 req/hr, your own key 5,000 req/hr
- Opt-in local SQLite FTS5 mirror (`CONGRESS_MIRROR_ENABLED`) adds keyword search over bill titles and CRS summaries

Agent-friendly output:

- Every list response carries `effectiveQuery` and `totalCount`; a `notice` fires when nothing matched, and a page past the end says so in the rendered output
- Exact character windows: `content` returns `offset`, `truncated`, and `nextOffset`, so walking a multi-megabyte bill never skips or repeats a character
- Typed `content` failures (`document_unavailable`, `format_unavailable`, `document_fetch_failed`, `document_too_large`, `offset_past_end`) alongside the shared `not_found`, `rate_limited`, `invalid_request`, and `upstream_error` reasons, each with a recovery hint

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

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 CONGRESS_API_KEY=your-api-key bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Optional: a free [api.data.gov key](https://api.data.gov/signup/) raises the limit from 30 to 5,000 requests per hour.

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
# edit .env and set CONGRESS_API_KEY (and the mirror vars, if you want keyword search)
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `CONGRESS_API_KEY` | API key from [api.data.gov](https://api.data.gov/signup/). `DEMO_KEY` allows 30 req/hr; your own key 5,000 req/hr. | `DEMO_KEY` |
| `CONGRESS_API_BASE_URL` | Congress.gov API base URL. | `https://api.congress.gov/v3` |
| `CONGRESS_MIRROR_ENABLED` | Enable the local bill search mirror and the `congressgov_search_bills` tool. | `false` |
| `CONGRESS_MIRROR_PATH` | Filesystem path to the SQLite mirror index. | `.mirror/bills.sqlite3` |
| `CONGRESS_MIRROR_REFRESH_CRON` | Cron schedule for the in-process mirror refresh (HTTP transport only). Unset means running `mirror:refresh` yourself. | — |
| `CONGRESS_MIRROR_CONGRESSES` | Comma-separated congress numbers to mirror (e.g. `118,119`). | current congress + 1 prior |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`; `auto` resolves to `stateful`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP endpoint for traces and metrics. | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Explicit OTLP logs endpoint; the base endpoint does not enable log export. | — |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed-call input and output with key-based redaction; secrets inside free-form values are not redacted. | `false` |
| `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` | Maximum bytes per failed-call input or output record. | `16384` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version:**

  ```sh
  bun run rebuild
  bun run start:http   # or start:stdio
  ```

- **Build the bill search mirror** (with `CONGRESS_MIRROR_ENABLED=true`):

  ```sh
  bun run mirror:init      # full build
  bun run mirror:refresh   # incremental refresh
  bun run mirror:verify    # readiness and integrity check
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

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/congressgov-mcp-server`. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them. The image carries the mirror scripts, so `docker exec <container> bun run mirror:init` builds the index in place.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers tools, resources, and prompts, inits services, and schedules the mirror refresh. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/` | Tool definitions (`definitions/*.tool.ts`) plus shared input, formatting, and summary-window helpers. |
| `src/mcp-server/resources/definitions/` | Resource definitions (`*.resource.ts`). |
| `src/mcp-server/prompts/definitions/` | Prompt definitions (`*.prompt.ts`). |
| `src/services/congress-api/` | Congress.gov API client: auth, pagination, rate limiting. |
| `src/services/congress-documents/` | Bounded document-text fetch: host allowlist, byte ceiling, character window. |
| `src/services/congress-mirror/` | Local SQLite FTS5 bill-search mirror: ingest, normalize, schema. |
| `src/services/senate-lis/` | Senate LIS XML client for Senate roll call votes. |
| `src/utils/` | HTML/XML character-reference decoding. |
| `scripts/` | Build, devcheck, and release tooling, plus the `mirror:init` / `mirror:refresh` / `mirror:verify` CLIs. |
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

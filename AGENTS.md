# Agent Protocol

**Server:** congressgov-mcp-server
**Version:** 0.3.12
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Overview

MCP server wrapping the [Congress.gov API v3](https://api.congress.gov/) — the official machine-readable interface to U.S. legislative data maintained by the Library of Congress. All tools are **read-only** and **idempotent**. The API has **no keyword search** — discovery happens via browse/filter on congress number, bill type, date range, chamber, state, and district.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
9. **Run the `maintenance` skill** — sync skills and dependencies after framework updates

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `CONGRESS_API_KEY` | Yes | API key from [api.data.gov](https://api.data.gov/signup/) (free, 5,000 req/hr) |
| `CONGRESS_API_BASE_URL` | No | Defaults to `https://api.congress.gov/v3` |

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **All tools are read-only.** Every tool gets `annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }`.
- **API key stays out of logs.** The service appends `api_key` as a query param — never log full URLs.

---

## MCP Surface

### Tools (10)

| Name | Description |
|:-----|:------------|
| `congressgov_bill_lookup` | Browse, filter, and retrieve bill data (actions, sponsors, summaries, text, related bills) |
| `congressgov_enacted_laws` | Browse enacted public and private laws by congress |
| `congressgov_member_lookup` | Discover members by state/district/congress, retrieve legislative portfolios |
| `congressgov_committee_lookup` | Browse committees and retrieve legislation, reports, nominations |
| `congressgov_roll_votes` | Retrieve House roll call votes and member voting positions |
| `congressgov_senate_nominations` | Browse presidential nominations, track Senate confirmation pipeline |
| `congressgov_bill_summaries` | Browse recent CRS bill summaries — the "what's happening" feed |
| `congressgov_crs_reports` | Browse and retrieve nonpartisan CRS policy analysis reports |
| `congressgov_committee_reports` | Browse and retrieve committee reports accompanying legislation |
| `congressgov_daily_record` | Browse daily Congressional Record — floor speeches, debates, proceedings |

### Resources (5)

| URI Template | Description |
|:-------------|:------------|
| `congress://current` | Current congress number, session dates, chamber info |
| `congress://bill-types` | Reference table of valid bill type codes |
| `congress://member/{bioguideId}` | Member profile |
| `congress://bill/{congress}/{billType}/{billNumber}` | Bill detail |
| `congress://committee/{committeeCode}` | Committee detail |

### Prompts (2)

| Name | Description |
|:-----|:------------|
| `congressgov_bill_analysis` | Structured framework for analyzing a bill |
| `congressgov_legislative_research` | Research framework for a policy area across Congress |

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # CONGRESS_API_KEY, base URL (Zod schema)
  services/
    congress-api/
      congress-api-service.ts           # API client — auth, pagination, rate limiting
      types.ts                          # API response types
  mcp-server/
    tools/definitions/
      bill-lookup.tool.ts              # congressgov_bill_lookup
      enacted-laws.tool.ts             # congressgov_enacted_laws
      member-lookup.tool.ts            # congressgov_member_lookup
      committee-lookup.tool.ts         # congressgov_committee_lookup
      roll-votes.tool.ts              # congressgov_roll_votes
      senate-nominations.tool.ts       # congressgov_senate_nominations
      bill-summaries.tool.ts           # congressgov_bill_summaries
      crs-reports.tool.ts             # congressgov_crs_reports
      committee-reports.tool.ts        # congressgov_committee_reports
      daily-record.tool.ts            # congressgov_daily_record
    resources/definitions/
      current-congress.resource.ts     # congress://current
      bill-types.resource.ts           # congress://bill-types
      member.resource.ts               # congress://member/{bioguideId}
      bill.resource.ts                 # congress://bill/{congress}/{billType}/{billNumber}
      committee.resource.ts            # congress://committee/{committeeCode}
    prompts/definitions/
      bill-analysis.prompt.ts          # congressgov_bill_analysis
      legislative-research.prompt.ts   # congressgov_legislative_research
```

---

## Service

Single service: `CongressApiService`. Wraps the Congress.gov REST API v3.

**Key concerns:**
- API key via `?api_key=` query param (never logged)
- Pagination: `offset` + `limit` query params, max 250 per request
- Rate limiting: 5,000 requests/hour per key
- Response normalization: request `format=json`, return typed data
- Native `fetch` — no SDK dependency

**Usage in tools:**
```ts
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

async handler(input, ctx) {
  const api = getCongressApi();
  const bills = await api.listBills({ congress: input.congress, limit: input.limit });
  ctx.log.info('Bills fetched', { congress: input.congress, count: bills.bills.length });
  return bills;
}
```

---

## Error Patterns

All tools share these patterns. The service layer handles them uniformly:

| Condition | Error |
|:----------|:------|
| Rate limit hit | `rateLimited('Congress.gov API rate limit reached (5,000 requests/hour).')` |
| API unavailable (5xx) | `serviceUnavailable('Congress.gov API returned HTTP {status}.')` |
| Entity not found (404) | `notFound('{entity} not found', { ...identifiers })` |
| Invalid params | `validationError('...', { field })` |
| Network error | `serviceUnavailable('Unable to reach the Congress.gov API.')` |

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `bill-lookup.tool.ts` |
| Tool/resource/prompt names | snake_case with `congressgov_` prefix | `congressgov_bill_lookup` |
| Directories | kebab-case | `src/services/congress-api/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Browse and retrieve bill data.'` |

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { notFound, serviceUnavailable, rateLimited } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import { getServerConfig } from '@/config/server-config.js';
```

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, re-copy to pick up changes.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Sync skills and dependencies after updates |
| `report-issue-framework` | File bugs/features against `@cyanheads/mcp-ts-core` |
| `report-issue-local` | File bugs/features against this server's repo |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run lint:mcp` | Validate MCP tool/resource/prompt definitions |
| `bun run test` | Run tests |
| `bun run dev:stdio` | Dev mode (stdio) |
| `bun run dev:http` | Dev mode (HTTP) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

---

## Publishing

After a version bump and final commit, publish to both npm and GHCR:

```bash
bun publish --access public

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/cyanheads/congressgov-mcp-server:<version> \
  -t ghcr.io/cyanheads/congressgov-mcp-server:latest \
  --push .
```

Remind the user to run these after completing a release flow.

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, etc.)
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes

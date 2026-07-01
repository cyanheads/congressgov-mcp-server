# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-06-30

New congressgov_search_bills tool — keyword search over a local SQLite + FTS5 mirror of bill titles and CRS summaries, the discovery path the Congress.gov API lacks. Opt-in, off by default (CONGRESS_MIRROR_ENABLED); adds node-cron + optional better-sqlite3, four optional mirror env vars, and mirror:init/refresh/verify scripts.

## [0.3.32](changelog/0.3.x/0.3.32.md) — 2026-06-30 · 🛡️ Security

congressgov_committee_lookup name filter and resolution now page the full committee set instead of only the first 250; API-key rate-limit docs corrected to 5,000 req/hr; @cyanheads/mcp-ts-core ^0.10.9 → ^0.10.10; bun audit cleared 8 transitive advisories to 0.

## [0.3.31](changelog/0.3.x/0.3.31.md) — 2026-06-20

Maintenance: @cyanheads/mcp-ts-core ^0.10.6 → ^0.10.9; devcheck gains floating-specifier and plugin-manifest guards, re-synced framework skills and scripts, dependency refresh. No tool/resource/prompt surface changes.

## [0.3.30](changelog/0.3.x/0.3.30.md) — 2026-06-11

Maintenance: @cyanheads/mcp-ts-core ^0.9.21 → ^0.10.6; server identity name/title pair, de-scoped plugin display name, Dockerfile version label + writable data dirs + HEALTHCHECK, post-pack bundle cleaner, anchored .mcpbignore.

## [0.3.29](changelog/0.3.x/0.3.29.md) — 2026-06-04

congressgov_committee_lookup: auto-resolve name-like committeeCode inputs, schema pattern guard on malformed codes (#39)

## [0.3.28](changelog/0.3.x/0.3.28.md) — 2026-06-02

adopt @cyanheads/mcp-ts-core 0.9.21 — per-request log context fix, secret-scrubbing in fetchWithTimeout, withRetry fail-fast on non-retryable errors

## [0.3.27](changelog/0.3.x/0.3.27.md) — 2026-05-31

committee_lookup: filter param on list for name→code resolution; actionable not-found errors with code-shape hint and list redirect; whitespace guard rejects names passed as committeeCode

## [0.3.26](changelog/0.3.x/0.3.26.md) — 2026-05-31

congressgov_roll_votes: Senate chamber support via LIS XML feed — list/get/members for both chambers

## [0.3.25](changelog/0.3.x/0.3.25.md) — 2026-05-31

roll_votes members roster moved to top-level data[] — aligns with fleet-wide paginated envelope

## [0.3.24](changelog/0.3.x/0.3.24.md) — 2026-05-31

Typed error contracts on all 10 tools, classified upstream errors (no URL leak), and client-side calendar validation for impossible dates

## [0.3.23](changelog/0.3.x/0.3.23.md) — 2026-05-30

Enrichment adoption on browse/list tools — effectiveQuery, totalCount, and notice now surface in structuredContent and content[]; fixed field-name mismatch that broke structuredContent output on list tools; single-record get paths now populate enrichment

## [0.3.22](changelog/0.3.x/0.3.22.md) — 2026-05-28 · 🛡️ Security

mcp-ts-core ^0.9.6 → ^0.9.13, MCP_HTTP_MAX_BODY_BYTES 413 body cap, HTTP session-init gate, quieter 401/403/400/404 logging, GET /mcp surfaces package.json keywords, manifest.json and keyword alignment

## [0.3.21](changelog/0.3.x/0.3.21.md) — 2026-05-23

mcp-ts-core ^0.9.1 → ^0.9.6, zod added as direct dep, manifest.json + .mcpbignore scaffolded for MCPB bundle support, install badges added to README.

## [0.3.20](changelog/0.3.x/0.3.20.md) — 2026-05-20

Strict newest-first sort on `congressgov_roll_votes`, restored sub-resource rendering on `congressgov_senate_nominations`, empty-page disambiguation in list output, ISO 8601 validation on date filters, and a `Search:` echo line on every list response so callers can confirm what was filtered.

## [0.3.19](changelog/0.3.x/0.3.19.md) — 2026-05-20

Closes every open issue: domain renderers for member/nomination/vote/committee, `order` sort on `bill_lookup` and `roll_votes`, chamber inference on `committee_lookup`, partitioned-form hints for `senate_nominations`, and upstream-data normalization (CRS dedup/scheme, committee-report ISO dates, `/text` limit+1).

## [0.3.18](changelog/0.3.x/0.3.18.md) — 2026-05-20

Fix `congressgov_member_lookup` list to build the combined `/member/congress/{c}/{state}/{district}` URL instead of rejecting the filter combo, and classify upstream `500 (DoesNotExist)` bodies as `NotFound` across all endpoints (not just CRS) — affects `congressgov_committee_lookup` reports/bills/nominations sub-resources.

## [0.3.17](changelog/0.3.x/0.3.17.md) — 2026-05-16

Adopt @cyanheads/mcp-ts-core ^0.8.19 → ^0.9.1: server-level `instructions` field surfaced on initialize, tool input-validation errors switch from `new Error` to the `validationError` factory, fetchResponse drops stale 404/429 status-code probing in favor of the framework's typed HTTP→McpError mapping.

## [0.3.16](changelog/0.3.x/0.3.16.md) — 2026-05-08

Identifier-rich notFound errors with English-ordinal congress numbers, upstream casing normalized (bioguideID/URL/cmte_rpt_id → camelCase), bill summaries rendered HTML→Markdown, regex-validated resource params, empty-result recovery hint.

## [0.3.15](changelog/0.3.x/0.3.15.md) — 2026-05-08

Adopt @cyanheads/mcp-ts-core ^0.7.0 → ^0.8.19 — typed error contracts, ctx.fail/recoveryFor, canvas + spillover. Engines bumped to Bun ≥1.3.0 / Node ≥24.0.0; Docker base oven/bun:1 → oven/bun:1.3. New Framework Antipatterns devcheck step.

## [0.3.14](changelog/0.3.x/0.3.14.md) — 2026-04-24

Adopt @cyanheads/mcp-ts-core 0.5.3 → 0.7.0 (18 intermediate releases); directory-based changelog system; landing page with sourceUrl overrides; three new skills synced (api-linter, security-pass, release-and-publish)

## [0.3.13](changelog/0.3.x/0.3.13.md) — 2026-04-20

Daily record articles rendering fix, content[] parity for roll-votes/daily-record/crs-reports, core 0.5.3 bump with parseEnvConfig adoption and Docs Sync step

## [0.3.12](changelog/0.3.x/0.3.12.md) — 2026-04-20

Core 0.3.7 → 0.5.2 bump, four tools relaxed to passthrough output schemas for format-parity compliance, test fixup

## [0.3.11](changelog/0.3.x/0.3.11.md) — 2026-04-19

Security — API key moved from query string to X-Api-Key header (rotate keys); roll-votes members operation now paginates client-side; ordinal description clarified

## [0.3.10](changelog/0.3.x/0.3.10.md) — 2026-04-19

New `order` input on committee_lookup bills sub-resource, core 0.3.5 → 0.3.7 bump, tool description cleanup

## [0.3.9](changelog/0.3.x/0.3.9.md) — 2026-04-19

Fix list-rendering regressions across crs-reports, daily-record, roll-votes, bill actions, committee reports, and committee detail; bill summaries doc clarity; format-helpers regression tests

## [0.3.8](changelog/0.3.x/0.3.8.md) — 2026-04-19

AGENTS.md for non-Claude agents, add-app-tool skill, shared schema helpers, core 0.2.10 → 0.3.5 bump, stricter tool schemas and service resilience improvements

## [0.3.7](changelog/0.3.x/0.3.7.md) — 2026-03-30

Author metadata + funding links, core 0.2.8 → 0.2.10 bump, skill updates (add-tool v1.1, add-resource v1.1, design-mcp-server v2.1)

## [0.3.6](changelog/0.3.x/0.3.6.md) — 2026-03-28

Core 0.2.3 → 0.2.8 bump

## [0.3.5](changelog/0.3.x/0.3.5.md) — 2026-03-28

Ten domain-specific markdown formatters replace the generic formatResult; core 0.1.29 → 0.2.3 bump; report-issue skills added

## [0.3.4](changelog/0.3.x/0.3.4.md) — 2026-03-26

list handlers on current/bill-types resources for MCP discovery, CRS notFound on upstream HTTP 500, dep bumps

## [0.3.3](changelog/0.3.x/0.3.3.md) — 2026-03-24

Refreshed package descriptions across package.json/server.json/Dockerfile/README; typescript keyword added

## [0.3.2](changelog/0.3.x/0.3.2.md) — 2026-03-24

Restored idempotentHint:true on all tool annotations, dropped Cloudflare KV/R2/D1 from README, 5xx retry test fix

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-03-24

5xx retry with exponential backoff (3 attempts, 1s/2s/4s), npm badge URL fix

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-03-24

Scoped package rename to @cyanheads/congressgov-mcp-server, TS 5.9 → 6.0, pagination improvements, format-helpers.ts, README overhaul

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-03-24

Full test suite (10 tool + 5 resource + 2 prompt tests + service), tree.md refresh

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-03-24

API response key corrections across four endpoints, getVoteMembers + getNominee service methods, dedicated members/nominees tool operations

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-03-24

Initial release — MCP server wrapping Congress.gov API v3 with 10 tools, 5 resources, and 2 prompts for U.S. legislative data

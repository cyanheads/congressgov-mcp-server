# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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

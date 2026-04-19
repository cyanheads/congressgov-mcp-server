# Changelog

## [0.3.8] - 2026-04-19

### Added

- Added `AGENTS.md` for non-Claude agents
- Added the `add-app-tool` skill for MCP Apps tool and UI resource scaffolding
- Added shared tool schema helpers in `src/mcp-server/tools/tool-helpers.ts`

### Changed

- Bumped `@cyanheads/mcp-ts-core` from `^0.2.10` to `^0.3.5`
- Bumped `@biomejs/biome` from `^2.4.10` to `^2.4.12`, `@types/node` from `^25.5.0` to `^25.6.0`, `typescript` from `^6.0.2` to `^6.0.3`, and `vitest` from `^4.1.2` to `^4.1.4`
- Updated Congress.gov tool and resource outputs to use stricter schemas, preserve pagination metadata, and pass request context through service calls. Tools return only normalized fields (`data`/`pagination` for lists, `bill`/`member`/`committee`/etc. for details) — upstream envelopes are no longer duplicated in structured output
- Updated markdown formatters to surface upstream URLs and improve empty-field handling
- Updated `CongressApiService` to use framework retry and timeout utilities, and carry request context and abort signals through HTTP calls
- Updated project skills for direct `createApp()` registration guidance, external-service resilience, testing layout, field-test coverage, and devcheck expectations
- Dropped the `overrides` block for `brace-expansion` and `path-to-regexp` — upstream chains now resolve to patched versions and `bun audit` is clean without them

### Fixed

- Fixed `getLaw` returning an empty `law` field — Congress.gov returns the law endpoint payload under `bill`, not `law`, so the normalized field was always undefined. Added a service-level test asserting `result.law` is populated
- Fixed CRS report error handling to distinguish structured upstream "not found" responses from real service outages
- Fixed member lookup validation to reject ambiguous `congress` and location filters instead of silently dropping one
- Fixed the `CLAUDE.md` commands table to use `bun run test`

## [0.3.7] - 2026-03-30

### Changed

- Updated author metadata and added funding links (GitHub Sponsors, Buy Me a Coffee) in package.json
- Bumped `@cyanheads/mcp-ts-core` from ^0.2.8 to ^0.2.10
- Bumped `@biomejs/biome` from ^2.4.9 to ^2.4.10
- Updated `add-tool` skill to v1.1 — expanded `format()` template with content-complete rendering, added Tool Response Design section (partial success, empty results, error classification, operational metadata, context budget)
- Updated `add-resource` skill to v1.1 — added tool coverage guidance (resources invisible to tool-only clients)
- Updated `design-mcp-server` skill to v2.1 — live API probing, batch input design, error classification table, convenience shortcuts, tool-first surface design, service resilience planning

## [0.3.6] - 2026-03-28

### Changed

- Bumped `@cyanheads/mcp-ts-core` from ^0.2.3 to ^0.2.8

## [0.3.5] - 2026-03-28

### Changed

- Rewrote tool output formatting — replaced generic `formatResult` with 10 domain-specific markdown formatters (`formatBills`, `formatMembers`, `formatSummaries`, `formatCommittees`, `formatCommitteeReports`, `formatCrsReports`, `formatDailyRecord`, `formatLaws`, `formatVotes`, `formatNominations`) for richer, more readable LLM output
- Bumped `@cyanheads/mcp-ts-core` from ^0.1.29 to ^0.2.3
- Updated `polish-docs-meta` skill to v1.2 — added GitHub repo metadata sync step and description propagation guidance

### Added

- `report-issue-framework` skill for filing bugs against `@cyanheads/mcp-ts-core`
- `report-issue-local` skill for filing bugs against this server's repo
- Security overrides for `brace-expansion` (>=2.0.3) and `path-to-regexp` (>=8.4.0)
- `LOGS_DIR` env var documented in README and skill references

### Removed

- `tsx` dev dependency (no longer needed)

## [0.3.4] - 2026-03-26

### Added

- `list` handlers on `congress://current` and `congress://bill-types` resources for MCP resource discovery

### Fixed

- CRS report lookup now returns `notFound` when the upstream API responds with HTTP 500 for nonexistent report IDs

### Changed

- Bumped `@cyanheads/mcp-ts-core` to ^0.1.29, `@biomejs/biome` to ^2.4.9, `vitest` to ^4.1.2

## [0.3.3] - 2026-03-24

### Changed

- Refreshed package description across package.json, server.json, Dockerfile, and README
- Added `typescript` keyword to package.json

## [0.3.2] - 2026-03-24

### Changed

- Restored explicit `idempotentHint: true` on all tool annotations
- Removed Cloudflare KV/R2/D1 from README storage backends list
- Updated 5xx retry test to verify retry count and mock `text()` method

## [0.3.1] - 2026-03-24

### Changed

- Added retry with exponential backoff for 5xx API errors (3 attempts with 1s/2s/4s delays)

### Fixed

- npm badge URL now points to scoped package `@cyanheads/congressgov-mcp-server`

## [0.3.0] - 2026-03-24

### Changed

- Renamed package to `@cyanheads/congressgov-mcp-server` (scoped under `@cyanheads`)
- Bumped TypeScript from `^5.9.3` to `^6.0.2`
- `getDailyIssues` now uses `fetchList` with full pagination support
- `getMemberLegislation` simplified to return `fetchList` result directly
- Removed redundant duplicate key from `fetchList` return shape
- README overhaul: scoped package name, npm badge, npx/Docker/HTTP config examples, cleaner table formatting

### Added

- `format-helpers.ts` — shared `formatResult` formatter for all tool output (readable text with HTML stripping, list summarization, pagination headers)
- All 10 tools now use `format: formatResult` for structured text output
- `notFound` error for missing committee reports instead of returning empty objects
- Detection of Congress.gov API 500-as-404 responses (structured JSON error bodies vs. real outages)

### Fixed

- Daily record `issues` operation now passes `limit` and `offset` params through to the API

## [0.2.1] - 2026-03-24

### Added

- Full test suite: 10 tool tests, 5 resource tests, 2 prompt tests, and congress-api-service tests using `createMockContext` and Vitest
- Updated `docs/tree.md` to reflect new `tests/` directory structure

### Fixed

- Operator precedence parentheses in `congress-api-service.ts` for nullish coalescing expressions
- Formatting in `senate-nominations.tool.ts`

## [0.2.0] - 2026-03-24

### Fixed

- Corrected API response keys for laws (`laws` → `bills`), House votes (`houseVotes` → `houseRollCallVotes`), committee reports (`committeeReports` → `reports`), and CRS reports endpoint path (`/crs-report` → `/crsreport`)
- Handled array-wrapped responses from committee report detail endpoint
- Added nested array unwrapping in `fetchList` for endpoints that nest arrays inside objects (e.g. committee-bills)
- Fixed committee bills sub-resource list key (`bills` → `committee-bills`)
- Stripped milliseconds from default ISO date in bill summaries for API compatibility

### Added

- `getVoteMembers()` service method — dedicated endpoint for individual member voting positions
- `getNominee()` service method — individual nominee lookup by ordinal within a nomination
- Separate 'members' operation path in `congressgov_roll_votes` using the new vote members endpoint
- Separate 'nominees' operation in `congressgov_senate_nominations` with ordinal requirement and actionable error message

### Changed

- Added missing `idempotentHint: true` annotation to all tool definitions
- Updated dev dependencies: `@biomejs/biome` 2.4.7→2.4.8, `tsx` 4.19.0→4.21.0, `vitest` 4.1.0→4.1.1

## [0.1.0] - 2026-03-24

Initial release. MCP server wrapping the Congress.gov API v3 — the official machine-readable interface to U.S. legislative data maintained by the Library of Congress.

### Added

- **10 read-only tools** for querying legislative data:
  - `congressgov_bill_lookup` — browse, filter, and retrieve bill data (actions, sponsors, summaries, text, related bills)
  - `congressgov_enacted_laws` — browse enacted public and private laws by congress
  - `congressgov_member_lookup` — discover members by state/district/congress, retrieve legislative portfolios
  - `congressgov_committee_lookup` — browse committees and retrieve legislation, reports, nominations
  - `congressgov_roll_votes` — retrieve House roll call votes and member voting positions
  - `congressgov_senate_nominations` — browse presidential nominations, track Senate confirmation pipeline
  - `congressgov_bill_summaries` — browse recent CRS bill summaries
  - `congressgov_crs_reports` — browse and retrieve nonpartisan CRS policy analysis reports
  - `congressgov_committee_reports` — browse and retrieve committee reports accompanying legislation
  - `congressgov_daily_record` — browse daily Congressional Record (floor speeches, debates, proceedings)
- **5 resources** for direct data access:
  - `congress://current` — current congress number, session dates, chamber info
  - `congress://bill-types` — reference table of valid bill type codes
  - `congress://member/{bioguideId}` — member profile
  - `congress://bill/{congress}/{billType}/{billNumber}` — bill detail
  - `congress://committee/{committeeCode}` — committee detail
- **2 prompt templates** for structured analysis:
  - `congressgov_bill_analysis` — framework for analyzing a bill
  - `congressgov_legislative_research` — research framework for a policy area across Congress
- **Congress API service** with authentication, pagination, rate limiting, and response normalization
- **Server configuration** via `CONGRESS_API_KEY` env var (free key from api.data.gov)
- Dual transport support: stdio and streamable HTTP
- Docker support
- Built on `@cyanheads/mcp-ts-core` framework

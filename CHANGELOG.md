# Changelog

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

# Changelog

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

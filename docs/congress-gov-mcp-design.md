# Congress.gov MCP Server — Design

**Package:** `@cyanheads/congressgov-mcp-server`

## MCP Surface

All tools are read-only, idempotent, and query an external API.
Annotations on every tool: `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true`.

### Tools

| Name | Description | Key Inputs |
|:-----|:------------|:-----------|
| `congressgov_bill_lookup` | Browse, filter, and retrieve bill data including actions, sponsors, summaries, full text, and related bills. | `operation`, `congress`, `billType`, `billNumber`, date range |
| `congressgov_enacted_laws` | Browse enacted public and private laws by congress. | `operation`, `congress`, `lawType`, `lawNumber` |
| `congressgov_member_lookup` | Discover members by state, district, or congress and retrieve legislative portfolios. | `operation`, `bioguideId`, `stateCode`, `district`, `congress` |
| `congressgov_committee_lookup` | Browse committees and retrieve associated legislation, reports, and nominations. | `operation`, `congress`, `chamber`, `committeeCode` |
| `congressgov_roll_votes` | Retrieve House roll call votes and member voting positions. Senate votes not yet in API. | `operation`, `congress`, `session`, `voteNumber` |
| `congressgov_senate_nominations` | Browse presidential nominations and track the Senate confirmation pipeline. | `operation`, `congress`, `nominationNumber` |
| `congressgov_bill_summaries` | Browse recent CRS bill summaries — the best "what's happening" feed. Defaults to last 7 days. | `congress`, `billType`, `fromDateTime`, `toDateTime` |
| `congressgov_crs_reports` | Browse and retrieve nonpartisan CRS policy analysis reports. | `operation`, `reportNumber` |
| `congressgov_committee_reports` | Browse and retrieve committee reports that accompany reported legislation. | `operation`, `congress`, `reportType`, `reportNumber` |
| `congressgov_daily_record` | Browse daily Congressional Record issues — floor speeches, debates, proceedings. | `operation`, `volumeNumber`, `issueNumber` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `congress://current` | Current congress number, session dates, and chamber info. Baseline context for queries. | No |
| `congress://bill-types` | Reference table of valid bill type codes (hr, s, hjres, etc.) with descriptions. | No |
| `congress://member/{bioguideId}` | Member profile: name, state, party, terms, leadership, office, legislation counts. | No |
| `congress://bill/{congress}/{billType}/{billNumber}` | Bill detail: sponsor, status, policy area, committees, latest action. | No |
| `congress://committee/{committeeCode}` | Committee detail: name, chamber, subcommittees, history, legislation counts. | No |

Member, bill, and committee resources expose the same data as the corresponding tool `get` operations. Resources enable context injection by the client; tools enable dynamic discovery within agent workflows.

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `congressgov_bill_analysis` | Structured framework for analyzing a bill: summary, sponsors, committee referrals, action timeline, related legislation, and policy implications. | `congress`, `billType`, `billNumber` |
| `congressgov_legislative_research` | Research framework for investigating a policy area across Congress: relevant bills, key members, committee activity, CRS reports, and floor activity. | `topic`, `congress` (optional) |

---

## Overview

An MCP server wrapping the [Congress.gov API v3](https://api.congress.gov/) — the official machine-readable interface to U.S. legislative data maintained by the Library of Congress. Exposes bills, laws, members, committees, votes, nominations, CRS reports, committee reports, and the Congressional Record to LLM agents.

**Target users:** Agents performing legislative research, policy analysis, civic education, government relations tracking, and journalism support.

**Key API constraint:** The Congress.gov API is a **browse-and-filter** API, not a search API. There is no full-text keyword search. Discovery happens by filtering on congress number, bill type, date range, chamber, state, and district. Tool descriptions guide agents toward these filtering strategies.

---

## License & Deployability

| Aspect | Detail |
|:-------|:-------|
| **Data license** | U.S. Government public domain (17 U.S.C. § 105). No restrictions on redistribution, commercial use, or derivative works. |
| **API access** | Free API key via [api.data.gov/signup](https://api.data.gov/signup/). No approval process. |
| **Rate limits** | 5,000 requests/hour per API key. |
| **Self-hosting OK?** | Yes. No terms prohibit proxying, caching, or rebroadcasting. |

---

## Requirements

- Read-only access to all major Congress.gov collections
- API key authentication via `api.data.gov` (free, 5,000 requests/hour)
- Offset/limit pagination (max 250 per request, default 20)
- JSON responses only (XML supported by API but unnecessary for MCP)
- Date range filtering on list endpoints (`fromDateTime` / `toDateTime`)
- Graceful handling of the "no search" constraint — tool descriptions guide agents toward browse/filter patterns
- Current congress number surfaced as a resource so the agent doesn't have to guess

---

## Tool Designs

### 1. `congressgov_bill_lookup`

The primary workhorse. Covers bills and resolutions (not enacted laws — see `congressgov_enacted_laws`).

```ts
operation: z.enum([
  'list',       // Browse bills by congress, type, and date range
  'get',        // Full detail for a specific bill
  'actions',    // Legislative action history (introduced → committee → floor → signed)
  'amendments', // Amendments proposed to a bill
  'cosponsors', // Members who cosponsored
  'committees', // Committees the bill was referred to
  'subjects',   // CRS-assigned legislative subject terms
  'summaries',  // CRS-written bill summaries (by legislative stage)
  'text',       // Available text versions (introduced, reported, enrolled, etc.)
  'titles',     // Official, short, and popular titles
  'related',    // Companion bills, identical bills, related legislation
])
```

**Parameters:**

| Param | Used by | Description |
|:------|:--------|:------------|
| `operation` | all | Which data to retrieve. |
| `congress` | all | Congress number (e.g., 118, 119). Required. |
| `billType` | list, get, sub-resources | Bill type code: `hr`, `s`, `hjres`, `sjres`, `hconres`, `sconres`, `hres`, `sres`. Required for `get` and sub-resources. |
| `billNumber` | get, sub-resources | Bill number (e.g., 3076). Required for `get` and sub-resource operations. |
| `fromDateTime` | list | Start of date range filter (ISO 8601). Filters by latest action date. |
| `toDateTime` | list | End of date range filter (ISO 8601). |
| `limit` | list, sub-resources | Results per page (1-250, default 20). |
| `offset` | list, sub-resources | Pagination offset. |

**Description:**
```
Browse and retrieve U.S. legislative bill data from Congress.gov.

IMPORTANT: This API has no keyword search. To find bills, filter by congress number,
bill type, and/or date range. Use 'congressgov_bill_summaries' to discover recently summarized
legislation, or 'congressgov_member_lookup' to find bills via their sponsor.

Operations:
- list: Browse bills. Requires 'congress'. Add 'billType' to narrow by chamber/type.
- get: Full bill detail including sponsor, policy area, CBO estimates, and law info.
- actions/amendments/cosponsors/committees/subjects/summaries/text/titles/related:
  Sub-resources for a specific bill. Require congress + billType + billNumber.

For enacted laws, use 'congressgov_enacted_laws' instead.
```

**Output:**
- **list**: `bills[]` — `congress`, `type`, `number`, `title`, `originChamber`, `latestAction { date, text }` + `pagination { count, nextOffset }`
- **get**: Full detail — `sponsor { bioguideId, name, party, state }`, `policyArea`, `cboEstimates`, `committees`, `latestAction`, `constitutionalAuthority`, `laws` (if enacted)
- **Sub-resources**: Parent bill ref (`congress`, `type`, `number`) + resource-specific data + pagination where applicable

**Format**: List → markdown table (type+number, title, latest action date). Detail → structured sections. Sub-resources → list or detail as appropriate.

**Error guidance:**
- Missing `billNumber` for sub-resource: "The '{operation}' operation requires congress, billType, and billNumber. Use 'list' first to find the bill, then request its {operation}."
- Bill not found: "No bill found for {billType} {billNumber} in the {congress}th Congress. Verify the bill type and number — use 'list' with a date range or check 'congressgov_bill_summaries' to discover bills."
- Invalid bill type: "Invalid bill type '{type}'. Valid types: hr, s, hjres, sjres, hconres, sconres, hres, sres."

---

### 2. `congressgov_enacted_laws`

Enacted legislation — public and private laws. Separated from `congressgov_bill_lookup` because laws use a different type system (`pub`/`priv` vs bill type codes) and represent a distinct lifecycle stage.

```ts
operation: z.enum([
  'list', // Browse enacted laws by congress, optionally by type
  'get',  // Specific law detail including origin bill reference
])
```

**Parameters:**

| Param | Used by | Description |
|:------|:--------|:------------|
| `operation` | all | Which data to retrieve. |
| `congress` | all | Congress number. Required. |
| `lawType` | list (optional), get | `pub` (public law) or `priv` (private law). Required for `get`. |
| `lawNumber` | get | Law number (e.g., 21). Required for `get`. |
| `limit` | list | Results per page (1-250, default 20). |
| `offset` | list | Pagination offset. |

**Description:**
```
Browse enacted public and private laws from Congress.gov.

Use 'list' to browse laws by congress. Each law references its origin bill —
use 'congressgov_bill_lookup' with that reference for the full legislative history.

Law types:
- pub: Public laws (general application, most common)
- priv: Private laws (specific individuals or entities)
```

**Output:**
- **list**: `laws[]` — `number`, `type` (pub/priv), `congress`, `title`, `originBill { type, number }`, `dateApproved` + pagination
- **get**: Full detail — origin bill reference, approval date, statute citation, associated bill data

**Format**: List → markdown table (law number, title, date approved). Detail → structured sections with origin bill link.

**Error guidance:**
- Law not found: "No {lawType} law {lawNumber} found in the {congress}th Congress. Use 'list' to browse enacted laws for this congress."
- Missing `lawType` for get: "The 'get' operation requires lawType ('pub' or 'priv') and lawNumber."

---

### 3. `congressgov_member_lookup`

Member discovery and legislative portfolios.

```ts
operation: z.enum([
  'list',        // Browse members by congress, state, district
  'get',         // Full member profile (terms, leadership, contact)
  'sponsored',   // Legislation this member sponsored
  'cosponsored', // Legislation this member cosponsored
])
```

**Parameters:**

| Param | Used by | Description |
|:------|:--------|:------------|
| `operation` | all | Which data to retrieve. |
| `bioguideId` | get, sponsored, cosponsored | Unique member identifier (e.g., `P000197`). Required for detail operations. |
| `congress` | list | Congress number to filter by. |
| `stateCode` | list | Two-letter state code (e.g., `CA`, `TX`). |
| `district` | list | Congressional district number. Requires `stateCode`. Use `0` for at-large. |
| `currentMember` | list | Filter to currently serving members. Defaults to `false` — returns all members matching other filters. Set `true` to show only current members. |
| `limit` | list, sponsored, cosponsored | Results per page (1-250). |
| `offset` | list, sponsored, cosponsored | Pagination offset. |

**Description:**
```
Discover congressional members and their legislative activity.

The API does not support name search. To find a member:
- By location: use 'list' with stateCode (and optionally district)
- By congress: use 'list' with congress number
- By current status: use 'list' with currentMember=true

Once you have a bioguideId, use 'get' for full profile or
'sponsored'/'cosponsored' for legislative portfolio. The bioguideId
also works with the congress://member/{bioguideId} resource.
```

**Output:**
- **list**: `members[]` — `bioguideId`, `name`, `state`, `district`, `party`, `chamber` + pagination
- **get**: Full profile — `terms[]`, `leadership`, `office`, `sponsoredCount`, `cosponsoredCount`, `depiction`
- **sponsored/cosponsored**: `legislation[]` — `congress`, `type`, `number`, `title`, `latestAction { date, text }` + pagination

**Format**: List → markdown table (name, state, party, chamber). Detail → structured profile. Legislation → table (bill ref, title, latest action).

**Error guidance:**
- Member not found: "No member found for bioguideId '{id}'. Use 'list' with stateCode or congress to discover members."
- District without state: "The 'district' parameter requires 'stateCode'. Provide both to look up a specific House representative."
- Empty results with currentMember: "No current members found for the given filters. Set currentMember=false or adjust stateCode/congress to broaden the search."

---

### 4. `congressgov_committee_lookup`

Committee structure and activity.

```ts
operation: z.enum([
  'list',        // Browse committees by congress and chamber
  'get',         // Committee detail (subcommittees, history, counts)
  'bills',       // Legislation referred to this committee
  'reports',     // Committee reports
  'nominations', // Nominations referred (Senate committees only)
])
```

**Parameters:**

| Param | Used by | Description |
|:------|:--------|:------------|
| `operation` | all | Which data to retrieve. |
| `congress` | list | Congress number. |
| `chamber` | list, get, bills, reports, nominations | `house`, `senate`, or `joint`. Required for `get` and sub-resources. |
| `committeeCode` | get, bills, reports, nominations | Committee system code (e.g., `hsju00` for House Judiciary). Required for detail operations. Codes ending in `00` are parent committees; other suffixes are subcommittees. |
| `limit` | all | Results per page (1-250). |
| `offset` | all | Pagination offset. |

**Description:**
```
Browse congressional committees and their legislation, reports, and nominations.

Committee codes follow the pattern: chamber prefix (h/s/j) + abbreviation + number.
Use 'list' to discover codes, then drill into bills, reports, or nominations.

The 'nominations' operation is available for Senate committees only.
The committeeCode also works with the congress://committee/{committeeCode} resource.
```

**Output:**
- **list**: `committees[]` — `systemCode`, `name`, `chamber`, `committeeType`, `subcommittees[]` + pagination
- **get**: Full detail — `name`, `chamber`, `history`, `subcommittees[]`, bill/report/nomination counts
- **bills**: `bills[]` — `congress`, `type`, `number`, `title`, `latestAction` + pagination
- **reports**: `reports[]` — `congress`, `type`, `number`, `title` + pagination
- **nominations**: `nominations[]` — `congress`, `number`, `description`, `latestAction` + pagination

**Format**: List → markdown table (code, name, chamber). Sub-resources → table of items with key fields.

**Error guidance:**
- Nominations on House committee: "Nominations are only referred to Senate committees. Use chamber='senate' or a Senate committee code (s-prefix)."
- Committee not found: "Committee '{code}' not found. Use 'list' with congress and chamber to discover available committees."
- Empty sub-resource: "No {resource} found for committee {code} in the {congress}th Congress. The committee may not have reported any {resource} yet."

---

### 5. `congressgov_roll_votes`

Roll call votes and individual member positions. House only — Senate vote endpoint not yet in the API.

```ts
operation: z.enum([
  'list',    // Browse votes by congress and session
  'get',     // Vote detail (question, result, bill reference)
  'members', // How each member voted (yea/nay/present/not voting)
])
```

**Parameters:**

| Param | Used by | Description |
|:------|:--------|:------------|
| `operation` | all | Which data to retrieve. |
| `congress` | all | Congress number. Required. |
| `session` | all | Session number (1 or 2). Required. Odd years are session 1, even years session 2. |
| `voteNumber` | get, members | Roll call vote number. Required for detail operations. |
| `limit` | list, members | Results per page (1-250). |
| `offset` | list, members | Pagination offset. |

**Description:**
```
Retrieve House roll call vote data and individual member voting positions.

NOTE: Covers House votes only — Senate vote data is not yet in the Congress.gov API.

Use 'list' to find votes by congress and session, 'get' for vote details
(question, result, associated bill), and 'members' for how each representative voted.
```

**Output:**
- **list**: `votes[]` — `congress`, `session`, `voteNumber`, `date`, `question`, `result` + pagination
- **get**: `congress`, `session`, `voteNumber`, `date`, `question`, `result`, `bill { type, number, title }`, `totals { yea, nay, present, notVoting }`
- **members**: `positions[]` — `bioguideId`, `name`, `party`, `state`, `vote` (Yea/Nay/Present/Not Voting)

**Format**: List → markdown table (vote#, date, question, result). Members → table grouped by vote position.

**Error guidance:**
- Missing session: "The 'session' parameter is required. Each congress has two sessions — session 1 for odd years, session 2 for even years."
- Vote not found: "No roll call vote {voteNumber} found in session {session} of the {congress}th Congress. Use 'list' to browse available votes."
- Senate vote request: "Senate vote data is not available in the Congress.gov API. This tool covers House roll call votes only."

---

### 6. `congressgov_senate_nominations`

Presidential nominations and the Senate confirmation pipeline.

```ts
operation: z.enum([
  'list',       // Browse nominations by congress
  'get',        // Nomination detail (nominees, organization, status)
  'nominees',   // Individual nominees for a nomination
  'actions',    // Actions taken (referred, hearing, confirmed/rejected)
  'committees', // Senate committees the nomination was referred to
  'hearings',   // Confirmation hearings held
])
```

**Parameters:**

| Param | Used by | Description |
|:------|:--------|:------------|
| `operation` | all | Which data to retrieve. |
| `congress` | all | Congress number. Required. |
| `nominationNumber` | get, nominees, actions, committees, hearings | Nomination number (e.g., `1064`). Required for detail operations. |
| `ordinal` | nominees | Position ordinal within a nomination (for multi-nominee nominations). |
| `limit` | list, sub-resources | Results per page (1-250). |
| `offset` | list, sub-resources | Pagination offset. |

**Description:**
```
Browse presidential nominations to federal positions and track the Senate
confirmation process.

Nominations use 'PN' (Presidential Nomination) numbering. A single nomination
may contain multiple nominees — use 'nominees' to see individual appointees.

Partitioned nominations (e.g., PN230-1, PN230-2) occur when nominees within
one nomination follow different confirmation paths.
```

**Output:**
- **list**: `nominations[]` — `congress`, `number`, `description`, `organization`, `latestAction { date, text }`, `receivedDate` + pagination
- **get**: Full detail — `nominees[]`, `organization`, `positions`, `latestAction`, `committees`, `actions`
- **nominees**: `nominees[]` — `ordinal`, `name`, `state`, `position`, `organization`
- **actions**: `actions[]` — `date`, `text`, `actionCode`
- **committees**: `committees[]` — `systemCode`, `name`, `chamber`, `referralDate`
- **hearings**: `hearings[]` — `date`, `committee`, `number`

**Format**: List → markdown table (PN number, description, organization, latest action). Sub-resources → appropriate table format.

**Error guidance:**
- Nomination not found: "No nomination {number} found in the {congress}th Congress. Use 'list' to browse nominations."
- No hearings: "No hearings found for nomination {number}. The nomination may not have reached the hearing stage yet."
- Empty nominees: "No individual nominee data available for nomination {number}. Some nominations list nominees only in the description field."

---

### 7. `congressgov_bill_summaries`

The activity feed. Single-purpose tool — no operation enum.

**Parameters:**

| Param | Description |
|:------|:------------|
| `congress` | Congress number. Optional — omit for summaries across all congresses. |
| `billType` | Bill type filter (hr, s, etc.). Requires `congress`. |
| `fromDateTime` | Start of date range (ISO 8601). Defaults to 7 days ago if neither date param is set. |
| `toDateTime` | End of date range (ISO 8601). Defaults to now. |
| `limit` | Results per page (1-250, default 20). |
| `offset` | Pagination offset. |

**Description:**
```
Browse recent CRS (Congressional Research Service) bill summaries.

This is the best tool for answering "what's happening in Congress?" — CRS
analysts write plain-language summaries of bills at each legislative stage.

By default, returns summaries from the last 7 days. Specify fromDateTime/toDateTime
for custom ranges. Each summary includes the associated bill reference
(congress, type, number) for follow-up with congressgov_bill_lookup.
```

**Output:** `summaries[]` — `congress`, `billType`, `billNumber`, `title`, `text` (summary body), `actionDate`, `versionCode`, `currentChamber` + pagination

**Format**: Markdown sections — bill reference as header, summary text, action date. Truncate summary text at 500 chars with "(truncated — use congressgov_bill_lookup summaries operation for full text)" when needed.

**Error guidance:**
- No summaries in range: "No CRS summaries published between {from} and {to}. Try widening the date range — CRS summaries are published on business days only."
- `billType` without `congress`: "The 'billType' filter requires 'congress'. Provide both or omit billType to browse across all types."

---

### 8. `congressgov_crs_reports`

Nonpartisan policy analysis from the Congressional Research Service. Separated from committee reports — different identifiers, different parameter sets, different domain.

```ts
operation: z.enum([
  'list', // Browse CRS reports
  'get',  // Report detail (authors, topics, summary, download links)
])
```

**Parameters:**

| Param | Used by | Description |
|:------|:--------|:------------|
| `operation` | all | Which data to retrieve. |
| `reportNumber` | get | CRS report ID (e.g., `R40097`). Required for `get`. |
| `limit` | list | Results per page (1-250). |
| `offset` | list | Pagination offset. |

**Description:**
```
Browse and retrieve CRS (Congressional Research Service) reports — nonpartisan
policy analyses written by subject-matter experts at the Library of Congress.

CRS reports cover policy areas, legislative proposals, and legal questions.
Report IDs use letter-number codes (e.g., R40097, RL33612, IF12345).

Use 'list' to browse available reports, 'get' for full detail including
authors, topics, summary, and available download formats.
```

**Output:**
- **list**: `reports[]` — `reportNumber`, `title`, `date`, `topics[]` + pagination
- **get**: Full detail — `reportNumber`, `title`, `authors[]`, `date`, `topics[]`, `summary`, `formats[]` (PDF, HTML links)

**Format**: List → markdown table (report ID, title, date). Detail → structured sections with summary text.

**Error guidance:**
- Report not found: "No CRS report '{reportNumber}' found. Report IDs use letter-number codes (e.g., R40097). Use 'list' to browse available reports."

---

### 9. `congressgov_committee_reports`

Committee reports that accompany legislation reported out of committee. Separated from CRS reports — different identifiers (`congress/type/number` vs CRS report IDs), different parameters, different purpose.

```ts
operation: z.enum([
  'list', // Browse committee reports by congress and type
  'get',  // Report detail
  'text', // Report text versions
])
```

**Parameters:**

| Param | Used by | Description |
|:------|:--------|:------------|
| `operation` | all | Which data to retrieve. |
| `congress` | all | Congress number. Required. |
| `reportType` | list (optional), get, text | `hrpt` (House), `srpt` (Senate), `erpt` (Executive). |
| `reportNumber` | get, text | Committee report number. Required for detail operations. |
| `limit` | list | Results per page (1-250). |
| `offset` | list | Pagination offset. |

**Description:**
```
Browse and retrieve committee reports from Congress.gov.

Committee reports accompany legislation reported out of committee. They explain
the bill's purpose, committee amendments, dissenting views, and the committee vote.

Report types:
- hrpt: House reports
- srpt: Senate reports
- erpt: Executive reports
```

**Output:**
- **list**: `reports[]` — `congress`, `type`, `number`, `title`, `chamber`, `associatedBill { type, number }` + pagination
- **get**: Full detail — `congress`, `type`, `number`, `title`, `committee`, `associatedBill`, `issueDate`
- **text**: `versions[]` — `type`, `date`, `formats[]` (PDF, HTML links)

**Format**: List → markdown table (type+number, title, associated bill). Detail → structured sections.

**Error guidance:**
- Report not found: "No {reportType} report {reportNumber} found in the {congress}th Congress. Use 'list' to browse available reports."
- Invalid report type: "Invalid report type '{type}'. Valid types: hrpt (House), srpt (Senate), erpt (Executive)."

---

### 10. `congressgov_daily_record`

Daily Congressional Record — published each day Congress is in session. Separated from the bound record because the navigation model and parameters are completely different (volume/issue hierarchy vs date-based lookup).

```ts
operation: z.enum([
  'list',     // Browse daily Congressional Record issues
  'issues',   // Issues within a specific volume
  'articles', // Articles within a specific issue
])
```

**Parameters:**

| Param | Used by | Description |
|:------|:--------|:------------|
| `operation` | all | Which data to retrieve. |
| `volumeNumber` | issues, articles | Volume number. Required for drill-down operations. |
| `issueNumber` | articles | Issue number within a volume. Required for `articles`. |
| `limit` | list, articles | Results per page (1-250). |
| `offset` | list, articles | Pagination offset. |

**Description:**
```
Browse the daily Congressional Record — floor speeches, debates, and legislative
text published each day Congress is in session.

Navigation is hierarchical: list → volumes, issues → individual articles.
Use 'list' to find recent volumes, 'issues' to see what's in a volume,
and 'articles' to access individual speeches and debate sections.

For the permanent edited compilation, use 'congressgov_bound_record' instead.
```

**Output:**
- **list**: `issues[]` — `volumeNumber`, `issueNumber`, `date`, `congress`, `sessionNumber` + pagination
- **issues**: `issues[]` — `issueNumber`, `date`, `sections[]` (Digest, Senate, House, Extensions)
- **articles**: `articles[]` — `title`, `type`, `startPage`, `members[]`

**Format**: List → markdown table (volume, issue, date). Articles → table (title, type, start page).

**Error guidance:**
- Volume not found: "Volume {volumeNumber} not found. Use 'list' to browse available Congressional Record volumes."
- Issue not found: "Issue {issueNumber} not found in volume {volumeNumber}. Use 'issues' to see available issues within this volume."

---

## Cross-Cutting Error Handling

All tools share these error patterns. The service layer handles them uniformly.

| Condition | Error Message |
|:----------|:-------------|
| Rate limit hit | "Congress.gov API rate limit reached (5,000 requests/hour). Wait before retrying — the limit resets hourly." |
| API unavailable (5xx) | "Congress.gov API returned HTTP {status}. The service may be temporarily unavailable — retry after a brief wait." |
| Empty results | "No {entity} found for the given filters. Try broadening the search — adjust the congress number, date range, or remove optional filters." |
| Invalid congress number | "Congress {n} is not valid. The current congress is {current}. Congress numbers are positive integers starting at 1 (1789)." |
| Network error | "Unable to reach the Congress.gov API. Check network connectivity and try again." |

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `CongressApiService` | Congress.gov REST API v3 — auth, pagination, rate limiting, response normalization | All tools and resources |

Single service. The Congress.gov API is one coherent REST API with consistent patterns.

### CongressApiService Design

```ts
class CongressApiService {
  constructor(config: { apiKey: string; baseUrl: string }) {}

  // Bills
  async listBills(params: ListBillsParams): Promise<BillListResponse>;
  async getBill(congress: number, type: string, number: number): Promise<BillDetailResponse>;
  async getBillSubResource(congress: number, type: string, number: number, sub: BillSubResource): Promise<BillSubResourceResponse>;

  // Laws
  async listLaws(congress: number, type?: 'pub' | 'priv', params?: PaginationParams): Promise<LawListResponse>;
  async getLaw(congress: number, type: string, number: number): Promise<LawDetailResponse>;

  // Members
  async listMembers(params: ListMembersParams): Promise<MemberListResponse>;
  async getMember(bioguideId: string): Promise<MemberDetailResponse>;
  async getMemberLegislation(bioguideId: string, type: 'sponsored' | 'cosponsored', params?: PaginationParams): Promise<LegislationListResponse>;

  // Committees
  async listCommittees(params: ListCommitteesParams): Promise<CommitteeListResponse>;
  async getCommittee(chamber: string, code: string): Promise<CommitteeDetailResponse>;
  async getCommitteeSubResource(chamber: string, code: string, sub: CommitteeSubResource): Promise<CommitteeSubResourceResponse>;

  // Votes
  async listVotes(congress: number, session: number, params?: PaginationParams): Promise<VoteListResponse>;
  async getVote(congress: number, session: number, voteNumber: number): Promise<VoteDetailResponse>;
  async getVoteMembers(congress: number, session: number, voteNumber: number): Promise<VoteMembersResponse>;

  // Nominations
  async listNominations(congress: number, params?: PaginationParams): Promise<NominationListResponse>;
  async getNomination(congress: number, number: number): Promise<NominationDetailResponse>;
  async getNominationSubResource(congress: number, number: number, sub: NominationSubResource): Promise<NominationSubResourceResponse>;

  // Summaries
  async listSummaries(params: ListSummariesParams): Promise<SummaryListResponse>;

  // CRS Reports
  async listCrsReports(params?: PaginationParams): Promise<CrsReportListResponse>;
  async getCrsReport(reportNumber: string): Promise<CrsReportDetailResponse>;

  // Committee Reports
  async listCommitteeReports(congress: number, type?: string, params?: PaginationParams): Promise<CommitteeReportListResponse>;
  async getCommitteeReport(congress: number, type: string, number: number): Promise<CommitteeReportDetailResponse>;
  async getCommitteeReportText(congress: number, type: string, number: number): Promise<CommitteeReportTextResponse>;

  // Daily Congressional Record
  async listDailyRecord(params?: PaginationParams): Promise<DailyRecordListResponse>;
  async getDailyIssues(volumeNumber: number): Promise<DailyIssuesResponse>;
  async getDailyArticles(volumeNumber: number, issueNumber: number): Promise<DailyArticlesResponse>;

  // Congress metadata
  async getCurrentCongress(): Promise<CongressDetailResponse>;
}
```

**Internal concerns:**
- API key injected via `?api_key=` query parameter — ensure key is not included in logs
- Pagination: `offset` and `limit` as query params, return `pagination` metadata
- Rate limiting: track request count per hour window, throw `rateLimited()` before hitting 5,000/hr ceiling
- Response normalization: request `format=json`, strip wrapper elements, return typed data
- Native `fetch` — no SDK dependency

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `CONGRESS_API_KEY` | Yes | API key from [api.data.gov](https://api.data.gov/signup/) (free, 5,000 req/hr) |
| `CONGRESS_API_BASE_URL` | No | API base URL. Defaults to `https://api.congress.gov/v3` |

---

## Implementation Order

1. **Config** — `server-config.ts` with Zod schema for `CONGRESS_API_KEY`, base URL
2. **CongressApiService** — API client with auth, pagination, rate limiting, typed methods
3. **`congressgov_bill_lookup`** — Primary workflow
4. **`congressgov_enacted_laws`** — Thin tool, quick after bills service methods exist
5. **`congressgov_member_lookup`** — Second most-used, enables "who represents X"
6. **`congressgov_bill_summaries`** — Activity feed, high discovery value
7. **`congressgov_committee_lookup`** — Committee activity and legislation
8. **`congressgov_roll_votes`** — Roll call data and positions
9. **`congressgov_senate_nominations`** — Confirmation pipeline
10. **`congressgov_crs_reports`** — CRS policy reports
11. **`congressgov_committee_reports`** — Committee reports
12. **`congressgov_daily_record`** — Daily floor proceedings
13. **Resources** — `congress://current`, `congress://bill-types`, member, bill, committee
14. **Prompts** — `congressgov_bill_analysis`, `congressgov_legislative_research`

Each step is independently testable after the service layer is in place.

---

## Design Decisions

### No keyword search — by design

The Congress.gov API does not expose full-text search. Every tool description guides agents toward browse/filter strategies:

- **Find a specific bill:** Filter by congress + bill type, or discover via a member's sponsored legislation
- **Find bills on a topic:** Use `congressgov_bill_summaries` with date ranges, or `congressgov_crs_reports` for policy areas
- **Find a member by name:** List members by state/congress, scan results

### Domain-specific tools with operation enums

The existing [MCP Congress server](https://github.com/bsmi021/mcp-congress_gov_server) uses 2 generic tools — forcing the LLM to construct URIs. This design uses 10 domain-specific tools grouped by noun, each with operations that share parameter patterns.

Split decisions:
- **Bills vs. Laws**: Different type systems (`hr`/`s` vs `pub`/`priv`), different conceptual entities
- **CRS Reports vs. Committee Reports**: Different identifiers (letter-number codes vs congress/type/number), different parameter sets, different domains

### Resources for stable lookups

Member, bill, and committee detail are exposed as both tool `get` operations and URI-addressable resources. Resources enable context injection (client pre-loads); tools enable dynamic discovery within agent workflows.

### Summaries as first-class tool

The `/summaries` endpoint is the closest thing to an activity feed. By defaulting to a 7-day window (the API defaults to 1 day), `congressgov_bill_summaries` becomes the "what's happening" entry point.

### House votes only (for now)

The Congress.gov API exposes House votes but not Senate votes. When Senate votes are added, `congressgov_roll_votes` extends with a `chamber` parameter.

### No SDK dependency

[`congress-gov-sdk`](https://www.npmjs.com/package/congress-gov-sdk) exists but uses Axios, is 0.1.x, and adds unnecessary overhead. The API is straightforward REST — a thin `fetch` client gives full control.

---

## API Reference

### Pagination

All list endpoints use offset/limit: `offset` (default 0), `limit` (default 20, max 250). Responses include `pagination.count` and `pagination.next`.

### Date Filtering

Most list endpoints support `fromDateTime`/`toDateTime` (ISO 8601) for action date or update date. Summaries filter by publish date.

### Authentication

All requests require `?api_key={key}` as a query parameter.

### Rate Limits

5,000 requests/hour per API key.

### Bill Types

| Code | Description |
|:-----|:------------|
| `hr` | House Bill |
| `s` | Senate Bill |
| `hjres` | House Joint Resolution |
| `sjres` | Senate Joint Resolution |
| `hconres` | House Concurrent Resolution |
| `sconres` | Senate Concurrent Resolution |
| `hres` | House Simple Resolution |
| `sres` | Senate Simple Resolution |

### Key Identifiers

| Entity | Identifier | Example |
|:-------|:-----------|:--------|
| Bill | `{congress}/{billType}/{billNumber}` | `118/hr/1234` |
| Law | `{congress}/{lawType}/{lawNumber}` | `118/pub/21` |
| Member | `bioguideId` | `P000197` |
| Committee | `{chamber}/{systemCode}` | `house/hsju00` |
| Nomination | `{congress}/{nominationNumber}` | `118/1064` |
| Vote | `{congress}/{session}/{voteNumber}` | `118/1/234` |
| CRS Report | `reportNumber` | `R40097` |

---

## Future Considerations

- **Senate votes**: Extend `congressgov_roll_votes` with `chamber` when the API adds Senate endpoints
- **Bound Congressional Record**: Date-based lookup into the permanent edited compilation. Niche archival use case — daily record covers active needs. Add as `congressgov_bound_record` if demand warrants.
- **Full-text search**: Add `congressgov_search` if Congress.gov ever exposes a search API
- **Treaties and hearings**: Lower-frequency endpoints, add as separate tools if demand warrants
- **House/Senate communications**: Niche endpoints — add only for specific use cases

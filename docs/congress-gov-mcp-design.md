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
| `congressgov_roll_votes` | Retrieve House and Senate roll call votes and member voting positions. | `operation`, `chamber`, `congress`, `session`, `voteNumber`, `bioguideId`, `stateCode`, `party` |
| `congressgov_senate_nominations` | Browse presidential nominations and track the Senate confirmation pipeline. | `operation`, `congress`, `nominationNumber`, `fromDateTime`, `toDateTime` |
| `congressgov_bill_summaries` | Browse recent CRS bill summaries — the best "what's happening" feed. Defaults to last 7 days. | `congress`, `billType`, `fromDateTime`, `toDateTime` |
| `congressgov_crs_reports` | Browse and retrieve nonpartisan CRS policy analysis reports. | `operation`, `reportNumber`, `fromDateTime`, `toDateTime` |
| `congressgov_committee_reports` | Browse and retrieve committee reports that accompany reported legislation. | `operation`, `congress`, `reportType`, `reportNumber`, `part`, `conference` |
| `congressgov_daily_record` | Browse daily Congressional Record issues — floor speeches, debates, proceedings. | `operation`, `volumeNumber`, `issueNumber` |
| `congressgov_amendment_lookup` | Browse and retrieve House and Senate amendments: sponsor, amended bill, actions, cosponsors, text. | `operation`, `congress`, `amendmentType`, `amendmentNumber`, `textVersionIndex`, date range |

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

An MCP server wrapping the [Congress.gov API v3](https://api.congress.gov/) — the official machine-readable interface to U.S. legislative data maintained by the Library of Congress. Exposes bills, amendments, laws, members, committees, votes, nominations, CRS reports, committee reports, and the Congressional Record to LLM agents.

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
  'content',    // The selected text version's actual document text, one window at a time
])
```

**Parameters:**

| Param | Used by | Description |
|:------|:--------|:------------|
| `operation` | all | Which data to retrieve. |
| `congress` | all | Congress number (e.g., 118, 119). Required. |
| `billType` | list, get, sub-resources | Bill type code: `hr`, `s`, `hjres`, `sjres`, `hconres`, `sconres`, `hres`, `sres`. Required for `get` and sub-resources. |
| `billNumber` | get, sub-resources | Bill number (e.g., 3076). Required for `get` and sub-resource operations. |
| `textVersionIndex` | content | Which text version to read: its 0-based position in the rows `text` returns, counted across pages. Dated versions run newest first; an enrolled bill's undated Enrolled Bill version is 0, and an enacted bill's Public Law version is last. Each `text` row carries the `textVersionIndex` that reads it. Default 0. |
| `format` | content | `text` (GPO Formatted Text) or `xml` (USLM, falling back to Formatted XML). Default `text`. |
| `characterOffset` | content | First character of the window, 0-based. Default 0. |
| `characterLimit` | content | Maximum characters in the window (1-100,000). Default 25,000. |
| `fromDateTime` | list | Start of date range filter (ISO 8601). Filters by the record's update date, not its latest legislative action. Other operations serve the call and name it in the notice as ignored. |
| `toDateTime` | list | End of date range filter (ISO 8601). Same semantics and notice as `fromDateTime`. |
| `limit` | list, sub-resources | Results per page (1-250, default 20). |
| `offset` | list, sub-resources | Pagination offset. |

`type` and `number` normalize to `billType` and `billNumber`; bill types are case-insensitive, and any-case `relatedbills` normalizes to `related`. Canonical and alias keys together are rejected. The advertised canonical input schema remains unchanged.

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
- **actions**: each row that records exactly one roll call vote carries `rollVote` — `{ chamber, congress, session, voteNumber }`, the `congressgov_roll_votes` arguments for it. A row recording no vote or several gets none, nor does a vote that tool has no data for (House before the 115th Congress, Senate before the 101st).
- **list**: `bills[]` — `congress`, `type`, `number`, `title`, `originChamber`, `latestAction { date, text }` + `pagination { count, nextOffset }`
- **get**: Full detail — `sponsor { bioguideId, name, party, state }`, `policyArea`, `cboEstimates`, `committees`, `latestAction`, `constitutionalAuthority`, `laws` (if enacted)
- **text**: each row carries `textVersionIndex`, the index `content` reads that version by
- **Sub-resources**: Parent bill ref (`congress`, `type`, `number`) + resource-specific data + pagination where applicable

**Format**: List → markdown table (type+number, title, latest action date). Detail → structured sections. Sub-resources → list or detail as appropriate.

**Error guidance:**
- Missing `billNumber` for sub-resource: "The '{operation}' operation requires congress, billType, and billNumber. Use 'list' first to find the bill, then request its {operation}."
- Bill not found: "No bill found for {billType} {billNumber} in the {congress ordinal} Congress. Verify the bill type and number — use 'list' with a date range or check 'congressgov_bill_summaries' to discover bills."
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
| `lawType` | list (optional), get | `pub` (public law) or `priv` (private law), in any letter case (CRS related materials carry `PUB`). Required for `get`. |
| `lawNumber` | get | Law number, as a list row's `laws[].number` (`118-90`) or its bare number (`90`). Required for `get`; `list` refuses it. |
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
- Law not found: "No {lawType} law {lawNumber} found in the {congress ordinal} Congress. Use 'list' to browse enacted laws for this congress."
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
| `bioguideId` | get, sponsored, cosponsored | Unique member identifier (e.g., `P000197`). Required for detail operations; `list` refuses it. |
| `congress` | list | Congress number to filter by. `get`, `sponsored`, and `cosponsored` serve the call, name it as ignored, and note that results span every congress. |
| `stateCode` | list | Two-letter state code (e.g., `CA`, `TX`). Other operations name it as ignored. |
| `district` | list | Congressional district number. Requires `stateCode`. Use `0` for at-large. Other operations name it as ignored. |
| `currentMember` | list | Filter to currently serving members. Defaults to `false` — returns all members matching other filters. Set `true` to show only current members. Other operations name it as ignored. |
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
| `congress` | list | Congress number. A committee's bills, reports, and nominations span every congress, so the detail operations name it as ignored. |
| `filter` | list | Committee name match; fuzzy hits are labeled `approximate`. Detail operations name it as ignored. |
| `chamber` | list, get, bills, reports, nominations | `house`, `senate`, or `joint`, in any letter case. Optional: `list` filters by it, and for detail operations the committee's chamber is inferred from the code prefix when omitted, or read from the committee roster when the prefix names no chamber or one that doesn't hold the code. It also scopes name resolution: a committee name passed as `committeeCode` resolves among that chamber's committees only, and the resolved committee is fetched in the chamber its roster row names; a lone approximate match within the chamber comes back as a candidate rather than resolving. |
| `committeeCode` | get, bills, reports, nominations | Committee system code (e.g., `hsju00` for House Judiciary), in any letter case. Required for detail operations. Most codes are a chamber prefix, letters, and two digits; historical ones such as `n79043125` and `sp2k00` are not, and a `00` suffix marks most parent committees but not all (the `n…` committees carry none, and a few subcommittees end in `00`). A value of the letters-plus-two-digits shape is read as a code in its prefix's chamber; any other value is matched against the roster's codes first, at no extra request, then resolved as a committee name, and must contain a letter or digit. `list` refuses it; a committee name belongs in `filter`. |
| `fromDateTime` / `toDateTime` | bills, reports | ISO 8601 bounds of an update-date window. A row matches when Congress.gov updated it at any time inside the window, so a window returns the rows added in it plus older rows touched in it. Validated on every operation; `list`, `get`, and `nominations` name them as ignored (Congress.gov ignores the window on a committee's nominations). |
| `order` | bills | `recent` (default) reverses Congress.gov's order, which runs roughly from least to most recently updated; `oldest` keeps it. |
| `limit` | all | Results per page (1-250). |
| `offset` | all | Pagination offset. |

**Description:**
```
Browse congressional committees and their legislation, reports, and nominations.

Use 'list' to discover committee codes, the systemCode on each row, then drill
into bills, reports, or nominations. bills and reports take an update-date window.

The 'nominations' operation is available for Senate committees only.
The committeeCode also works with the congress://committee/{committeeCode} resource.
```

**Output:**
- **list**: `committees[]` — `systemCode`, `name`, `chamber`, `committeeTypeCode`, `updateDate`, `url`, and `parent` on a subcommittee + pagination
- **get**: Full detail — `history`, `subcommittees[]`, `type`, bill/report/nomination counts
- **bills**: `bills[]` — `congress`, `type`, `number`, `actionDate`, `relationshipType`, `updateDate`, `url` (no title) + pagination
- **reports**: `reports[]` — `citation`, `congress`, `type`, `number`, `part`, `chamber`, `updateDate`, `url` + pagination
- **nominations**: `nominations[]` — `congress`, `number`, `description`, `latestAction` + pagination

**Format**: List → markdown table (code, name, chamber). Sub-resources → table of items with key fields.

**Error guidance:**
- Nominations on House committee: "Nominations are only referred to Senate committees. Use chamber='senate' or a Senate committee code."
- Committee not found: "Committee '{code}' not found. Use 'list' with congress and chamber to discover available committees."
- Empty sub-resource: "No {resource} found for committee {code}." With a window: "No {resource} found for committee {code} with an update inside the fromDateTime/toDateTime window. Widen or remove the window."

---

### 5. `congressgov_roll_votes`

Roll call votes and individual member positions for both chambers. House data comes from the Congress.gov API; Senate data comes from the Senate's official LIS XML feed, or from Voteview's published vote files when that feed can't answer.

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
| `chamber` | all | `house` (default) or `senate`, in any letter case. Roll numbers are chamber-specific and reset each session. |
| `session` | all | Session number (1 or 2). Required. A congress's first year is session 1 and its second year session 2; a second session can run into January 1–3 of the following year. |
| `voteNumber` | get, members | Roll call vote number. Required for detail operations; `list` refuses it. |
| `bioguideId` | members | Return only the member with this bioguide ID (one letter and six digits, any case). House only: a Senate `members` call fails `unsupported_filter`, whichever source answers. `list` and `get` serve the call and name it as ignored. |
| `stateCode` | members | Return only one state's or territory's members, by two-letter code in any case. `list` and `get` name it as ignored. |
| `party` | members | Return only one party, by the one- or two-letter roster code (`D`, `R`, `I`) in any case. `list` and `get` name it as ignored. |
| `order` | list | `recent` (default, the session's latest roll call first) or `oldest` (roll call 1 first), by roll call number in both chambers. |
| `limit` | list, members | Results per page (1-250). |
| `offset` | list, members | Pagination offset. |

The `members` filters combine (a position must match every one) and apply before paging: `pagination.count` counts the matching positions, and `memberFilter` echoes the filters with `rosterCount`, the positions the vote records before filtering. House votes are covered from the 115th Congress (2017), Senate votes from the 101st (1989). A House `get` or `members` call below the 115th fails `not_found` before any request. Senate calls the LIS feed can't answer are served from Voteview and carry `source` (see "Senate votes fall back to Voteview" below).

**Description:**
```
Retrieve House and Senate roll call vote data and individual member voting positions.

House votes use the Congress.gov API; Senate votes use the Senate's official LIS feed,
or Voteview's published vote files when that feed can't be read ('source' names Voteview
and its latest vote).

Use 'list' to find votes by congress and session, 'get' for vote details
(question, result, associated measure), and 'members' for how each member voted;
'members' narrows the roster by bioguideId (House only), stateCode, and party.
A bill action that records a roll call carries rollVote in congressgov_bill_lookup
'actions' — pass its chamber, congress, session, and voteNumber here. A House vote on an
amendment carries amendmentType and amendmentNumber; pass them to congressgov_amendment_lookup.
```

**Output:**
- **list**: `votes[]` — `congress`, `session`, `voteNumber`, `date`, `question`, `result` + pagination
- **get**: `congress`, `session`, `voteNumber`, `date`, `question`, `result`, `bill { type, number, title }`, `totals { yea, nay, present, notVoting }`
- **members**: `positions[]` — `bioguideId` (House rows, and Senate rows Voteview serves; the Senate LIS feed carries `lisMemberId` instead), `name`, `party`, `state`, `vote` (Yea/Nay/Present/Not Voting); `memberFilter { bioguideId?, stateCode?, party?, rosterCount }` when filters were supplied

**Format**: List → markdown table (vote#, date, question, result). Members → table grouped by vote position.

**Error guidance:**
- Missing session: "The 'session' parameter is required. Each congress has two sessions — session 1 for its first year, session 2 for its second year (and January 1–3 after it)."
- Vote not found: "No roll call vote {voteNumber} found in session {session} of the {congress ordinal} Congress. Use 'list' to browse available votes."
- Empty House list: verify the congress and session; Congress.gov publishes House roll call votes from the 115th Congress (2017) onward.
- House `get` or `members` below the 115th Congress: `not_found` before any request, naming that coverage ("Congress.gov publishes House roll call votes from the 115th Congress (2017) onward") and pointing at the House Clerk's vote XML (`clerk.house.gov/evs/{year}/roll{number}.xml`) in a bill action's `recordedVotes`; the recovery hint does not suggest `list`.
- Empty Senate list: verify the congress and session; the Senate publishes roll call votes from the 101st Congress (1989) onward.
- Senate `members` with `bioguideId`: "bioguideId cannot filter a Senate roll call roster: the Senate's LIS feed identifies senators by its own member IDs. Filter by stateCode (a state's two senators), optionally with party, instead." (`unsupported_filter`, `ValidationError`, raised before any source is consulted)
- Senate feed cannot answer (senate.gov refusing automated clients with HTTP 403 or its firewall page, another 4xx, a 5xx or timeout after retries, an empty body): the call is served from Voteview and carries `source`. A 403 is not retried; a 5xx or timeout is retried first. Only when Voteview is unavailable too (a 5xx, timeout, network failure, or file body broken off mid-read is retried once first) does the call fail, as "The Senate LIS feed could not be read, and Voteview, the source this server falls back to, is unavailable too." (`upstream_error`; the hint says House votes are unaffected). A Voteview HTTP 429 is never retried: it fails as "Voteview, which serves Senate votes while the Senate LIS feed can't be read, is rate-limiting this server (HTTP 429, Retry-After {value})." (`rate_limited`; the `Retry-After` clause and `retryAfter` appear when Voteview sent one, and the hint says House votes are unaffected). Before the 101st Congress there is no fallback: a senate.gov 403 there fails as "senate.gov refused the request for the Senate LIS feed (HTTP 403)." (`upstream_error`, `retryable: false`, failed on the first attempt).
- Senate vote after Voteview's latest, served from Voteview: `not_found` naming Voteview's latest vote for the congress (session, vote number, date).

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
| `nominationNumber` | get, nominees, actions, committees, hearings | Nomination number, bare (`1064`), a partitioned child (`730-2`), or as the citation list rows carry (`PN730-2`, `pn730-2`); case and surrounding whitespace are ignored and the `PN` prefix is dropped (`PN730-2` maps to `730-2`). Required for detail operations; `list` refuses it. |
| `ordinal` | nominees | Position ordinal within a nomination (for multi-nominee nominations). |
| `fromDateTime` | list | Start of an update-date window (ISO 8601): when Congress.gov last updated the nomination record, not its received or latest action date. Other operations name it as ignored. |
| `toDateTime` | list | End of the update-date window. Same semantics and notice as `fromDateTime`. |
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
- **rollVote**: on an `actions` row, and on `latestAction` for `list` and `get`, when the action text cites its own Senate record vote (`Record Vote Number: 225.`) — `{ chamber: 'senate', congress, session, voteNumber }`, the `congressgov_roll_votes` arguments for that vote; none before the 101st Congress (Senate roll call coverage)

**Format**: List → markdown table (PN number, description, organization, latest action). Sub-resources → appropriate table format.

**Error guidance:**
- Nomination not found: "No nomination {number} found in the {congress ordinal} Congress. Use 'list' to browse nominations."
- No hearings: "No hearings found for nomination {number}. The nomination may not have reached the hearing stage yet."
- Empty nominees: "No individual nominee data available for nomination {number}. Some nominations list nominees only in the description field."

---

### 7. `congressgov_bill_summaries`

The activity feed. Single-purpose tool — no operation enum.

**Parameters:**

| Param | Description |
|:------|:------------|
| `congress` | Congress number. Optional — omit for summaries across all congresses. |
| `billType` | Bill type filter (hr, s, etc.), in any letter case (summary rows carry `HR`). Requires `congress`. |
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

**Format**: Markdown sections — bill reference as header, summary text, action date. A page returns `limit` rows. A summary longer than the per-row window (25,000 characters) arrives as an exact character window carrying `textTotalCharacters`, `textTruncated`, and `textNextOffset`; `pagination.nextOffset` continues the page and a row's `textNextOffset` continues its text, read to the end with `congressgov_bill_lookup` `summaries`.

**Error guidance:**
- No summaries in range: "No CRS summaries published between {from} and {to}. Try widening the date range — CRS summaries are published on business days only."
- `billType` without `congress`: "The 'billType' filter requires 'congress'. Provide both or omit billType to browse across all types."

---

### 8. `congressgov_crs_reports`

Nonpartisan policy analysis from the Congressional Research Service. Separated from committee reports — different identifiers, different parameter sets, different domain.

```ts
operation: z.enum([
  'list', // Browse CRS reports
  'get',     // Report detail (authors, topics, summary, download links)
  'content', // The report's HTML version as plain text, one window at a time
])
```

**Parameters:**

| Param | Used by | Description |
|:------|:--------|:------------|
| `operation` | all | Which data to retrieve. |
| `reportNumber` | get, content | CRS report ID: letters then digits (`R40097`, `IF12345`) or, for older reports, two digit groups joined by a hyphen (`96-548`). Case and surrounding whitespace are ignored; the value is trimmed and upper-cased before use. Required for `get` and `content`; `list` refuses it. `id`, `reportId`, and `report_id` are accepted as aliases. |
| `fromDateTime` | list | Start of an update-date window (ISO 8601): when Congress.gov last updated the report, not its publication date. `get` and `content` name it as ignored. |
| `toDateTime` | list | End of the update-date window. Same semantics and notice as `fromDateTime`. |
| `limit` | list, get | Results per page (1-250, default 20): reports on `list`, related materials on `get`. |
| `offset` | list, get | Pagination offset: into the report list on `list`, into the report's related materials on `get`. |
| `characterOffset` | content | First character of the window, 0-based. Default 0. |
| `characterLimit` | content | Maximum characters in the window (1-100,000). Default 25,000. |

`content` takes no `format`: it reads the report's HTML version, with script, style, and comments dropped and tables rendered as tab-separated rows.

**Description:**
```
Browse and retrieve CRS (Congressional Research Service) reports — nonpartisan
policy analyses written by subject-matter experts at the Library of Congress.

CRS reports cover policy areas, legislative proposals, and legal questions.
Report IDs are letters then digits (R40097, RL33612, IF12345) or, for older
reports, two digit groups joined by a hyphen (96-548).

Use 'list' to browse available reports (newest update first; fromDateTime/toDateTime
filter on update date), 'get' for full detail (authors, topics, summary, download
formats, and related materials, which limit and offset page: relatedMaterialsCount
and relatedMaterialsNextOffset appear when a page leaves rows out), or 'content' to
read the report itself a bounded character window at a time. The oldest reports publish only a PDF, which
'content' cannot read; the error names its URL.
```

**Output:**
- **list**: `reports[]` — `reportNumber`, `title`, `date`, `topics[]` + pagination
- **get**: Full detail — `reportNumber`, `title`, `authors[]`, `date`, `topics[]`, `summary`, `formats[]` (PDF, HTML links), `relatedMaterials[]` (one `limit`/`offset` page of the deduplicated list). A page that leaves rows out adds `relatedMaterialsCount` (the full total) and `relatedMaterialsNextOffset` (the next page's `offset`, null on the last page), with a notice; a list that fits the first page at offset 0 is returned whole. Congress.gov does not page this endpoint, so the page is a slice of one response and costs no extra request
- **content**: `content { text, format, sourceUrl, documentTitle, totalCharacters, offset, truncated, nextOffset }`

**Format**: List → markdown table (report ID, title, date). Detail → structured sections with summary text.

**Error guidance:**
- Report not found: "No CRS report '{reportNumber}' found. Report IDs are letters then digits (e.g., R40097) or two digit groups joined by a hyphen (e.g., 96-548). Use 'list' to browse available reports."
- PDF-only report on `content`: `format_unavailable`, naming each published format and its URL.
- Report with no usable format on `content`: `document_unavailable`.

---

### 9. `congressgov_committee_reports`

Committee reports that accompany legislation reported out of committee. Separated from CRS reports — different identifiers (`congress/type/number` vs CRS report IDs), different parameters, different purpose.

```ts
operation: z.enum([
  'list',    // Browse committee reports by congress and type
  'get',     // Report detail
  'text',    // Report text versions
  'content', // The report's actual document text, one window at a time
])
```

**Parameters:**

| Param | Used by | Description |
|:------|:--------|:------------|
| `operation` | all | Which data to retrieve. |
| `congress` | all | Congress number. Required. |
| `reportType` | list (optional), get, text, content | `hrpt` (House), `srpt` (Senate), `erpt` (Executive), in any letter case (report rows and bill `committeeReports` URLs carry `HRPT`). Required for detail operations. |
| `reportNumber` | get, text, content | Committee report number. Required for detail operations; `list` refuses it. |
| `part` | get, text, content | Which part of a multi-part report to serve; Part 1 when omitted. `get` prefers a non-Errata record for the part. A part the report lacks fails `not_found`, naming the parts it has. `list` refuses it. |
| `fromDateTime` | list | Start of an update-date window (ISO 8601): when Congress.gov last updated the report record, not its publication date. Detail operations name it as ignored. |
| `toDateTime` | list | End of the update-date window. Same semantics and notice as `fromDateTime`. |
| `conference` | list | `true` returns only conference reports, `false` only the others; omit for both. List rows carry no conference field. Detail operations name it as ignored. |
| `limit` | list | Results per page (1-250). |
| `offset` | list | Pagination offset. |
| `format` | content | `text` (GPO Formatted Text) or `xml`. Committee reports publish no XML, so `xml` fails with `format_unavailable`. Default `text`. |
| `characterOffset` | content | First character of the window, 0-based. Default 0. |
| `characterLimit` | content | Maximum characters in the window (1-100,000). Default 25,000. |

**Description:**
```
Browse and retrieve committee reports from Congress.gov.

Committee reports accompany legislation reported out of committee. They explain
the bill's purpose, committee amendments, dissenting views, and the committee vote.

Report types:
- hrpt: House reports
- srpt: Senate reports
- erpt: Executive reports

A multi-part report (Part 2, Book 3) is filed as one record per part under one
report number: 'get', 'text', and 'content' serve Part 1 unless 'part' names
another, and list every part number in 'parts'.
```

**Output:**
- **list**: `reports[]` — `congress`, `type`, `number`, `title`, `chamber`, `associatedBill { type, number }` + pagination
- **get**: Full detail — `congress`, `type`, `number`, `title`, `committee`, `associatedBill`, `issueDate`
- **text**: `versions[]` — `type`, `date`, `formats[]` (PDF, HTML links), for the selected part
- **parts**: on `get`, `text`, and `content` for a report filed in more than one part, every part number ascending; absent for a single-part report. On a multi-part report, the echo and `content.documentTitle` name the part (e.g. "Committee Report HRPT 117-70, Part 2").

**Format**: List → markdown table (type+number, title, associated bill). Detail → structured sections.

**Error guidance:**
- Missing part: "Committee report {citation} has no part {part}. Its parts are {parts}." (`not_found`)
- Report not found: "No {reportType} report {reportNumber} found in the {congress ordinal} Congress. Use 'list' to browse available reports."
- Invalid report type: "Invalid report type '{type}'. Valid types: hrpt (House), srpt (Senate), erpt (Executive)."

---

### 10. `congressgov_daily_record`

Daily Congressional Record — published each day Congress is in session. Separated from the bound record because the navigation model and parameters are completely different (volume/issue hierarchy vs date-based lookup).

```ts
operation: z.enum([
  'list',     // Browse daily Congressional Record issues
  'issues',   // Issues within a specific volume
  'articles', // Articles within a specific issue
  'content',  // The selected article's actual document text, one window at a time
])
```

**Parameters:**

| Param | Used by | Description |
|:------|:--------|:------------|
| `operation` | all | Which data to retrieve. |
| `volumeNumber` | issues, articles, content | Volume number. Required for drill-down operations. |
| `issueNumber` | articles, content | Issue number within a volume. Required for `articles` and `content`. |
| `limit` | list, articles | Results per page (1-250). |
| `offset` | list, articles | Pagination offset. |
| `articleIndex` | content | Which article to read, 0-based against the issue's whole article sequence. Default 0. |
| `format` | content | `text` (GPO Formatted Text) or `xml`. The Congressional Record publishes no XML. Default `text`. |
| `characterOffset` | content | First character of the window, 0-based. Default 0. |
| `characterLimit` | content | Maximum characters in the window (1-100,000). Default 25,000. |

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

### 11. `congressgov_amendment_lookup`

Amendments to bills and to other amendments. Separate from `congressgov_bill_lookup` because an amendment has its own sponsor, actions, cosponsors, and text, and can amend another amendment (see "Amendments are their own tool").

```ts
operation: z.enum([
  'list',       // Browse amendments by congress, optionally one type
  'get',        // Sponsor, purpose, description, amended bill or amendment, latest action
  'actions',    // Action history; a row recording one roll call carries rollVote
  'cosponsors', // Members who cosponsored
  'amendments', // Amendments to this amendment
  'text',       // Published text versions
  'content',    // One text version's document text, one window at a time
])
```

**Parameters:**

| Param | Used by | Description |
|:------|:--------|:------------|
| `operation` | all | Which data to retrieve. |
| `congress` | all | Congress number. Required. |
| `amendmentType` | list (optional), all others | `hamdt` (House), `samdt` (Senate), or `suamdt` (Senate unprinted, 97th and 98th Congresses only). Any letter case: rows emit `HAMDT`, which Congress.gov refuses in a path, so the value is lower-cased before validation. `type` is accepted as an alias. |
| `amendmentNumber` | get and sub-resources | Amendment number, as a number or the digit string rows carry (`"255"`). Required for every operation but `list`, which refuses it (`incompatible_identity`). `number` is accepted as an alias. |
| `fromDateTime` | list | Start of an update-date window (ISO 8601): when Congress.gov last touched the record, not when the amendment was offered. Other operations serve the call and name it as ignored. |
| `toDateTime` | list | End of the update-date window. Same semantics and notice as `fromDateTime`. |
| `order` | list | `recent` (default, newest update first) or `oldest`. |
| `textVersionIndex` | content | Which text version to read, 0-based against the order `text` returns; each `text` row carries the `textVersionIndex` that reads it. Default 0. |
| `characterOffset` | content | First character of the window, 0-based. Default 0. |
| `characterLimit` | content | Maximum characters in the window (1-100,000). Default 25,000. |
| `limit` | list, sub-resources | Results per page (1-250, default 20). |
| `offset` | list, sub-resources | Pagination offset. |

**Description:**
```
Browse and retrieve U.S. congressional amendments from Congress.gov — House (hamdt),
Senate (samdt), and Senate unprinted (suamdt, 97th and 98th Congresses only).

An amendment is addressed by congress + amendmentType + amendmentNumber, the identifiers
other tools return: congressgov_bill_lookup 'amendments' rows, House votes from
congressgov_roll_votes, and amendment rows from congressgov_member_lookup
'sponsored'/'cosponsored' (the type is in the row's url).

Use 'list' to browse, 'get' for the record, or drill in with 'actions', 'cosponsors',
'amendments', or 'text'. 'content' reads one text version as plain text, a bounded
character window at a time.
```

**Output:**
- **list**: `data[]` — amendment rows + pagination
- **get**: `amendment` — sponsor, purpose, description, `amendedBill` or `amendedAmendment`, dates, latest action, sub-resource counts
- **actions**: action rows; a row that records exactly one roll call vote carries `rollVote` — `{ chamber, congress, session, voteNumber }`, the `congressgov_roll_votes` arguments for it (none for a vote that tool has no data for)
- **cosponsors**, **amendments**: sub-resource rows + pagination
- **text**: version rows + pagination; each row carries `textVersionIndex`, the index `content` reads that version by
- **content**: `content` — `text`, `format`, `sourceUrl`, `documentTitle`, `totalCharacters`, `offset`, `truncated`, `nextOffset`

**Text:** an amendment's text version is the Congressional Record page that prints it, published as HTML and PDF on `www.congress.gov`. The HTML is GPO `<pre>` print output, read with the `gpo` reading, and the page often runs well past the amendment into the surrounding floor proceedings. `CongressDocumentsService` serves it under the same ceiling, call budget, and character window as the other `content` operations.

**Error guidance:**
- `list` with `amendmentNumber`: `incompatible_identity`, naming `get` as the operation that takes it.
- Missing `amendmentType` or `amendmentNumber` for a non-list operation: "The '{operation}' operation requires congress, amendmentType, and amendmentNumber. Use 'list' first to find the amendment, then request its {operation}."
- Amendment not found: "Amendment {TYPE} {number} not found in the {congress ordinal} Congress."
- `content` on a version publishing no formats, or an index past the end: `document_unavailable`; a version with formats but no HTML: `format_unavailable`, naming the formats it does publish.

---

## Cross-Cutting Error Handling

All tools share these error patterns. The service layer handles them uniformly.

| Condition | Error Message |
|:----------|:-------------|
| Rate limit hit | "Congress.gov API quota reached. Quotas are shared across clients using the same key or demo IP; this server only tracks its own attempts." (`rate_limited`) |
| API unavailable (5xx) | "Congress.gov returned an unexpected error (HTTP {status})." (`upstream_error`) |
| Malformed request (upstream 400, 401, 402, 403, 422) | "Congress.gov rejected the request as malformed (HTTP {status})." (`invalid_request`) |
| Rejected API key (api.data.gov `API_KEY_*` code on 401/403) | "Congress.gov's api.data.gov gateway rejected the server's API key with {code} (HTTP {status})." (`api_key_rejected`, `ConfigurationError` -32008, not retryable). The hint tells the operator to replace or unset `CONGRESS_API_KEY` and restart, without echoing the key. The body code decides, not the status: a malformed path segment is also a plain 403. |
| Empty results | "No {entity} found for the given filters. Try broadening the search — adjust the congress number, date range, or remove optional filters." |
| Invalid congress number | "Congress {n} is not valid. The current congress is {current}. Congress numbers are positive integers starting at 1 (1789)." |
| Network error | "Congress.gov returned an unexpected error." (`upstream_error`) |
| Upstream timeout | "Congress.gov did not complete the request within the {ms}-millisecond deadline." for one attempt's own timeout, naming that attempt's deadline (10000 in a tool call or resource read, 30000 in a mirror sync, which runs no call), or "{upstream} did not deliver {request} within this call's 50-second budget for upstream requests ({n} attempts)." once the call's budget runs out (`upstream_timeout`, with `budgetMs` and `retryAttempts`). See "Every call runs on one time budget" below. |

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `CongressApiService` | Congress.gov REST API v3 — auth, pagination, rate limiting, response normalization | Legislative API tools and live resources; House branch of roll votes |
| `SenateVoteService` | Senate LIS XML feed, with Voteview's per-congress CSV files as the fallback when the feed can't answer | Senate branch of roll votes |
| `CongressDocumentsService` | Congress.gov published document bodies (GPO publications and CRS HTML pages) | Bill, committee-report, Record, CRS report, and amendment content |
| `CongressMirrorService` | Local SQLite FTS5 bill index | Optional bill search |

Each upstream and the local mirror have separate service boundaries.

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

  // Amendments
  async listAmendments(params: ListAmendmentsParams): Promise<AmendmentListResponse>;
  async getAmendment(params: GetAmendmentParams): Promise<AmendmentDetailResponse>;
  async getAmendmentSubResource(params: AmendmentSubResourceParams): Promise<AmendmentSubResourceListResponse>;

  // Daily Congressional Record
  async listDailyRecord(params?: PaginationParams): Promise<DailyRecordListResponse>;
  async getDailyIssues(volumeNumber: number): Promise<DailyIssuesResponse>;
  async getDailyArticles(volumeNumber: number, issueNumber: number): Promise<DailyArticlesResponse>;

  // Congress metadata
  async getCurrentCongress(): Promise<CongressDetailResponse>;
}
```

**Internal concerns:**
- API key sent in the `X-Api-Key` header, never logged
- Every path value is percent-encoded as one segment (the `apiPath` template tag), and `buildUrl` refuses empty and dot segments before any request
- Pagination: `offset` and `limit` as query params, return `pagination` metadata
- Rate limiting: track request count per hour window, throw `rateLimited()` before hitting 5,000/hr ceiling
- Response normalization: request `format=json`, strip wrapper elements, return typed data
- Native `fetch` — no SDK dependency

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `CONGRESS_API_KEY` | No | Optional. Defaults to `DEMO_KEY` (30 req/hr). Own key from [api.data.gov](https://api.data.gov/signup/): 5,000 req/hr. |
| `CONGRESS_API_BASE_URL` | No | API base URL. Defaults to `https://api.congress.gov/v3` |

---

## Bill Search Mirror

The Congress.gov API's core limitation — no keyword search (see "Key API constraint" above) — can't be fixed at the API layer, so `congressgov_search_bills` closes the gap with a local mirror instead of a new upstream endpoint.

**Architecture:** `CongressMirrorService` owns a SQLite + FTS5 index (`src/services/congress-mirror/`) built on the framework `MirrorService`. The ingester merges two existing `CongressApiService` endpoints per configured congress — the bill list (title, chamber, latest action) and `/summaries` (CRS summary text, HTML-stripped) — into one row per bill, keyed by the same `{congress}/{billType}/{billNumber}` id the `congress://bill/...` resource uses. `title` and `summary` are FTS-indexed; `congress`, `billType`, and `originChamber` back exact-match filters.

The bill list is walked without offset paging, since offset paging over a list sorted by update time skips and repeats bills inside a tie: every request is offset 0, limit 250, `sort=updateDate asc`. From a cursor day the walk requests with `fromDateTime` one second before it (the bound is exclusive) and no end; a count of 250 or less is the rest of the walk. When a full page holds a single date, the walk covers that UTC day in halved windows with exclusive bounds, then moves the cursor to the next day; a one-second window that still holds more than 250 bills fails the sync. The walk costs about 2.7 times the requests of offset paging (214 against 80 for the 119th Congress). Every sync re-walks a congress's whole `/summaries` list, newest first, requested from January 1 of the congress's first year with no end date: without `fromDateTime` the endpoint returns only the last day's summaries, and summaries are rewritten long after their congress ends. A bill a refresh re-emits therefore keeps its summary.

**Lifecycle:** the mirror is never built or refreshed during server startup. `mirror:init` runs a full out-of-band build; `mirror:refresh` incrementally re-walks from the checkpoint, `YYYY-MM-DD|congresses` (the congresses descending, zero-padded): every bill of those congresses updated before that day is stored. The checkpoint is persisted only when a run finishes, so a refresh that fails partway leaves it unchanged. Every committed page also stores a cursor: the congresses walked to the end of their list, the congress in progress and the UTC day its walk resumes from, the highest list date seen, and the UTC date the run began. The next run of the same mode resumes from it — `mirror:init` after a failed or stopped init, a refresh after a failed or stopped refresh — skipping the congresses already walked, rebuilding the summary map of the one in progress, and continuing it with the request that follows the last committed page. The one exception is a resume inside a day walked in halved windows, which reads that whole day again rather than trust a window position inside it. A cursor this version cannot read is dropped with a warning, and the run starts as a fresh run of its mode. The checkpoint date never passes the UTC date the run began, or the interrupted run it resumes: a resume skips the congresses walked before the interruption, so their bills updated since must stay ahead of the next refresh, which re-walks them from that day. A refresh walks each covered congress from the checkpoint day and each configured congress the checkpoint does not cover from its start; `mirror:verify` reports readiness and runs a SQLite integrity check. The three scripts log JSON lines to stderr at the `MCP_LOG_LEVEL` floor and leave stdout empty. Under HTTP transport, an in-process refresh can run on a cron via `CONGRESS_MIRROR_REFRESH_CRON`. Store schema version 3 clears the checkpoint (as version 2 did for stores built before the summaries window existed), so the next refresh re-walks every configured congress's bill list from the start, as `mirror:init` does, recovering bills the earlier offset-paged walk skipped and writing summaries onto the bills it re-emits while search keeps serving.

**`congressgov_search_bills`:** keyword-searches `title` + `summary` (BM25-ranked), optionally narrowed by `congress`, `billType`, and `originChamber` (`House` or `Senate`), the last two in any letter case. Returns each match's derived bill id for a follow-up `congressgov_bill_lookup` call plus a truncated summary preview. No live-API fallback — a mirror that hasn't completed its initial build returns an empty result with a notice, not an error. Every response names the congresses the store holds in `mirroredCongresses` (empty until the initial build finishes); a `congress` outside them returns an empty result with a notice pointing at `congressgov_bill_lookup` `list`, so an empty result for an unmirrored congress is not a negative finding.

**Query grammar:** `toFtsMatch` (`normalize.ts`) translates `query` to the FTS5 `MATCH`. Words AND together, `"two words"` is a phrase, `word*` a prefix, `-word` or `NOT word` excludes from its group, `A OR B` takes either, and `( )` groups. Only uppercase `AND`/`OR`/`NOT` are operators, as in FTS5 itself: lowercase `or`, `NEAR`, `title:x`, and a quoted `"OR"` are searched as words, and a token with no letter or digit is dropped. A `(` opens a group only at the start of a word and a `)` closes one only at its end, so `501(c)(3)` stays one word. Every term reaches FTS5 quoted, and operators, parentheses, and the prefix `*` come only from the translation, so caller text never reaches FTS5 as query syntax and FTS5's column filters and `NEAR` stay out of reach.

- *Decision: reject what can't be translated, ignore only unmatched marks.* A query with no term to search for (`-smoke`), an operator missing a term (`wildfire OR`), or groups that change the result nested past 10 levels fails `invalid_query` naming the token, before MATCH runs: FTS5 has no unary NOT, and an empty result would read as "no bill lacks smoke". An unmatched `(`, `)`, or `"` is ignored with a notice instead, because the keyword-only translation answered those queries and rejecting them would refuse searches that worked.
- *Decision: name every exclusion the search applied.* The keyword-only translation searched `NOT` and a leading `-` as words, so a query written as plain words can now leave out the bill it names: `DO NOT CALL` reads as do and call but not not, and `covid -19` drops every bill that mentions 19. Either still returns rows, so the notice rides every response whose query used `NOT` or a `-` at the start of a word, phrase, or group, whatever it found, and says how to search for the word instead (`"NOT"`, `covid-19`). `toFtsMatch` reports the forms it applied beside `match`, so the tool never parses the query a second time. `OR` draws no notice: quoting `"OR"` or `"AND"` only narrows a result, so the advice could never recover a missed bill.
- *Decision: one NOT per group.* A group's exclusions follow its included terms as `(included) NOT (a OR b …)`, so an exclusion applies to its whole group and the expression's depth never grows with the number of exclusions (FTS5 caps expression depth). Every AND is written out, since FTS5 rejects an implicit AND before a parenthesis.
- *Decision: count only groups that change the result.* The keyword-only translation ignored parentheses, so it answered nested plain words (`((wildfire))`, `wildfire (smoke (crop …))`) at any depth. A group of one item, and an AND group that is not excluded, prints no parentheses of its own and adds no level; the 10-level bound counts groups that hold `OR` or an exclusion, or are excluded, which are what deepen the FTS5 expression, and keeps every translation inside FTS5's parser stack on both SQLite drivers. A query still past the bound uses an operator the keyword-only translation searched as a word.
- *Decision: control characters separate terms.* A NUL ends FTS5's query string mid-term, so whitespace, every control character, and unpaired surrogates act as separators before anything is quoted.

**Opt-in, off by default:** gated behind `CONGRESS_MIRROR_ENABLED` (`false` by default) so the standard deploy stays config-free. When disabled, the tool registers via the framework's `disabledTool()` — visible on the landing page as present-but-uncallable, with a hint pointing at the env var, and skipped from MCP registration entirely.

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `CONGRESS_MIRROR_ENABLED` | No | Enable the mirror + `congressgov_search_bills`. Defaults to `false`. |
| `CONGRESS_MIRROR_PATH` | No | SQLite mirror index path. Defaults to `.mirror/bills.sqlite3`. |
| `CONGRESS_MIRROR_REFRESH_CRON` | No | Cron for the in-process refresh (HTTP transport only). Unset runs `mirror:refresh` manually. |
| `CONGRESS_MIRROR_CONGRESSES` | No | Comma-separated congresses to mirror. Defaults to the current congress plus the prior one. |

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
13. **`congressgov_amendment_lookup`** — Amendments and their text
14. **Resources** — `congress://current`, `congress://bill-types`, member, bill, committee
15. **Prompts** — `congressgov_bill_analysis`, `congressgov_legislative_research`

Each step is independently testable after the service layer is in place.

---

## Design Decisions

### No keyword search — by design

The Congress.gov API does not expose full-text search. Every tool description guides agents toward browse/filter strategies:

- **Find a specific bill:** Filter by congress + bill type, or discover via a member's sponsored legislation
- **Find bills on a topic:** Use `congressgov_search_bills` when the optional mirror is enabled; otherwise obtain a bill, member, committee, or report seed. Summary and CRS report browsing do not accept topical queries
- **Find a member by name:** List members by state/congress, scan results

### Domain-specific tools with operation enums

Explicit operations are preserved. `list` rejects identities it would discard with `incompatible_identity` (`ValidationError`, -32007): bill `billNumber`, amendment `amendmentNumber`, vote `voteNumber`, member `bioguideId`, enacted-law `lawNumber`, committee `committeeCode` (a committee name is pointed at `filter`), nomination `nominationNumber`, CRS/committee-report `reportNumber`, committee-report `part`, and Record `volumeNumber`. The error names a compatible operation and the remove-field option. Browse scoping, pagination, defaulted selectors, and optional blank strings keep their existing behavior.

Inputs an operation doesn't use (member `congress`/`stateCode`/`district`/`currentMember`, committee `congress`/`filter`, bill `fromDateTime`/`toDateTime`, roll-vote `bioguideId`/`stateCode`/`party` on `list` and `get`, the date pair on CRS, nomination, and committee-report detail operations) do not fail a detail operation: the call is served and a notice names the ignored inputs. A member's sponsored and cosponsored legislation and a committee's bills, reports, and nominations span every congress, and the notice says so.

CRS `id`, `reportId`, and `report_id` normalize to `reportNumber` before operation validation. Canonical plus alias keys, or multiple aliases for one target, are rejected without overwriting the canonical value. CRS `reportNumber` is trimmed and upper-cased, and a nomination's `PN` prefix is dropped, before the `list` identity check.

Committee name filtering first requires every normalized query token to occur in the name. With no exact matches, every query token must reach the existing 0.5 bigram-Dice floor against a name token; qualifying names rank by mean similarity, then normalized name and system code, capped at five and labeled approximate. This retains typo forgiveness without accepting a partly unrelated query. Matching precedes pagination over the complete roster; name resolution uses the same rule restricted to parent committees, and to the committees of `chamber` when it is set. A lone approximate match resolves only without `chamber`, and its notice marks it approximate; with `chamber` set it is returned as a candidate, since a name no committee in that chamber carries can clear the fuzzy floor against an unrelated one there ('forestry' against House Oversight's 'reform').

Roll-vote member filtering runs in the tool over whole rosters, not in the services: both services already fetch a vote's whole roster in one request, so a filtered call asks for one page holding all of it and pages the matches. The Senate rejects `bioguideId` (`unsupported_filter`) because the Senate LIS feed identifies senators by its own member IDs; senators filter by `stateCode` and `party`.

The existing [MCP Congress server](https://github.com/bsmi021/mcp-congress_gov_server) uses 2 generic tools — forcing the LLM to construct URIs. This design uses 11 domain-specific tools grouped by noun, each with operations that share parameter patterns.

Split decisions:
- **Bills vs. Laws**: Different type systems (`hr`/`s` vs `pub`/`priv`), different conceptual entities
- **CRS Reports vs. Committee Reports**: Different identifiers (letter-number codes vs congress/type/number), different parameter sets, different domains
- **Bills vs. Amendments**: see "Amendments are their own tool"

### Resources for stable lookups

Member, bill, and committee detail are exposed as both tool `get` operations and URI-addressable resources. Resources enable context injection (client pre-loads); tools enable dynamic discovery within agent workflows.

### Summaries as first-class tool

The `/summaries` endpoint is the closest thing to an activity feed. By defaulting to a 7-day window (the API defaults to 1 day), `congressgov_bill_summaries` becomes the "what's happening" entry point.

### Both chambers through separate upstreams

The Congress.gov API exposes House votes but no Senate vote namespace. `congressgov_roll_votes` selects the Congress.gov API or the Senate LIS feed by chamber (Voteview's vote files answer for the feed when it can't be read; see "Senate votes fall back to Voteview"), preserving the same list/detail/member-position workflow.

- **Both chambers list votes in roll call order.** Roll numbers follow vote time within a session; update date does not, since Congress.gov re-touches old votes in batches. `/house-vote/{congress}/{session}` ignores `sort` and serves rows in neither roll, date, nor update order, so House `list` reads the whole session (one request per 250 votes) and sorts it by `rollCallNumber` before paging, as the Senate branch sorts by vote number.
- *Decision: a failed page fails the call.* The pages after the first are read in parallel, and one that still fails after its retries (a 5xx) or at once (a 429) fails the whole `list`, though its siblings answered. Sorting only the pages that arrived would page a session with votes missing as though it were whole.

### The committee roster is read chamber by chamber

Name resolution, codes outside the letters-plus-two-digits shape, and `list` with `filter` on `congressgov_committee_lookup`, and `congress://committee/{committeeCode}`, read the whole roster. Every committee list orders rows by update date, 250 a request, and Congress.gov orders the rows that share an update instant afresh on each request, so a page boundary inside such a group can return one row on both pages and another on neither. Every read of the cross-chamber `/committee` list repeats `n79043123` and loses `no94026591` (Senate Printing).

- **Three chamber lists, read together.** With no `chamber` and no `congress`, the roster is `/committee/house`, `/committee/senate`, and `/committee/joint`, read concurrently (five requests, two deep, where `/committee` took four in sequence) and merged newest-updated first, the cross-chamber order. A congress-scoped read without `chamber` stays on `/committee/{congress}`, one request for any recent congress.
- **A repeated row re-reads the boundaries.** The House and Senate lists also split a tied group at their 250-row boundary and come back complete only because Congress.gov orders it the same way on both pages. Full pages return as many rows as they skip, so a lost row always leaves a repeated one: a scope whose pages repeat a row reads each boundary again with one page centred on it, which holds the whole group, and keeps the rows it adds. A clean read costs nothing extra. `pagination.count` can't serve as the check, since a congress-scoped list overstates it (`/committee/119` counts 238 and returns 236 rows on one page).

### Amendments are their own tool

`congressgov_amendment_lookup` is a separate tool rather than new operations on `congressgov_bill_lookup`. Folding amendments in would add a second identity triple (`amendmentType` + `amendmentNumber` beside `billType` + `billNumber`) and six more operations to a tool that already has twelve, and an amendment is not a bill sub-resource: it has its own sponsor, actions, cosponsors, and text, and it can amend another amendment (`amendedAmendment`). The bill, vote, and member tools name the new tool where their rows carry an amendment ID, so the chain from a row to the record is one call.

- **Type accepted in any letter case.** Rows emit `HAMDT`/`SAMDT`, and Congress.gov refuses upper case in a path; the value is lower-cased before validation, and the number accepts the digit string rows carry.
- **`content` reads the Congressional Record page.** An amendment's text version is the Record page that prints it, so the window is often far longer than the amendment. The HTML is GPO `<pre>` output and takes the `gpo` reading.
- **`rollVote` on `actions` rows.** Amendment actions carry the same `recordedVotes` shape as bill actions, so they get the same pointer to `congressgov_roll_votes`.

### Senate votes fall back to Voteview

When the Senate LIS feed can't answer a `list`, `get`, or `members` call — senate.gov refusing automated clients with HTTP 403 or its firewall page, another 4xx, a 5xx or timeout after the retries, an empty body — `SenateVoteService` serves the call from [Voteview](https://voteview.com/) (UCLA), which publishes each congress as three CSV files (`rollcalls`, `votes`, `members`). Voteview's `session` and `clerk_rollnumber` columns carry the Senate's own numbering, so a vote is addressed the same way on both sources, and the members file supplies `bioguideId` for roster rows.

- **Answers say where they came from.** The result carries `source` — name, URL, the congress, Voteview's `latestVote` (session, vote number, date), and the citation Voteview asks for — as an enrichment field, so it reaches `structuredContent` and `content[]` alike. A LIS-served result has no `source` and is unchanged.
- **Only a failure to answer falls back.** The feed's own not-found page is an answer, a caller's cancellation and a spent call budget are ends, and a congress before the 101st is outside the feed's coverage; none of them consults Voteview.
- **A vote past Voteview's latest is not found.** Voteview adds votes after the Senate takes them, so the not-found names the latest vote it holds rather than guessing.
- **Files are cached for 1 hour, bounded by retained bytes (16 MiB), with one shared load.** The three files of a congress load together and parse once. Concurrent calls wait on the same load under their own call budgets and cancellation, so one caller giving up never fails another, and the load aborts only when none is left.
- **A Voteview 429 is a rate limit, not an outage.** It is never retried and reaches the caller as `rate_limited` with Voteview's `retryAfter`, rather than folding into "both sources unavailable": waiting out the window is the caller's move, and a retry spends against the same limit.
- **The President's positions are dropped.** The votes file records the President's position on each roll call; it is no senator's vote, and dropping it leaves each roster agreeing with the roll call's published tally.
- **`list` falls back too.** A fallback that served `get` and `members` but not `list` would leave a caller unable to discover which votes exist while the feed is down.
- **Voteview over a bot-control workaround or GovTrack.** Imitating a browser to pass senate.gov's firewall circumvents the site's bot controls; GovTrack's API answers non-browser clients with a Cloudflare challenge (HTTP 403). Voteview publishes the data as static per-congress files.
- **`bioguideId` stays rejected on Senate `members`, whichever source answers.** Voteview could honor it, but a filter that works only while the feed is down would make a call's acceptance depend on which upstream answered. The LIS feed identifies senators by its own IDs, so the filter is `stateCode` and `party` on both.

### No SDK dependency

[`congress-gov-sdk`](https://www.npmjs.com/package/congress-gov-sdk) exists but uses Axios, is 0.1.x, and adds unnecessary overhead. The API is straightforward REST — a thin `fetch` client gives full control.

### Document text is a second upstream, not a second API method

`bill_lookup 'text'`, `amendment_lookup 'text'`, `committee_reports 'text'`, `daily_record 'articles'`, and the format list on a CRS report return format URLs, and every one of them resolves to `www.congress.gov` — a different host from the `api.congress.gov` that `CongressApiService` is scoped to (`baseUrl`, JSON parsing, `X-Api-Key` header). The `content` operation that reads those documents is backed by a separate `CongressDocumentsService` (`src/services/congress-documents/`), following `SenateVoteService`, the existing precedent for a second host with no API key and non-JSON content. It adds no dependency: `fetch`, hand-written extractors, and the framework's `fetchWithTimeout`/`withRetry`. CRS pages are served without a `Content-Length`, so the ceiling is enforced mid-stream for them.

The caller names how a body becomes text (`reading`); the body never decides. `gpo` (bill text, amendment text, committee reports, Record articles) keeps a Formatted Text `<pre>` print body verbatim, or reads XML with one space at an unseparated sibling boundary. `html` (CRS reports) drops tags with script, style, and comments, lays blocks out as lines and paragraphs, and renders table rows as tab-separated cells. The body cache holds bytes and replays them with each call's own reading.

The HTML reading is explicit, hand-written, single-pass, and stack-free rather than the framework's HTML extractor: that extractor is heuristic and works on the whole string, with no streaming twin, so it cannot hold the byte-for-byte equality with a windowed read that exact offsets require.

A table that opens in a cell before any of the cell's text (whitespace, U+00A0 included, doesn't count) is read as that cell's content: its rows and nested tables separate like any block inside a cell, with a space, and its cells add nothing. CRS wraps figures that way, in a one-row table that right-aligns a value (`750`) or splits it at the decimal point (`$838` | `.2`), and the rule keeps such a figure in its column. A table that opens after text in its cell is a real table, such as a data table in a footnote or a figure frame under a heading, and keeps its own lines. The test takes one flag (the open cell holds text) and one counter (tables open as a cell's content), so the reading stays stack-free; keying on the nested table's row count instead would hold its first row back until a second `<tr>` or the `</table>` arrived.

### `content` bounds the fetch and the response separately

A full enrolled bill's Formatted Text runs past a megabyte and its USLM XML past 2.6 MB, and the omnibus appropriations acts run far past that — 116th Congress H.R. 133 enrolled is 6,790,482 bytes as Formatted Text and 9,812,888 as XML. Bounding only the response would still pull the whole document into memory on every call, so the body is extracted as it streams and only the requested character window is extracted into memory. Transient allocation is not flat — peak RSS on a single large read runs above a buffered read of the same document — but the decoded text is garbage rather than live. The fetch still carries a declared ceiling (25 MB, refused on `Content-Length` when one is advertised and mid-stream when it is not), a per-attempt timeout covering headers and body, one time budget for the whole call, and a content-type allowlist — an upstream whose response size is not known in advance needs a limit of its own. Raising the ceiling alone would not have been enough: both published formats of an oversized document are oversized, so the `document_too_large` recovery hint points at the source URL rather than at the other format.

The streaming extractor is a second implementation of an existing contract, since every `content` offset indexes into what the whole-string extractor produces. It is held to byte-for-byte equality with that function rather than to expectations of its own, and a differential test drives both over the real document shapes, over malformed markup, and over randomized bodies split at every chunk boundary.

### Every call runs on one time budget, counted from its start

MCP SDK clients give up on a request after 60 seconds by default. Each upstream request runs its own retry ladder — three attempts of 10 seconds each against api.congress.gov, 12 against the Senate LIS feed, and 30 against a www.congress.gov document, two of 20 seconds each against a Voteview file — and many calls chain requests: `content` looks up the document's format URL before fetching it, `congressgov_committee_lookup` reads the committee roster — the three chamber lists, two requests deep — before filtering it or resolving a committee name (one chamber's list when `chamber` is set: two requests for the House or Senate, one for the joint committees) and then makes one or two more requests, and `congressgov_roll_votes` House `list` fetches a session's first page and then the rest in parallel. Per-attempt timeouts bound none of that. One api.congress.gov request could take about 34 seconds, or about 90 when a 5xx carried a `Retry-After` the ladder honored, and a committee name resolved across every chamber for `bills` in recent order chained six such requests. A client that had already given up never saw the server's classified error.

Every upstream request a tool call or resource read makes through `CongressApiService`, `SenateVoteService`, or `CongressDocumentsService` therefore spends one 50-second budget (`src/services/call-budget.ts`) counted from the call's start, `ctx.timestamp`, which the framework stamps as the tool call or resource read begins. Each request's ladder gets what is left as `withRetry`'s `deadlineMs`, and each attempt's timeout is clamped to the remainder while its I/O carries the budget's signal. A backoff the remainder cannot hold fails at once as the expiry. A `Retry-After` wait it cannot hold fails at once with the upstream's own error, `retryAfter` intact, since waiting out that window is still the caller's move. A request the budget no longer covers is never sent, and requests issued in parallel share the same end instant. Running out is a `Timeout` with reason `upstream_timeout`, the reason a slow api.congress.gov attempt already carried, and its message names the budget and the attempts made. A caller abort keeps precedence and stays `RequestCancelled`.

- **One module for three services.** Where the budget starts, how attempts are clamped, and how expiry reads cannot drift between the services, and a `content` call's format lookup spends from the same total as its document fetch, where a budget kept inside one service would leave the other outside it.
- **Read from the context, not passed in.** The budget comes from the handler's own `ctx`, so no tool path can start it in the wrong place. A context derived from `ctx` carries a later timestamp and is never the one read, and tools pass `ctx` to every service call.
- **No call, no budget.** The mirror ingester and the `mirror:*` scripts call `CongressApiService` without a context and keep the plain per-request ladder, three attempts of 30 seconds each, the attempt a document fetch gets: a sync runs for minutes and has no client waiting on a 60-second clock, and an uncached 250-row page of the bill or summaries list can outlast a tool call's 10-second attempt.
- **A clamped last attempt can end on its own timer.** The attempt's timer and the budget's clock are armed for the same instant, and the timer can fire first. That timeout is reported as the budget's expiry too, never as an exhausted ladder naming a per-attempt deadline the attempt never had.

### A multi-window document is fetched once per TTL

`totalCharacters` is known only at the end of the extracted text, so every window streams its whole document; walking the 1.5 MB-gzipped H.R. 133 at the default window would download it 272 times. The first read of a document that runs past its window therefore keeps its decompressed body in `DocumentBodyCache`, and later windows replay those bytes through the unchanged streaming extractor — the same input to the same function, so a cached window cannot differ from a fetched one.

- **Bytes, not extracted text.** Cached text would need a capture mode the extractor lacks, holds XML text at two bytes per character, and pins its whole parent with every slice served from it. A body is stored as one buffer it owns, counted by its `byteLength`.
- **Bounds.** 64 MB in total with LRU eviction; 16 MB per body, which clears the largest known (H.R. 133 as XML, 9,812,888 bytes) — a larger body is captured until it passes the ceiling, then dropped and read as before; a 10-minute TTL from insert, inside congress.gov's own `max-age=1800`. While a cold read streams, it holds the body's chunks up to that ceiling, and inserting copies them into the one owned buffer.
- **What is inserted.** Only a read whose window stops short of the end (`nextOffset !== null`), so a single-window document is never retained, and never a cancelled or failed read.
- **Replay.** 128 KiB slices with a macrotask between them, so a large document never holds the event loop for its whole parse, and the caller's signal is checked at each one. A replay makes no request and never spends the call's time budget.
- **No single-flight.** The first window inserts before it returns, so a walk's later windows hit whether they arrive in sequence or in parallel; concurrent cold reads each fetch, as they always did, and one caller's cancellation never touches another's read.
- **One cache for every tenant.** Keys are the server-resolved, allowlisted URL; every body is public and fetched without credentials. `ctx.state` was rejected: its in-memory provider bounds entry count only and JSON-parses the whole value on every read. Conditional requests and byte ranges were rejected too — bodies are versioned by URL, and offsets index extracted text while bodies arrive gzipped with no `Content-Length`.

### `content` offsets are exact, never snapped to section breaks

Bill text is SECTION-numbered, and aligning each window to the nearest section boundary reads as the friendlier design. It is not: a caller walking a document by feeding `nextOffset` back would then see characters twice or lose them at every seam, with no way to tell which. Offsets index the extracted plain text directly, so a walk returns every character exactly once. Section structure, if it is ever exposed, belongs in response metadata rather than in where a window starts.

### `content` uses `characterOffset`/`characterLimit`, not `offset`/`limit`

The window follows the repo's existing `offset` + `limit` + `nextOffset` idiom but cannot reuse those two fields: they are the Congress.gov pagination params, capped at `limit ≤ 250` because that is the API's own page ceiling. On a flat input object that cap cannot be widened for one operation without loosening validation for every list operation, and a 250-character window is useless. Separate names let each range carry the bounds it actually needs.

### PDF is not retrieved

Every document publishes PDF, and a few publish nothing else (the oldest CRS reports are PDF only). Extracting text from PDF means a parser dependency for a format that is redundant wherever Formatted Text or HTML exists. `content` declares `format_unavailable` for those documents; for a PDF-only CRS report the error names the PDF URL so the caller can read it directly.

---

## API Reference

### Pagination

All list endpoints use offset/limit: `offset` (default 0), `limit` (default 20, max 250). Responses include `pagination.count` and `pagination.next`.

### Date Filtering

Most list endpoints support `fromDateTime`/`toDateTime` (ISO 8601), which filter on the record's update date: when Congress.gov last touched it, not its latest legislative action, publication, received, or action date. Summaries filter on the summary's update time.

### Authentication

Congress.gov API requests send `X-Api-Key`; a configured key is optional and otherwise falls back to `DEMO_KEY`. Senate LIS, Voteview, and published-document requests need no API key.

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
| Nomination | `{congress}/{nominationNumber}` | `118/1064`; `PN730-2` maps to `730-2` |
| Amendment | `{congress}/{amendmentType}/{amendmentNumber}` | `118/hamdt/255` |
| Vote | `{chamber}/{congress}/{session}/{voteNumber}` | `house/118/1/234` |
| CRS Report | `reportNumber` | `R40097`, `96-548` |

---

## Future Considerations

- **Bound Congressional Record**: Date-based lookup into the permanent edited compilation. Niche archival use case — daily record covers active needs. Add as `congressgov_bound_record` if demand warrants.
- **Full-text search**: Delivered via `congressgov_search_bills` — keyword search over a local FTS mirror of bill title + summary (opt-in, `CONGRESS_MIRROR_ENABLED`); Congress.gov itself still exposes no search API
- **Treaties and hearings**: Lower-frequency endpoints, add as separate tools if demand warrants
- **House/Senate communications**: Niche endpoints — add only for specific use cases

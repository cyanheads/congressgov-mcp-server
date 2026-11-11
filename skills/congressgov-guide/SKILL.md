---
name: congressgov-guide
description: Use congressgov_* tools for legislative research across bills, amendments, enacted laws, members, committees, votes, and Congressional Record documents. Resolve linked identifiers, select the relevant document version, and check discovery coverage before reporting absence.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use for U.S. congressional research that follows legislation into its sponsors, committees, votes, reports, or floor debate. A topic alone needs a discovery path: the optional bill mirror searches titles and CRS summaries, not full bill text, CRS reports, or the Congressional Record.

## Identifiers

Carry identifiers from returned records across tool calls:

| Entity | Provenance |
|:---|:---|
| Bill | Congress, bill type, and bill number from bill discovery, member portfolios, or related bills |
| Amendment | Congress, `amendmentType` (`hamdt`, `samdt`, `suamdt`), and `amendmentNumber` from a bill lookup `amendments` row (`HAMDT 255`), a House roll call's `amendmentType`/`amendmentNumber` (`list` and `get`), or a member's `sponsored`/`cosponsored` amendment row (the number is on the row, the type only in the row's `url`); pass them to `congressgov_amendment_lookup`, in any letter case |
| Member | `bioguideId` from member discovery or a bill's sponsors and cosponsors |
| Committee | `systemCode` from committee discovery; resolve a committee name and inspect the candidates before following its legislation |
| Enacted law | `laws[].number` on an enacted-law row; the row's own bill number identifies the origin bill |
| Roll call | Chamber, congress, session, and roll number from vote discovery, or a bill or nomination action's `rollVote` (the vote that action records or cites, ready to pass to `congressgov_roll_votes`); retain the complete identity when reading detail and positions. A second session can run into January 1–3 of the following year, so an odd/even reading of the vote's calendar year misplaces those votes |
| Record article | Volume and issue from Record discovery, then the article's absolute position within the issue |

## Gates

- Before topical discovery, check whether `congressgov_search_bills` is offered. If absent, obtain a bill, member, committee, or CRS report seed; do not send a topic to browse-only tools. Committee name matching resolves committee names, not policy topics.
- Before reporting no relevant bills, inspect search notices and coverage. An unbuilt mirror returns no results, and a ready mirror covers a bounded congress window and only titles and summaries. Read the searchable boundary from `mirroredCongresses`; a notice that the requested congress is outside it is not a negative finding, so browse that congress through bill lookup instead. Broaden overly specific terms; report the search boundary with any negative finding.
- Before interpreting recent activity, distinguish a record's update date from its `latestAction.actionDate`. The update date does not establish when legislative action occurred. A `fromDateTime`/`toDateTime` window filters on update date, so a committee's `bills` in a window include older referrals touched in it; check each row's `actionDate` before reporting what a committee received in that period.
- Before comparing provisions or quoting legislation, select the relevant published text version and inspect its label and any supplied date. A date may be absent; do not infer one from the bill's update date. A discovery preview or CRS summary is not the bill text; preserve the version and source URL with the evidence.
- Before interpreting a member's vote as support for a bill, inspect the roll call's question, associated measure, and result. Match the requested chamber and session; a vote associated with a bill does not by itself establish final passage.
- Before concluding a committee was resolved, inspect whether the response contains the requested detail or candidate rows. Choose a candidate by its returned name, chamber, and code; approximate matches need the same check. A name shared by two chambers (`judiciary`) matches both unless `chamber` is set, which resolves it among that chamber's committees only.

## Core chain

Start from a discovered bill identity and read `congressgov_bill_lookup` detail. Use its summaries for orientation and its latest action for status; inspect published text when the answer depends on a provision. Follow sponsor identities into `congressgov_member_lookup` and related bill identities back into bill lookup. Resolve committees through committee discovery. Keep each claim attached to its bill and version when combining findings across these branches.

## Workflows

**Topic research.** When available, use `congressgov_search_bills` to obtain candidate bills, then verify candidates through live bill lookup. Search words must all match, so widen a narrow search with `OR` (`wildfire OR drought`) rather than more words, use `"exact phrase"` and `word*` for wording and stems, and narrow with `-word`. An excluded word needs a term to search for beside it, and only uppercase `AND`, `OR`, and `NOT` are operators. When a notice says `NOT` or a leading `-` was read as an exclusion and the words were the name you meant (`DO NOT CALL`, `covid -19`), search again with `"NOT"` quoted or the hyphen joined (`covid-19`) before treating the results as complete. Follow related bills and relevant sponsor portfolios to widen the investigation. Search silence says nothing about whether CRS analysis or floor debate exists.

**Enacted law.** Use `congressgov_enacted_laws` to resolve a law citation, then follow the returned origin bill through bill lookup. Keep the law citation and bill identity distinct. Read the intended published version before describing the enacted provisions.

**Member voting.** Resolve the person through member discovery or a bill's sponsor records. Find the relevant roll call with `congressgov_roll_votes`, or take it from a bill lookup `actions` row's `rollVote`, then read positions for that same roll call with `members`, filtered by `bioguideId` or `stateCode` (and `party`) so one call returns the member or delegation. House data comes from Congress.gov (115th Congress on; an earlier House vote fails `not_found`, and the House Clerk's vote XML in a bill action's `recordedVotes` holds it) and Senate data from the Senate LIS feed (101st Congress on). When that feed can't be read, Voteview answers instead and the response carries `source`; its `latestVote` is the newest Senate vote Voteview has, and a later vote is not found yet, which says nothing about whether it was held. Senate `members` rejects `bioguideId` on either source, so filter senators by `stateCode` and match by name. Inspect the returned roster fields before joining them to member profiles.

**Amendments.** Take the amendment identity from a bill's `amendments` rows, a House vote's `amendmentType`/`amendmentNumber`, or a member's amendment rows, and read `congressgov_amendment_lookup` `get` for the sponsor, purpose, and the bill or amendment it amends. Its `actions` rows that record one roll call carry `rollVote`; pass it to `congressgov_roll_votes` for the tally and positions. `content` reads one text version, which is the whole Congressional Record page that prints the amendment, often far longer than the amendment. Locate the amendment before reading on: a Senate amendment is printed under `SA {number}` or `Amendment No. {number}`; a House amendment is not printed under its HAMDT number, so look for the Record page its `actions` rows cite (`text: CR H3582-3583` → `[[Page H3582]]`) or the `Amendment No. N Offered by` heading, N being the House Report number in `get`'s description. Walk `nextOffset` only as far as needed.

**Floor debate.** Navigate `congressgov_daily_record` from volumes to issues to articles. When an article comes from a later page, its content selection uses the absolute issue position, not its position within that page. Read the selected article's content and retain its title and source URL.

**Document evidence.** Bill and committee-report text listings, and a CRS report's `get`, expose versions or formats; they do not contain the document body. Use the corresponding content operation to read it, walking `nextOffset`. A committee report may be filed in several parts: check `parts` on `get` and pass `part` to read Part 2 or later; the default is Part 1. Continue with the returned content offset while preserving the same document selection and format. Summary text has a separate continuation offset: use the summary row's continuation and retain its version code instead of advancing the list page. Distinguish an unfinished text window from the end of a list. A CRS `get` returns related materials a page at a time; follow `relatedMaterialsNextOffset` as `offset`.

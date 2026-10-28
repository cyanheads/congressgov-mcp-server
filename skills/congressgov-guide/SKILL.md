---
name: congressgov-guide
description: Use congressgov_* tools for legislative research across bills, enacted laws, members, committees, votes, and Congressional Record documents. Resolve linked identifiers, select the relevant document version, and check discovery coverage before reporting absence.
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
| Member | `bioguideId` from member discovery or a bill's sponsors and cosponsors |
| Committee | `systemCode` from committee discovery; resolve a committee name and inspect the candidates before following its legislation |
| Enacted law | `laws[].number` on an enacted-law row; the row's own bill number identifies the origin bill |
| Roll call | Chamber, congress, session, and roll number from vote discovery; retain the complete identity when reading detail and positions |
| Record article | Volume and issue from Record discovery, then the article's absolute position within the issue |

## Gates

- Before topical discovery, check whether `congressgov_search_bills` is offered. If absent, obtain a bill, member, committee, or CRS report seed; do not send a topic to browse-only tools. Committee name matching resolves committee names, not policy topics.
- Before reporting no relevant bills, inspect search notices and coverage. An unbuilt mirror returns no results, and a ready mirror covers a bounded congress window and only titles and summaries. Broaden overly specific terms; report the search boundary with any negative finding.
- Before interpreting recent activity, distinguish a record's update date from its `latestAction.actionDate`. The update date does not establish when legislative action occurred.
- Before comparing provisions or quoting legislation, select the relevant published text version and inspect its label and any supplied date. A date may be absent; do not infer one from the bill's update date. A discovery preview or CRS summary is not the bill text; preserve the version and source URL with the evidence.
- Before interpreting a member's vote as support for a bill, inspect the roll call's question, associated measure, and result. Match the requested chamber and session; a vote associated with a bill does not by itself establish final passage.
- Before concluding a committee was resolved, inspect whether the response contains the requested detail or candidate rows. Choose a candidate by its returned name, chamber, and code; approximate matches need the same check.

## Core chain

Start from a discovered bill identity and read `congressgov_bill_lookup` detail. Use its summaries for orientation and its latest action for status; inspect published text when the answer depends on a provision. Follow sponsor identities into `congressgov_member_lookup` and related bill identities back into bill lookup. Resolve committees through committee discovery. Keep each claim attached to its bill and version when combining findings across these branches.

## Workflows

**Topic research.** When available, use `congressgov_search_bills` to obtain candidate bills, then verify candidates through live bill lookup. Search terms are AND-combined ordinary text; use fewer terms or separate searches for alternatives rather than FTS Boolean operators. Follow related bills and relevant sponsor portfolios to widen the investigation. Search silence says nothing about whether CRS analysis or floor debate exists.

**Enacted law.** Use `congressgov_enacted_laws` to resolve a law citation, then follow the returned origin bill through bill lookup. Keep the law citation and bill identity distinct. Read the intended published version before describing the enacted provisions.

**Member voting.** Resolve the person through member discovery or a bill's sponsor records. Find the relevant roll call with `congressgov_roll_votes`, inspect its detail, then read positions for that same roll call. House data comes from Congress.gov and Senate data from the Senate LIS feed; inspect the returned roster fields before joining them to member profiles.

**Floor debate.** Navigate `congressgov_daily_record` from volumes to issues to articles. When an article comes from a later page, its content selection uses the absolute issue position, not its position within that page. Read the selected article's content and retain its title and source URL.

**Document evidence.** Bill and committee-report text listings expose versions or formats; they do not contain the document body. Use the corresponding content operation to read it. Continue with the returned content offset while preserving the same document selection and format. Summary text has a separate continuation offset: use the summary row's continuation and retain its version code instead of advancing the list page. Distinguish an unfinished text window from the end of a list.

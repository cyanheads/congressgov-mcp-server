/**
 * @fileoverview Pure parsers for the Senate LIS roll-call XML feed.
 *
 * Two document shapes are parsed:
 * - The session menu (`vote_menu_{congress}_{session}.xml`) → `SenateVoteSummary[]`.
 * - An individual vote (`vote_{congress}_{session}_{nnnnn}.xml`) → vote record + roster.
 *
 * These functions are deliberately free of I/O so they can be exercised directly
 * against real feed fixtures — the feed has quirks (mixed-content `<question>` with
 * a nested `<measure>`, empty self-closing elements, single-element collapse) that
 * are easy to get wrong and worth pinning with tests.
 *
 * The feed's calendar facts live here too: the congress it starts at
 * (`SENATE_VOTE_FIRST_CONGRESS`) and the session a dated vote falls in
 * (`senateSessionForDate`), shared by the service and by tools that point at it.
 *
 * Parser config notes:
 * - `isArray` forces `<vote>` and `<member>` to arrays so a session/vote with a
 *   single entry doesn't collapse to an object.
 * - `parseTagValue: false` keeps every leaf a string; numbers are coerced
 *   explicitly so zero-padded roll numbers and empty `<present/>` tallies behave.
 *
 * @module services/senate-lis/parse
 */

import { XMLParser } from 'fast-xml-parser';
import { congressFirstYear, FIRST_CONGRESS_YEAR, ordinal } from '@/utils/congress-calendar.js';
import type {
  ParsedRollCallVote,
  SenateMemberVote,
  SenatePartyTotal,
  SenateVoteAmendment,
  SenateVoteDetail,
  SenateVoteDocument,
  SenateVoteSummary,
} from './types.js';

const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  parseTagValue: false,
  processEntities: true,
  isArray: (name) => name === 'vote' || name === 'member',
});

type XmlRecord = Record<string, unknown>;

function str(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** Collapse internal whitespace and trim — feed text carries stray newlines and double spaces. */
function norm(value: unknown): string {
  return str(value).replace(/\s+/g, ' ').trim();
}

/** Normalized text, or undefined when empty (covers `<tag/>` self-closing elements). */
function opt(value: unknown): string | undefined {
  const normalized = norm(value);
  return normalized === '' ? undefined : normalized;
}

/** Coerce a leaf to a number; empty/`<present/>`/non-numeric become 0. */
function num(value: unknown): number {
  const parsed = Number(str(value).trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Drop keys whose value is `undefined`, narrowing the value types accordingly.
 * Spread the result alongside the required fields so optional fields are simply
 * absent when empty — clean output, and assignable under `exactOptionalPropertyTypes`.
 */
function defined<T extends XmlRecord>(
  obj: T,
): Partial<{ [K in keyof T]: Exclude<T[K], undefined> }> {
  const out: XmlRecord = {};
  for (const [key, value] of Object.entries(obj)) if (value !== undefined) out[key] = value;
  return out as Partial<{ [K in keyof T]: Exclude<T[K], undefined> }>;
}

/** Menu rows publish `DD-Mon`; the year lives on the menu root, not the row. */
const MENU_DATE_RE = /^(\d{1,2})-([A-Za-z]{3})$/;
/** Indexed by calendar order — the index is the month the walk compares. */
const MONTH_ABBREVIATIONS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');

/**
 * The first congress whose roll call votes the LIS feed publishes. Nothing points a
 * caller at a Senate vote from an earlier congress.
 */
export const SENATE_VOTE_FIRST_CONGRESS = 101;

/** Day and 0-based month of a `DD-Mon` menu date, or `undefined` when it is neither. */
function parseMenuDate(value: string | undefined): { day: number; month: number } | undefined {
  const match = value === undefined ? null : MENU_DATE_RE.exec(value);
  if (!match) return;
  const month = MONTH_ABBREVIATIONS.indexOf((match[2] as string).toLowerCase());
  return month === -1 ? undefined : { day: Number(match[1]), month };
}

/** `YYYY-MM-DD`, or `undefined` when the day does not exist in that month. */
function isoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    return;
  }
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The calendar year a congress opens in, or `undefined` when `congress` is not a positive integer. */
function openingYear(congress: number): number | undefined {
  if (!Number.isInteger(congress) || congress < 1) return;
  return congressFirstYear(congress);
}

/** The feed's coverage, as the Senate "no votes" messages state it. */
export const SENATE_VOTE_COVERAGE = `the Senate publishes roll call votes from the ${ordinal(SENATE_VOTE_FIRST_CONGRESS)} Congress (${congressFirstYear(SENATE_VOTE_FIRST_CONGRESS)}) onward`;

/** The calendar year a congress's session opens in — the 118th's first session opened in 2023. */
function nominalSessionYear(congress: number, session: number): number | undefined {
  const firstYear = openingYear(congress);
  if (firstYear === undefined || (session !== 1 && session !== 2)) return;
  return firstYear + (session - 1);
}

/** `YYYY-MM-DD`, the shape of a Congress.gov `actionDate`. */
const ISO_DATE_RE = /^(\d{4})-\d{2}-\d{2}$/;

/**
 * The session of `congress` a vote dated `date` (`YYYY-MM-DD`) was cast in, or
 * `undefined` when the date has another shape or falls outside the congress.
 *
 * The congress's first year is session 1 and its second year session 2. A second
 * session can also sit through January 1–3 of the year after, until the next
 * congress convenes: the 116th's second session voted on 2021-01-01, and the 115th's
 * opened on 2018-01-03 with vote 1. The calendar parity of the year alone misses that
 * tail. No Senate vote from the 101st Congress onward was cast by a first session in
 * those January days, so they always read as session 2.
 */
export function senateSessionForDate(congress: number, date: string): 1 | 2 | undefined {
  const firstYear = openingYear(congress);
  const match = ISO_DATE_RE.exec(date);
  if (firstYear === undefined || !match) return;
  const year = Number(match[1]);
  if (year === firstYear) return 1;
  if (year === firstYear + 1) return 2;
  /** `MM-DD` is fixed-width, so string order is calendar order. */
  const monthDay = date.slice(5);
  if (year === firstYear + 2 && monthDay >= '01-01' && monthDay <= '01-03') return 2;
  return;
}

/** The year the menu's own dates start in: its `<congress_year>`, else the nominal one. */
function menuBaseYear(root: XmlRecord): number | undefined {
  const published = num(root.congress_year);
  if (Number.isInteger(published) && published >= FIRST_CONGRESS_YEAR) return published;
  return nominalSessionYear(num(root.congress), num(root.session));
}

/**
 * Resolve each row's calendar date from the menu's year and the session's vote
 * sequence.
 *
 * The rows publish `DD-Mon` and the root names only the year the session opened,
 * but a session can sit past December 31 — the 116th Congress cast votes 291 and
 * 292 of its second session on January 1, 2021, under a `<congress_year>` of
 * 2020. Roll numbers are chronological within a session, so walking them in
 * ascending order and advancing the year wherever the month decreases resolves
 * that tail without guessing. A row whose date does not parse is left unresolved
 * rather than pinned to a neighbouring year.
 */
function resolveSessionDates(
  voteNumbers: number[],
  voteDates: (string | undefined)[],
  baseYear: number | undefined,
): (string | undefined)[] {
  const resolved = new Array<string | undefined>(voteNumbers.length);
  if (baseYear === undefined) return resolved;

  const ascending = voteNumbers
    .map((_, index) => index)
    .sort((a, b) => (voteNumbers[a] as number) - (voteNumbers[b] as number));

  let year = baseYear;
  let previousMonth: number | undefined;
  for (const index of ascending) {
    const date = parseMenuDate(voteDates[index]);
    if (!date) continue;
    if (previousMonth !== undefined && date.month < previousMonth) year++;
    previousMonth = date.month;
    resolved[index] = isoDate(year, date.month, date.day);
  }
  return resolved;
}

/**
 * Menu `<question>` is mixed content: plain text for most votes, but amendment
 * votes nest a `<measure>` ("On the Amendment <measure>S.Amdt. 3331</measure>").
 * fast-xml-parser surfaces the latter as `{ '#text', measure }`.
 */
function questionParts(question: unknown): { question?: string; measure?: string } {
  if (question == null) return {};
  if (typeof question === 'string') return defined({ question: opt(question) });
  if (typeof question === 'object') {
    const obj = question as XmlRecord;
    return defined({ question: opt(obj['#text']), measure: opt(obj.measure) });
  }
  return {};
}

/** Parse the session vote menu into summary rows, in feed order (newest first). */
export function parseVoteMenu(xml: string): SenateVoteSummary[] {
  const root = (parser.parse(xml) as { vote_summary?: XmlRecord }).vote_summary;
  if (!root || typeof root !== 'object') {
    throw new Error('Senate vote menu XML is missing its <vote_summary> root.');
  }

  const votesNode = root.votes as { vote?: unknown } | undefined;
  const votes = toArray(votesNode?.vote) as XmlRecord[];
  const voteDates = votes.map((vote) => opt(vote.vote_date));
  const resolvedDates = resolveSessionDates(
    votes.map((vote) => num(vote.vote_number)),
    voteDates,
    menuBaseYear(root),
  );

  return votes.map((vote, index): SenateVoteSummary => {
    const { question, measure } = questionParts(vote.question);
    const tally = (vote.vote_tally ?? {}) as XmlRecord;
    return {
      chamber: 'senate',
      voteNumber: num(vote.vote_number),
      yeas: num(tally.yeas),
      nays: num(tally.nays),
      ...defined({
        voteDate: voteDates[index],
        voteDateIso: resolvedDates[index],
        issue: opt(vote.issue),
        question,
        measure,
        result: opt(vote.result),
        title: opt(vote.title),
      }),
    };
  });
}

function buildDocument(doc: XmlRecord): SenateVoteDocument | undefined {
  const built: SenateVoteDocument = defined({
    congress: opt(doc.document_congress) ? num(doc.document_congress) : undefined,
    type: opt(doc.document_type),
    number: opt(doc.document_number),
    name: opt(doc.document_name),
    title: opt(doc.document_title),
    shortTitle: opt(doc.document_short_title),
  });
  /** A bare `congress` with no measure reference is not worth surfacing. */
  if (!built.type && !built.number && !built.name && !built.title && !built.shortTitle) {
    return;
  }
  return built;
}

function buildAmendment(amendment: XmlRecord): SenateVoteAmendment | undefined {
  const number = opt(amendment.amendment_number);
  /** `amendment_number` is the signal of a real amendment — the block is otherwise
   * present-but-empty (often just `amendment_purpose: "No Statement of Purpose on File."`). */
  if (!number) return;
  return {
    number,
    ...defined({
      toDocumentNumber: opt(amendment.amendment_to_document_number),
      toDocumentShortTitle: opt(amendment.amendment_to_document_short_title),
      purpose: opt(amendment.amendment_purpose),
    }),
  };
}

function buildMember(member: XmlRecord): SenateMemberVote {
  return {
    chamber: 'senate',
    ...defined({
      memberFull: opt(member.member_full),
      firstName: opt(member.first_name),
      lastName: opt(member.last_name),
      party: opt(member.party),
      state: opt(member.state),
      voteCast: opt(member.vote_cast),
      lisMemberId: opt(member.lis_member_id),
    }),
  };
}

/** Parse an individual roll call vote into its record and full member roster. */
export function parseRollCallVote(xml: string): ParsedRollCallVote {
  const root = (parser.parse(xml) as { roll_call_vote?: XmlRecord }).roll_call_vote;
  if (!root || typeof root !== 'object') {
    throw new Error('Senate roll call vote XML is missing its <roll_call_vote> root.');
  }

  const count = (root.count ?? {}) as XmlRecord;
  const document = buildDocument((root.document ?? {}) as XmlRecord);
  const amendment = buildAmendment((root.amendment ?? {}) as XmlRecord);
  const membersNode = root.members as { member?: unknown } | undefined;
  const members = (toArray(membersNode?.member) as XmlRecord[]).map(buildMember);

  const vote: SenateVoteDetail = {
    chamber: 'senate',
    congress: num(root.congress),
    session: num(root.session),
    voteNumber: num(root.vote_number),
    count: {
      yeas: num(count.yeas),
      nays: num(count.nays),
      present: num(count.present),
      absent: num(count.absent),
    },
    ...defined({
      voteDate: opt(root.vote_date),
      modifyDate: opt(root.modify_date),
      question: opt(root.question),
      voteQuestionText: opt(root.vote_question_text),
      voteTitle: opt(root.vote_title),
      voteResult: opt(root.vote_result),
      voteResultText: opt(root.vote_result_text),
      voteDocumentText: opt(root.vote_document_text),
      majorityRequirement: opt(root.majority_requirement),
      document,
      amendment,
    }),
  };

  return { vote, members };
}

/**
 * Derive a per-party tally from the roster. The LIS feed publishes no party
 * breakdown, so this aggregates each member's party + cast — real per-member data,
 * not a fabricated figure. Ordered by participation (desc), then party (asc).
 */
export function computePartyTotals(members: SenateMemberVote[]): SenatePartyTotal[] {
  const totals = new Map<string, SenatePartyTotal>();
  for (const member of members) {
    const party = member.party ?? '?';
    let total = totals.get(party);
    if (!total) {
      total = { party, yea: 0, nay: 0, present: 0, notVoting: 0 };
      totals.set(party, total);
    }
    switch (member.voteCast) {
      case 'Yea':
        total.yea++;
        break;
      case 'Nay':
        total.nay++;
        break;
      case 'Present':
        total.present++;
        break;
      case 'Not Voting':
        total.notVoting++;
        break;
    }
  }
  return [...totals.values()].sort((a, b) => {
    const aTotal = a.yea + a.nay + a.present + a.notVoting;
    const bTotal = b.yea + b.nay + b.present + b.notVoting;
    return bTotal - aTotal || a.party.localeCompare(b.party);
  });
}

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
 * Parser config notes:
 * - `isArray` forces `<vote>` and `<member>` to arrays so a session/vote with a
 *   single entry doesn't collapse to an object.
 * - `parseTagValue: false` keeps every leaf a string; numbers are coerced
 *   explicitly so zero-padded roll numbers and empty `<present/>` tallies behave.
 *
 * @module services/senate-lis/parse
 */

import { XMLParser } from 'fast-xml-parser';
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

  return votes.map((vote): SenateVoteSummary => {
    const { question, measure } = questionParts(vote.question);
    const tally = (vote.vote_tally ?? {}) as XmlRecord;
    return {
      chamber: 'senate',
      voteNumber: num(vote.vote_number),
      yeas: num(tally.yeas),
      nays: num(tally.nays),
      ...defined({
        voteDate: opt(vote.vote_date),
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

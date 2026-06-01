/**
 * @fileoverview Domain types for Senate LIS roll-call vote data.
 *
 * The Congress.gov API v3 exposes House votes only; Senate roll call votes are
 * published solely through the Senate's official LIS XML feed
 * (https://www.senate.gov/legislative/LIS/roll_call_votes/). These types describe
 * the normalized, camelCased shapes the parser produces from that XML — distinct
 * from the House JSON shapes the Congress.gov API returns.
 *
 * Every record carries `chamber: 'senate'` so the shared vote formatter can route
 * Senate payloads to the Senate renderers without inspecting field shapes.
 *
 * @module services/senate-lis/types
 */

/** A single row from the Senate vote menu (`vote_menu_{congress}_{session}.xml`). */
export type SenateVoteSummary = {
  chamber: 'senate';
  /** Roll call number within the session (1-based, not zero-padded). */
  voteNumber: number;
  /** Short date as published in the menu, e.g. "21-Dec" (no year — derive from session). */
  voteDate?: string;
  /** Associated measure label, e.g. "H.R. 10545", "PN373". */
  issue?: string;
  /** Vote question, e.g. "On Passage of the Bill", "On the Amendment". */
  question?: string;
  /** Amendment reference parsed from the menu question's nested `<measure>`, when present. */
  measure?: string;
  /** Outcome, e.g. "Passed", "Agreed to", "Rejected". */
  result?: string;
  yeas: number;
  nays: number;
  /** Full title / description of the matter voted on. */
  title?: string;
};

/** Associated legislative document attached to a Senate vote (bill, nomination, amendment). */
export type SenateVoteDocument = {
  congress?: number;
  /** Document type, e.g. "PN" (nomination), "S.", "H.R.", "S.Amdt.". */
  type?: string;
  number?: string;
  name?: string;
  title?: string;
  shortTitle?: string;
};

/** Amendment metadata, populated only on amendment votes. */
export type SenateVoteAmendment = {
  number?: string;
  toDocumentNumber?: string;
  toDocumentShortTitle?: string;
  purpose?: string;
};

/** Official tally block from the vote record. */
export type SenateVoteCount = {
  yeas: number;
  nays: number;
  present: number;
  absent: number;
};

/**
 * Per-party tally derived from the member roster. The LIS feed does not publish a
 * party breakdown, so this is computed from each member's party + cast — honest
 * aggregation of real per-member data, not an upstream-provided figure.
 */
export type SenatePartyTotal = {
  /** Party code: "D", "R", "I". */
  party: string;
  yea: number;
  nay: number;
  present: number;
  /** "Not Voting" casts (the Senate term for absent). */
  notVoting: number;
};

/** A fully parsed Senate roll call vote record (`vote_{congress}_{session}_{nnnnn}.xml`). */
export type SenateVoteDetail = {
  chamber: 'senate';
  congress: number;
  session: number;
  voteNumber: number;
  /** Full timestamp, e.g. "January 8, 2024, 05:27 PM". */
  voteDate?: string;
  modifyDate?: string;
  /** Short question, e.g. "On the Cloture Motion". */
  question?: string;
  /** Full question text, e.g. "On the Cloture Motion PN1020". */
  voteQuestionText?: string;
  voteTitle?: string;
  /** Outcome label, e.g. "Cloture Motion Agreed to". */
  voteResult?: string;
  /** Outcome with tally, e.g. "Cloture Motion Agreed to (73-15)". */
  voteResultText?: string;
  /** Narrative describing the matter (nominee bio, amendment purpose). */
  voteDocumentText?: string;
  /** Threshold required to prevail, e.g. "1/2", "3/5", "2/3". */
  majorityRequirement?: string;
  count: SenateVoteCount;
  document?: SenateVoteDocument;
  amendment?: SenateVoteAmendment;
  /** Party breakdown derived from the roster (present on `get`, omitted on `members`). */
  partyTotals?: SenatePartyTotal[];
};

/** One member's recorded position on a Senate roll call. */
export type SenateMemberVote = {
  chamber: 'senate';
  /** Display name as published, e.g. "Baldwin (D-WI)". */
  memberFull?: string;
  firstName?: string;
  lastName?: string;
  /** Party code: "D", "R", "I". */
  party?: string;
  /** Two-letter state code. */
  state?: string;
  /** Cast: "Yea", "Nay", "Present", or "Not Voting". */
  voteCast?: string;
  /** Senate LIS member identifier, e.g. "S354". */
  lisMemberId?: string;
};

/** Parsed individual-vote payload: the vote record plus its full member roster. */
export type ParsedRollCallVote = {
  vote: SenateVoteDetail;
  members: SenateMemberVote[];
};

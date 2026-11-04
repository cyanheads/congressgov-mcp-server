/**
 * @fileoverview Domain types for Senate LIS roll-call vote data.
 *
 * The Congress.gov API v3 exposes House votes only; Senate roll call votes are
 * published through the Senate's official LIS XML feed
 * (https://www.senate.gov/legislative/LIS/roll_call_votes/), and by Voteview's CSV
 * files when that feed can't be read. These types describe the normalized,
 * camelCased shapes the parsers produce from either source — distinct
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
  /** Short date exactly as the menu publishes it, e.g. "21-Dec" — the feed carries no year. */
  voteDate?: string;
  /**
   * The row's calendar date as `YYYY-MM-DD`, derived from the menu's own
   * `<congress_year>` and the session's vote sequence. A session can sit past
   * December 31, so this is not the session's opening year for every row. Absent
   * when the published short date does not parse or the menu names no year.
   */
  voteDateIso?: string;
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

/**
 * A Senate roll call vote record: parsed from the LIS feed
 * (`vote_{congress}_{session}_{nnnnn}.xml`), or from Voteview's files when the feed
 * can't be read. Voteview publishes a subset — date, question, result,
 * description, measure, majority, and tally — so its records carry `voteDateIso`
 * and `issue` and none of the LIS-only fields.
 */
export type SenateVoteDetail = {
  chamber: 'senate';
  congress: number;
  session: number;
  voteNumber: number;
  /** Full timestamp, e.g. "January 8, 2024, 05:27 PM". */
  voteDate?: string;
  /** Calendar date as `YYYY-MM-DD` — Voteview publishes a date, not a time. */
  voteDateIso?: string;
  /** Associated measure as Voteview publishes it, e.g. "PN1129", "HR82". */
  issue?: string;
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
  /** Name as Voteview publishes it, surname first, e.g. "BALDWIN, Tammy". */
  name?: string;
  /** Biographical Directory ID, from Voteview's members file. The LIS feed carries none. */
  bioguideId?: string;
};

/**
 * Where a Senate response came from when the LIS feed could not be read and
 * Voteview's per-congress files served it instead. Absent on LIS responses.
 */
export type SenateVoteSource = {
  name: 'Voteview';
  url: string;
  congress: number;
  /** Voteview's newest Senate roll call for `congress`; while that congress sits, later votes are not in it yet. */
  latestVote: { session: number; voteNumber: number; date: string };
  /** The citation Voteview asks its users to give. */
  citation: string;
};

/** Parsed individual-vote payload: the vote record plus its full member roster. */
export type ParsedRollCallVote = {
  vote: SenateVoteDetail;
  members: SenateMemberVote[];
};

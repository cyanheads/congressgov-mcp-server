/**
 * @fileoverview Pure parsers for Voteview's per-congress Senate vote files
 * (`S{congress}_rollcalls.csv`, `S{congress}_votes.csv`, `S{congress}_members.csv`)
 * and their mapping onto the Senate vote shapes the LIS feed produces.
 *
 * Voteview numbers a congress's roll calls with its own `rollnumber`; the
 * `session` and `clerk_rollnumber` columns carry the Senate's own numbering, which
 * is what callers address a vote by. Its votes file also records the President's
 * position on each roll call (a members row with chamber `President`); that is no
 * senator's vote and is dropped, which leaves every roll call's roster agreeing with
 * its published `yea_count` and `nay_count`.
 *
 * A parsed congress keeps each roll call's metadata, each senator once, and the
 * positions as one byte per senator per roll call, and states what it keeps
 * alive in `retainedBytes` so a cache can bound itself in bytes.
 *
 * @module services/senate-lis/voteview-parse
 */

import { readCsv } from './csv.js';
import { defined } from './parse.js';
import type {
  ParsedRollCallVote,
  SenateMemberVote,
  SenateVoteDetail,
  SenateVoteSummary,
} from './types.js';

/** The three files of one congress, as text. */
export type VoteviewFiles = { rollcalls: string; votes: string; members: string };

/** One Senate roll call as Voteview publishes it. */
type VoteviewRollCall = {
  session: number;
  /** The Senate's own roll call number within the session (`clerk_rollnumber`). */
  voteNumber: number;
  /** `YYYY-MM-DD`. */
  date: string;
  yeas: number;
  nays: number;
  question?: string;
  result?: string;
  description?: string;
  /** The measure as Voteview writes it, e.g. "PN1129", "HR82". */
  billNumber?: string;
  majorityRequirement?: string;
};

type VoteviewSenator = {
  name?: string;
  bioguideId?: string;
  party?: string;
  state?: string;
};

/** One congress of Voteview Senate data, parsed. */
export type VoteviewCongress = {
  congress: number;
  /** Ascending by session, then vote number; only roll calls whose roster is published. */
  rollCalls: readonly VoteviewRollCall[];
  /** Ordered by name, as the Senate's own rosters run alphabetically. */
  senators: readonly VoteviewSenator[];
  /**
   * The Voteview cast code of senator `s` on roll call `r` at `r * senators.length + s`;
   * 0 where the senator was not a member for that vote.
   */
  casts: Uint8Array;
  /**
   * Upper bound on the heap this record keeps alive: both text files whose
   * strings it slices, counted at two bytes a character, the cast matrix, and a
   * fixed allowance per roll call and per senator.
   */
  retainedBytes: number;
};

/** Per-object allowance in `retainedBytes`, above the strings each holds. */
const ROLL_CALL_BYTES = 512;
const SENATOR_BYTES = 192;

/**
 * Voteview's party codes for the parties seated in the Senate since the 101st
 * Congress (`HSall_parties.csv`). Another code leaves `party` unset.
 */
const PARTY_CODES = new Map([
  [100, 'D'],
  [200, 'R'],
  [328, 'I'],
]);

/**
 * The Senate's term for each Voteview cast code. Paired and announced positions
 * (2–5) are not votes: Voteview counts none of them in `yea_count` or
 * `nay_count`, and the Senate records those senators as not voting. 0 marks a
 * senator who was not a member when the vote was taken.
 */
const CAST_LABELS = [
  undefined,
  'Yea',
  'Not Voting',
  'Not Voting',
  'Not Voting',
  'Not Voting',
  'Nay',
  'Present',
  'Present',
  'Not Voting',
] as const;

/** Integers as Voteview writes them: `12`, or `12.0` in its older files. */
const WHOLE_NUMBER_RE = /^\d+(?:\.0*)?$/;

function wholeNumber(value: string | undefined): number | undefined {
  if (value === undefined || !WHOLE_NUMBER_RE.test(value)) return;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function opt(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Call `onRow` for every data row of a CSV file, with the index of each named
 * column. A file without one of `names` in its header is not the file expected.
 */
function eachRow<const K extends string>(
  text: string,
  file: string,
  names: readonly K[],
  onRow: (fields: string[], column: Record<K, number>) => void,
): void {
  let column: Record<K, number> | undefined;
  readCsv(text, (fields) => {
    if (column) {
      onRow(fields, column);
      return;
    }
    const found = {} as Record<K, number>;
    for (const name of names) {
      const index = fields.indexOf(name);
      if (index === -1) throw new Error(`Voteview's ${file} file has no ${name} column.`);
      found[name] = index;
    }
    column = found;
  });
  if (!column) throw new Error(`Voteview's ${file} file is empty.`);
}

/** A whole-number column that every Senate row must carry. */
function required(fields: string[], index: number, file: string, name: string): number {
  const value = wholeNumber(fields[index]);
  if (value === undefined) {
    throw new Error(
      `Voteview's ${file} file has a Senate row whose ${name} is not a whole number (${JSON.stringify(fields[index] ?? '')}).`,
    );
  }
  return value;
}

/**
 * Parse one congress's three files.
 *
 * @throws {Error} When a file is empty, lacks a column this reads, or carries a
 * Senate row whose numbers don't parse — the files are not the ones expected.
 */
export function parseVoteviewCongress(congress: number, files: VoteviewFiles): VoteviewCongress {
  const memberRows: Array<VoteviewSenator & { icpsr: number }> = [];
  eachRow(
    files.members,
    'members',
    ['chamber', 'icpsr', 'bioname', 'bioguide_id', 'party_code', 'state_abbrev'],
    (fields, c) => {
      if (fields[c.chamber] !== 'Senate') return;
      const partyCode = wholeNumber(fields[c.party_code]);
      memberRows.push({
        icpsr: required(fields, c.icpsr, 'members', 'icpsr'),
        ...defined({
          name: opt(fields[c.bioname]),
          bioguideId: opt(fields[c.bioguide_id]),
          party: partyCode === undefined ? undefined : PARTY_CODES.get(partyCode),
          state: opt(fields[c.state_abbrev]),
        }),
      });
    },
  );
  /** Code-point order, the same on every runtime; surnames lead in upper case. */
  memberRows.sort((a, b) => {
    const left = a.name ?? '';
    const right = b.name ?? '';
    return left < right ? -1 : left > right ? 1 : a.icpsr - b.icpsr;
  });
  const senatorIndex = new Map(memberRows.map((row, index) => [row.icpsr, index]));
  const senators = memberRows.map(({ icpsr: _icpsr, ...senator }): VoteviewSenator => senator);

  const rollRows: Array<VoteviewRollCall & { rollnumber: number }> = [];
  eachRow(
    files.rollcalls,
    'rollcalls',
    [
      'chamber',
      'rollnumber',
      'date',
      'session',
      'clerk_rollnumber',
      'majority_requirement',
      'yea_count',
      'nay_count',
      'bill_number',
      'vote_result',
      'vote_desc',
      'vote_question',
    ],
    (fields, c) => {
      if (fields[c.chamber] !== 'Senate') return;
      rollRows.push({
        rollnumber: required(fields, c.rollnumber, 'rollcalls', 'rollnumber'),
        session: required(fields, c.session, 'rollcalls', 'session'),
        voteNumber: required(fields, c.clerk_rollnumber, 'rollcalls', 'clerk_rollnumber'),
        date: fields[c.date] ?? '',
        yeas: required(fields, c.yea_count, 'rollcalls', 'yea_count'),
        nays: required(fields, c.nay_count, 'rollcalls', 'nay_count'),
        ...defined({
          question: opt(fields[c.vote_question]),
          result: opt(fields[c.vote_result]),
          description: opt(fields[c.vote_desc]),
          billNumber: opt(fields[c.bill_number]),
          majorityRequirement: opt(fields[c.majority_requirement]),
        }),
      });
    },
  );
  rollRows.sort((a, b) => a.session - b.session || a.voteNumber - b.voteNumber);
  const rollIndex = new Map(rollRows.map((row, index) => [row.rollnumber, index]));

  const width = senators.length;
  const casts = new Uint8Array(rollRows.length * width);
  const rosterSizes = new Uint16Array(rollRows.length);
  eachRow(files.votes, 'votes', ['rollnumber', 'icpsr', 'cast_code'], (fields, c) => {
    const rollnumber = wholeNumber(fields[c.rollnumber]);
    const icpsr = wholeNumber(fields[c.icpsr]);
    const roll = rollnumber === undefined ? undefined : rollIndex.get(rollnumber);
    const senator = icpsr === undefined ? undefined : senatorIndex.get(icpsr);
    /** The President's position, or a roll call the rollcalls file doesn't list. */
    if (roll === undefined || senator === undefined) return;
    const cast = required(fields, c.cast_code, 'votes', 'cast_code');
    if (cast >= CAST_LABELS.length) {
      throw new Error(`Voteview's votes file has an unknown cast_code ${cast}.`);
    }
    if (cast === 0) return;
    casts[roll * width + senator] = cast;
    rosterSizes[roll] = (rosterSizes[roll] as number) + 1;
  });

  /**
   * Voteview writes the three files one after another, so a fetch can catch the
   * rollcalls file a vote ahead of the votes file. A roll call with no roster
   * yet is past what Voteview has published, as are the ones after it.
   */
  let published = rollRows.length;
  while (published > 0 && rosterSizes[published - 1] === 0) published--;
  const rollCalls = rollRows
    .slice(0, published)
    .map(({ rollnumber: _rollnumber, ...rollCall }): VoteviewRollCall => rollCall);
  const kept = published === rollRows.length ? casts : casts.slice(0, published * width);

  return {
    congress,
    rollCalls,
    senators,
    casts: kept,
    retainedBytes:
      2 * (files.rollcalls.length + files.members.length) +
      kept.byteLength +
      rollCalls.length * ROLL_CALL_BYTES +
      senators.length * SENATOR_BYTES,
  };
}

/** The newest published roll call, or `undefined` when the congress has none yet. */
export function latestVoteviewRollCall(data: VoteviewCongress): VoteviewRollCall | undefined {
  return data.rollCalls.at(-1);
}

/** A session's roll calls as list rows, ascending by vote number. */
export function voteviewSessionVotes(data: VoteviewCongress, session: number): SenateVoteSummary[] {
  return data.rollCalls
    .filter((rollCall) => rollCall.session === session)
    .map(
      (rollCall): SenateVoteSummary => ({
        chamber: 'senate',
        voteNumber: rollCall.voteNumber,
        yeas: rollCall.yeas,
        nays: rollCall.nays,
        ...defined({
          voteDateIso: rollCall.date || undefined,
          issue: rollCall.billNumber,
          question: rollCall.question,
          result: rollCall.result,
          title: rollCall.description,
        }),
      }),
    );
}

/** The roll call `session`/`voteNumber` names, with its roster, or `undefined` when unpublished. */
export function voteviewRollCallVote(
  data: VoteviewCongress,
  session: number,
  voteNumber: number,
): ParsedRollCallVote | undefined {
  const index = findRollCall(data.rollCalls, session, voteNumber);
  if (index === undefined) return;
  const rollCall = data.rollCalls[index] as VoteviewRollCall;

  const width = data.senators.length;
  const members: SenateMemberVote[] = [];
  let present = 0;
  let absent = 0;
  for (let s = 0; s < width; s++) {
    const cast = data.casts[index * width + s] as number;
    const label = CAST_LABELS[cast];
    if (label === undefined) continue;
    if (label === 'Present') present++;
    else if (label === 'Not Voting') absent++;
    const senator = data.senators[s] as VoteviewSenator;
    members.push({
      chamber: 'senate',
      ...defined({
        name: senator.name,
        party: senator.party,
        state: senator.state,
        voteCast: label,
        bioguideId: senator.bioguideId,
      }),
    });
  }

  const vote: SenateVoteDetail = {
    chamber: 'senate',
    congress: data.congress,
    session: rollCall.session,
    voteNumber: rollCall.voteNumber,
    count: { yeas: rollCall.yeas, nays: rollCall.nays, present, absent },
    ...defined({
      voteDateIso: rollCall.date || undefined,
      question: rollCall.question,
      voteResult: rollCall.result,
      voteDocumentText: rollCall.description,
      majorityRequirement: rollCall.majorityRequirement,
      issue: rollCall.billNumber,
    }),
  };
  return { vote, members };
}

/** Binary search over roll calls ascending by (session, voteNumber). */
function findRollCall(
  rollCalls: readonly VoteviewRollCall[],
  session: number,
  voteNumber: number,
): number | undefined {
  let low = 0;
  let high = rollCalls.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const rollCall = rollCalls[mid] as VoteviewRollCall;
    const order = rollCall.session - session || rollCall.voteNumber - voteNumber;
    if (order === 0) return mid;
    if (order < 0) low = mid + 1;
    else high = mid - 1;
  }
  return;
}

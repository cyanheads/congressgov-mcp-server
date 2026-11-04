/**
 * @fileoverview Tests for the congressgov_roll_votes pointer builder and its coverage floors.
 * @module tests/mcp-server/tools/roll-vote-pointer.test
 */

import { describe, expect, it } from 'vitest';
import {
  HOUSE_VOTE_COVERAGE,
  HOUSE_VOTE_FIRST_CONGRESS,
  recordedRollVote,
  rollVotePointer,
} from '@/mcp-server/tools/roll-vote-pointer.js';
import { SENATE_VOTE_FIRST_CONGRESS } from '@/services/senate-lis/parse.js';

describe('rollVotePointer', () => {
  it('builds a House pointer from the first congress Congress.gov serves House votes for', () => {
    expect(HOUSE_VOTE_FIRST_CONGRESS).toBe(115);
    expect(rollVotePointer('house', 115, 1, 1)).toEqual({
      chamber: 'house',
      congress: 115,
      session: 1,
      voteNumber: 1,
    });
    expect(rollVotePointer('house', 114, 1, 178)).toBeUndefined();
  });

  it('builds a Senate pointer from the 101st Congress', () => {
    expect(SENATE_VOTE_FIRST_CONGRESS).toBe(101);
    expect(rollVotePointer('senate', 101, 2, 7)).toEqual({
      chamber: 'senate',
      congress: 101,
      session: 2,
      voteNumber: 7,
    });
    expect(rollVotePointer('senate', 100, 2, 7)).toBeUndefined();
  });

  it('keeps the Senate floor below the House floor: a 110th Congress vote points only in the Senate', () => {
    expect(rollVotePointer('senate', 110, 1, 1)).toBeDefined();
    expect(rollVotePointer('house', 110, 1, 1)).toBeUndefined();
  });

  it.each([
    ['session 0', 117, 0, 369],
    ['session 3', 117, 3, 369],
    ['vote number 0', 117, 1, 0],
    ['negative vote number', 117, 1, -1],
    ['fractional vote number', 117, 1, 1.5],
    ['NaN vote number', 117, 1, Number.NaN],
  ])('returns undefined for %s', (_label, congress, session, voteNumber) => {
    expect(rollVotePointer('house', congress, session, voteNumber)).toBeUndefined();
  });

  it('names the House floor in its coverage sentence', () => {
    expect(HOUSE_VOTE_COVERAGE).toBe(
      'Congress.gov publishes House roll call votes from the 115th Congress (2017) onward',
    );
  });
});

/**
 * `recordedVotes` entries as Congress.gov's bill actions carry them (2026-11-03):
 * title-case chamber, the vote's own congress and session, the roll number.
 */
describe('recordedRollVote', () => {
  /** /bill/117/hr/3684/actions — House passage (Roll no. 369). */
  const house369 = {
    chamber: 'House',
    congress: 117,
    date: '2021-11-06T03:27:28Z',
    rollNumber: 369,
    sessionNumber: 1,
    url: 'https://clerk.house.gov/evs/2021/roll369.xml',
  };
  /** /bill/117/hr/3684/actions — Senate passage (Record Vote Number: 314). */
  const senate314 = {
    chamber: 'Senate',
    congress: 117,
    date: '2021-08-10T15:51:57Z',
    rollNumber: 314,
    sessionNumber: 1,
    url: 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1171/vote_117_1_00314.xml',
  };
  /** /bill/116/hr/6395/actions — the veto override cast on 2021-01-01, still session 2. */
  const senate292 = {
    chamber: 'Senate',
    congress: 116,
    date: '2021-01-01T18:48:05Z',
    rollNumber: 292,
    sessionNumber: 2,
    url: 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1162/vote_116_2_00292.xml',
  };

  it('points a House entry at the House roll call, lowercasing the chamber', () => {
    expect(recordedRollVote([house369])).toEqual({
      chamber: 'house',
      congress: 117,
      session: 1,
      voteNumber: 369,
    });
  });

  it('points a Senate entry at the Senate roll call', () => {
    expect(recordedRollVote([senate314])).toEqual({
      chamber: 'senate',
      congress: 117,
      session: 1,
      voteNumber: 314,
    });
  });

  it("copies the entry's session rather than deriving one from its date", () => {
    expect(recordedRollVote([senate292])).toEqual({
      chamber: 'senate',
      congress: 116,
      session: 2,
      voteNumber: 292,
    });
    /** No date to derive from, and a date whose year would derive the other session. */
    const undated = { chamber: 'Senate', congress: 116, rollNumber: 292, sessionNumber: 2 };
    expect(recordedRollVote([undated])).toEqual({
      chamber: 'senate',
      congress: 116,
      session: 2,
      voteNumber: 292,
    });
    expect(
      recordedRollVote([{ ...senate314, date: '2022-01-03T18:00:00Z', sessionNumber: 1 }]),
    ).toEqual({ chamber: 'senate', congress: 117, session: 1, voteNumber: 314 });
  });

  it('gives a 114th Congress House entry none, and its Senate entry one', () => {
    /** /bill/114/hr/2029/actions — Roll no. 705 and Record Vote Number 339. */
    const house705 = { ...house369, congress: 114, rollNumber: 705, sessionNumber: 1 };
    const senate339 = { ...senate314, congress: 114, rollNumber: 339, sessionNumber: 1 };
    expect(recordedRollVote([house705])).toBeUndefined();
    expect(recordedRollVote([senate339])).toEqual({
      chamber: 'senate',
      congress: 114,
      session: 1,
      voteNumber: 339,
    });
  });

  it('gives 100th Congress entries none in either chamber', () => {
    /** /bill/100/hr/1/actions — no `url` on entries this old. */
    const house14 = { chamber: 'House', congress: 100, rollNumber: 14, sessionNumber: 1 };
    const senate19 = { chamber: 'Senate', congress: 100, rollNumber: 19, sessionNumber: 1 };
    expect(recordedRollVote([house14])).toBeUndefined();
    expect(recordedRollVote([senate19])).toBeUndefined();
  });

  it('gives none to an action recording several votes', () => {
    expect(recordedRollVote([house369, senate314])).toBeUndefined();
  });

  it.each([
    ['no recordedVotes', undefined],
    ['null', null],
    ['an empty array', []],
    ['a bare entry, not an array', house369],
    ['a non-object entry', ['369']],
    ['an unknown chamber', [{ ...house369, chamber: 'Joint' }]],
    ['a missing chamber', [{ ...house369, chamber: undefined }]],
    ['a string roll number', [{ ...house369, rollNumber: '369' }]],
    ['a string congress', [{ ...house369, congress: '117' }]],
    ['a missing session', [{ ...house369, sessionNumber: undefined }]],
  ])('gives none for %s', (_label, recordedVotes) => {
    expect(recordedRollVote(recordedVotes)).toBeUndefined();
  });
});

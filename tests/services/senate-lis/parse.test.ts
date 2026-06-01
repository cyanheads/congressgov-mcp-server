/**
 * @fileoverview Tests for the Senate LIS XML parsers.
 *
 * Fixtures under `fixtures/` are authentic slices of the real Senate feed (trimmed
 * member rosters, internally consistent tallies) so parsing is pinned against the
 * shapes the host actually emits — mixed-content questions, empty self-closing
 * elements, partial document blocks. Single-element / edge cases that the fixtures
 * can't cover are exercised with inline XML.
 *
 * @module tests/services/senate-lis/parse.test
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  computePartyTotals,
  parseRollCallVote,
  parseVoteMenu,
} from '@/services/senate-lis/parse.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const MENU = fixture('menu.xml');
const CLOTURE = fixture('vote-cloture.xml');
const AMENDMENT = fixture('vote-amendment.xml');

describe('parseVoteMenu', () => {
  const votes = parseVoteMenu(MENU);

  it('parses every vote row in feed order', () => {
    expect(votes.map((v) => v.voteNumber)).toEqual([339, 337, 336, 1]);
  });

  it('unpads the roll number and tags the chamber', () => {
    expect(votes[3]).toMatchObject({ chamber: 'senate', voteNumber: 1 });
  });

  it('normalizes a plain question (trailing whitespace stripped)', () => {
    expect(votes[0]).toMatchObject({
      voteNumber: 339,
      voteDate: '21-Dec',
      issue: 'H.R. 10545',
      question: 'On Passage of the Bill',
      result: 'Passed',
      yeas: 85,
      nays: 11,
    });
    expect(votes[0].measure).toBeUndefined();
  });

  it('extracts the nested <measure> from an amendment question (mixed content)', () => {
    expect(votes[2]).toMatchObject({
      voteNumber: 336,
      question: 'On the Amendment',
      measure: 'S.Amdt. 3331',
      result: 'Rejected',
      yeas: 34,
      nays: 62,
    });
  });

  it('carries the full title', () => {
    expect(votes[0].title).toContain('further continuing appropriations');
  });

  it('coerces a single <vote> into a one-element array', () => {
    const single = parseVoteMenu(
      `<?xml version="1.0"?><vote_summary><congress>119</congress><session>1</session><votes><vote><vote_number>00042</vote_number><question>On the Nomination</question><result>Confirmed</result><vote_tally><yeas>52</yeas><nays>48</nays></vote_tally></vote></votes></vote_summary>`,
    );
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({ voteNumber: 42, result: 'Confirmed', yeas: 52, nays: 48 });
  });

  it('returns an empty array for a session with no votes', () => {
    expect(
      parseVoteMenu(
        `<?xml version="1.0"?><vote_summary><congress>119</congress><votes/></vote_summary>`,
      ),
    ).toEqual([]);
  });

  it('throws when the root element is missing', () => {
    expect(() => parseVoteMenu('<not_a_vote_menu/>')).toThrow(/vote_summary/);
  });
});

describe('parseRollCallVote — cloture vote (populated document, no amendment)', () => {
  const { vote, members } = parseRollCallVote(CLOTURE);

  it('parses the core metadata and collapses whitespace in dates', () => {
    expect(vote).toMatchObject({
      chamber: 'senate',
      congress: 118,
      session: 2,
      voteNumber: 1,
      voteDate: 'January 8, 2024, 05:27 PM',
      modifyDate: 'January 30, 2024, 06:53 PM',
      question: 'On the Cloture Motion',
      voteQuestionText: 'On the Cloture Motion PN1020',
      voteResult: 'Cloture Motion Agreed to',
      voteResultText: 'Cloture Motion Agreed to (73-15)',
      majorityRequirement: '1/2',
    });
  });

  it('coerces the empty <present/> tally to 0', () => {
    expect(vote.count).toEqual({ yeas: 5, nays: 2, present: 0, absent: 1 });
  });

  it('surfaces the populated document block', () => {
    expect(vote.document).toEqual({
      congress: 118,
      type: 'PN',
      number: '1020',
      name: 'PN1020',
      title:
        'John A. Kazen, of Texas, to be United States District Judge for the Southern District of Texas',
    });
  });

  it('omits an amendment block that has no amendment number', () => {
    expect(vote.amendment).toBeUndefined();
  });

  it('parses every member with a chamber tag', () => {
    expect(members).toHaveLength(8);
    expect(members[0]).toEqual({
      chamber: 'senate',
      memberFull: 'Baldwin (D-WI)',
      firstName: 'Tammy',
      lastName: 'Baldwin',
      party: 'D',
      state: 'WI',
      voteCast: 'Yea',
      lisMemberId: 'S354',
    });
  });
});

describe('parseRollCallVote — amendment vote (populated amendment, partial document)', () => {
  const { vote } = parseRollCallVote(AMENDMENT);

  it('keeps the question clean (the menu carries the measure, not the vote record)', () => {
    expect(vote.question).toBe('On the Amendment');
    expect(vote.voteResultText).toBe('Amendment Rejected (34-62, 3/5 majority required)');
  });

  it('surfaces the populated amendment block', () => {
    expect(vote.amendment).toEqual({
      number: 'S.Amdt. 3331',
      toDocumentNumber: 'H.R. 82',
      toDocumentShortTitle: 'No short title on file',
      purpose: expect.stringContaining('delay the repeal'),
    });
  });

  it('keeps a partial document block (type present, identifiers empty)', () => {
    expect(vote.document).toEqual({ congress: 118, type: 'S.Amdt.' });
  });
});

describe('parseRollCallVote — edge cases', () => {
  it('coerces a single <member> into a one-element roster', () => {
    const { members } = parseRollCallVote(
      `<?xml version="1.0"?><roll_call_vote><congress>119</congress><session>1</session><vote_number>5</vote_number><count><yeas>1</yeas><nays>0</nays><present/><absent>0</absent></count><members><member><member_full>King (I-ME)</member_full><party>I</party><state>ME</state><vote_cast>Yea</vote_cast><lis_member_id>S363</lis_member_id></member></members></roll_call_vote>`,
    );
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ memberFull: 'King (I-ME)', voteCast: 'Yea' });
  });

  it('parses Present casts and a non-empty present tally', () => {
    const { vote, members } = parseRollCallVote(
      `<?xml version="1.0"?><roll_call_vote><congress>119</congress><session>1</session><vote_number>9</vote_number><count><yeas>1</yeas><nays>1</nays><present>1</present><absent>0</absent></count><members><member><last_name>A</last_name><party>D</party><vote_cast>Yea</vote_cast></member><member><last_name>B</last_name><party>R</party><vote_cast>Present</vote_cast></member><member><last_name>C</last_name><party>R</party><vote_cast>Nay</vote_cast></member></members></roll_call_vote>`,
    );
    expect(vote.count.present).toBe(1);
    expect(members.find((m) => m.voteCast === 'Present')?.lastName).toBe('B');
  });

  it('throws when the root element is missing', () => {
    expect(() => parseRollCallVote('<vote_summary/>')).toThrow(/roll_call_vote/);
  });
});

describe('computePartyTotals', () => {
  it('aggregates the cloture roster by party and cast, ordered by participation', () => {
    const { members } = parseRollCallVote(CLOTURE);
    expect(computePartyTotals(members)).toEqual([
      { party: 'D', yea: 3, nay: 0, present: 0, notVoting: 0 },
      { party: 'R', yea: 0, nay: 2, present: 0, notVoting: 1 },
      { party: 'I', yea: 2, nay: 0, present: 0, notVoting: 0 },
    ]);
  });

  it('reconciles with the official count block (yea/nay/not-voting sum)', () => {
    const { vote, members } = parseRollCallVote(CLOTURE);
    const totals = computePartyTotals(members);
    const sum = (key: 'yea' | 'nay' | 'notVoting') => totals.reduce((n, t) => n + t[key], 0);
    expect(sum('yea')).toBe(vote.count.yeas);
    expect(sum('nay')).toBe(vote.count.nays);
    expect(sum('notVoting')).toBe(vote.count.absent);
  });

  it('aggregates the amendment roster', () => {
    const { members } = parseRollCallVote(AMENDMENT);
    expect(computePartyTotals(members)).toEqual([
      { party: 'D', yea: 0, nay: 4, present: 0, notVoting: 0 },
      { party: 'R', yea: 2, nay: 0, present: 0, notVoting: 0 },
    ]);
  });

  it('returns an empty array for an empty roster', () => {
    expect(computePartyTotals([])).toEqual([]);
  });
});

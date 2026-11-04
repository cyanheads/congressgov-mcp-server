/**
 * @fileoverview Tests for the Voteview fallback's two halves: the parser, held
 * to captured files and to the LIS feed's record of the same votes, and
 * `VoteviewSource` — its cache window, byte bound, shared loads, cancellation,
 * broken bodies, rate limits, and not-found answers — run through its fetch
 * seam, so the retry ladder, status mapping, and parsing it wraps all run.
 * @module tests/services/senate-lis/voteview.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRollCallVote } from '@/services/senate-lis/parse.js';
import type { SenateMemberVote } from '@/services/senate-lis/types.js';
import {
  latestVoteviewRollCall,
  parseVoteviewCongress,
  type VoteviewCongress,
  type VoteviewFiles,
  voteviewRollCallVote,
  voteviewSessionVotes,
} from '@/services/senate-lis/voteview-parse.js';
import { VoteviewSource } from '@/services/senate-lis/voteview-source.js';
import {
  CALL_BUDGET_MS,
  retryAfterResponse,
  track,
  useFakeClock,
} from '../../helpers/budget-fixtures.js';
import {
  CAPTURED_SOURCE_119,
  type CapturedCongress,
  capturedCongress,
  capturedFile,
  cutOffResponse,
  heldUntilReleased,
  neverAnswers,
  type Responder,
  routeFetch,
  SENATE_FIREWALL_PAGE,
  stalledMidBody,
  textResponse,
  VOTEVIEW_HOST,
  voteviewFileUrls,
  voteviewServing,
} from './voteview-fixtures.js';

const lisFixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const parsed = (congress: CapturedCongress) =>
  parseVoteviewCongress(congress, capturedCongress(congress));

/** Each roll call as `[session, voteNumber]`. */
const pointers = (data: VoteviewCongress) => data.rollCalls.map((r) => [r.session, r.voteNumber]);

/** A roster as `bioguideId → voteCast`. */
const positions = (members: SenateMemberVote[]) =>
  new Map(members.map((member) => [member.bioguideId, member.voteCast]));

/** The votes file without the rows of the listed Voteview `rollnumber`s. */
function withoutRolls(votes: string, ...rollnumbers: number[]): string {
  return votes
    .split('\n')
    .filter((line) => !rollnumbers.some((roll) => line.startsWith(`119,Senate,${roll},`)))
    .join('\n');
}

describe('parseVoteviewCongress — captured files', () => {
  it("orders roll calls by session and vote number in the Senate's own numbering", () => {
    const data = parsed(119);
    expect(pointers(data)).toEqual([
      [1, 1],
      [1, 13],
      [2, 254],
      [2, 255],
      [2, 256],
    ]);
    expect(latestVoteviewRollCall(data)).toEqual({
      session: 2,
      voteNumber: 256,
      date: '2026-09-30',
      yeas: 47,
      nays: 41,
      question: 'On the Nomination',
      result: 'Nomination Confirmed',
      description: 'Keith Sonderling, of Florida, to be Secretary of Labor',
      billNumber: 'PN1129',
      majorityRequirement: '1/2',
    });
  });

  it('reads 119/2/256 with every position keyed by bioguide ID', () => {
    const found = voteviewRollCallVote(parsed(119), 2, 256);
    expect(found?.vote).toEqual({
      chamber: 'senate',
      congress: 119,
      session: 2,
      voteNumber: 256,
      count: { yeas: 47, nays: 41, present: 0, absent: 12 },
      voteDateIso: '2026-09-30',
      question: 'On the Nomination',
      voteResult: 'Nomination Confirmed',
      voteDocumentText: 'Keith Sonderling, of Florida, to be Secretary of Labor',
      majorityRequirement: '1/2',
      issue: 'PN1129',
    });
    const members = found?.members ?? [];
    expect(members).toHaveLength(100);
    expect(members.every((m) => /^[A-Z]\d{6}$/.test(m.bioguideId ?? ''))).toBe(true);
    expect(members[0]).toEqual({
      chamber: 'senate',
      name: 'ALSOBROOKS, Angela Deneece',
      party: 'D',
      state: 'MD',
      voteCast: 'Nay',
      bioguideId: 'A000382',
    });
    const cast = positions(members);
    expect(cast.get('A000383')).toBe('Yea');
    expect(cast.get('S000033')).toBe('Nay');
    expect(cast.get('M000355')).toBe('Not Voting');
    /** Rubio left the Senate before this vote; he is in the members file but not the roster. */
    expect(cast.has('R000595')).toBe(false);
  });

  it("drops the President's position, leaving the roster on the published tally", () => {
    const votes = capturedFile('S119_votes.csv');
    /** The file records 75 yeas on roll 13: 74 senators and the President (ICPSR 99912). */
    const yeaRows = votes.split('\n').filter((line) => /^119,Senate,13,\d+,1,/.test(line));
    expect(yeaRows).toHaveLength(75);
    expect(yeaRows.some((line) => line.startsWith('119,Senate,13,99912,'))).toBe(true);

    const found = voteviewRollCallVote(parsed(119), 1, 13);
    const members = found?.members ?? [];
    expect(found?.vote.count).toEqual({ yeas: 74, nays: 25, present: 0, absent: 1 });
    expect(members).toHaveLength(100);
    expect(members.filter((m) => m.voteCast === 'Yea')).toHaveLength(74);
    expect(members.some((m) => m.name?.startsWith('TRUMP'))).toBe(false);
    expect(positions(members).get('F000479')).toBe('Not Voting');
  });

  it('orders each roster by name', () => {
    const members = voteviewRollCallVote(parsed(119), 1, 1)?.members ?? [];
    const names = members.map((m) => m.name ?? '');
    expect(names).toEqual([...names].sort());
    expect(names.slice(0, 2)).toEqual(['ALSOBROOKS, Angela Deneece', 'BALDWIN, Tammy']);
  });

  it("reads the 101st's whole numbers written as 2.0 and 175.0, and every position it records", () => {
    const data = parsed(101);
    expect(pointers(data)).toEqual([
      [2, 175],
      [2, 317],
    ]);

    /** Paired (2, 3), announced (4, 5): not votes. The President's row (code 9) is dropped. */
    const conference = voteviewRollCallVote(data, 2, 317);
    expect(conference?.vote.count).toEqual({ yeas: 60, nays: 36, present: 0, absent: 4 });
    expect(conference?.members).toHaveLength(100);
    const onConference = positions(conference?.members ?? []);
    for (const bioguideId of ['B000647', 'H000343', 'B000639', 'M000346']) {
      expect(onConference.get(bioguideId), bioguideId).toBe('Not Voting');
    }

    /** Present (8), paired (3), absent (9). */
    const resolution = voteviewRollCallVote(data, 2, 175);
    expect(resolution?.vote.count).toEqual({ yeas: 96, nays: 0, present: 2, absent: 2 });
    const onResolution = positions(resolution?.members ?? []);
    expect(onResolution.get('B000647')).toBe('Present');
    expect(onResolution.get('D000566')).toBe('Present');
    expect(onResolution.get('P000513')).toBe('Not Voting');
    expect(onResolution.get('W000092')).toBe('Not Voting');
  });

  it("maps Voteview's party codes 100, 200, and 328", () => {
    const members = voteviewRollCallVote(parsed(119), 2, 256)?.members ?? [];
    const party = new Map(members.map((m) => [m.bioguideId, m.party]));
    expect(party.get('A000382')).toBe('D');
    expect(party.get('A000383')).toBe('R');
    expect(party.get('S000033')).toBe('I');
    expect(party.get('K000383')).toBe('I');
  });

  it('lists a session as rows, ascending by vote number', () => {
    const data = parsed(119);
    const rows = voteviewSessionVotes(data, 2);
    expect(rows.map((row) => row.voteNumber)).toEqual([254, 255, 256]);
    expect(rows[0]).toEqual({
      chamber: 'senate',
      voteNumber: 254,
      yeas: 57,
      nays: 43,
      voteDateIso: '2026-09-30',
      issue: 'HR9340',
      question: 'On Cloture on the Motion to Proceed',
      result: 'Cloture on the Motion to Proceed Rejected',
      title: expect.stringMatching(/^A bill to amend the Public Utility Regulatory Policies Act/),
    });
    expect(voteviewSessionVotes(data, 3)).toEqual([]);
  });

  it('trims trailing roll calls whose roster Voteview has not published yet', () => {
    const files = capturedCongress(119);
    const data = parseVoteviewCongress(119, { ...files, votes: withoutRolls(files.votes, 915) });
    expect(pointers(data).at(-1)).toEqual([2, 255]);
    /** Four roll calls by the 104 senators of the members file. */
    expect(data.casts.byteLength).toBe(4 * 104);
    expect(voteviewRollCallVote(data, 2, 256)).toBeUndefined();

    const twoBehind = parseVoteviewCongress(119, {
      ...files,
      votes: withoutRolls(files.votes, 914, 915),
    });
    expect(latestVoteviewRollCall(twoBehind)).toMatchObject({ session: 2, voteNumber: 254 });
  });

  /**
   * The LIS fixtures keep a handful of each roster's senators; every one of them
   * must carry the same party and position in Voteview's record of the vote.
   */
  it.each([
    ['vote-cloture.xml', 1],
    ['vote-amendment.xml', 336],
  ])("agrees with the LIS feed's %s (118th Congress, session 2, vote %i)", (file, voteNumber) => {
    const lis = parseRollCallVote(lisFixture(file));
    const found = voteviewRollCallVote(parsed(118), 2, voteNumber);
    expect(found?.vote).toMatchObject({
      question: lis.vote.question,
      voteResult: lis.vote.voteResult,
      majorityRequirement: lis.vote.majorityRequirement,
    });
    expect(lis.members.length).toBeGreaterThanOrEqual(6);
    for (const member of lis.members) {
      const surname = member.lastName?.toUpperCase();
      const matches = (found?.members ?? []).filter(
        (m) => m.state === member.state && m.name?.split(',')[0] === surname,
      );
      expect(matches, member.memberFull).toHaveLength(1);
      expect(matches[0], member.memberFull).toMatchObject({
        party: member.party,
        voteCast: member.voteCast,
      });
    }
  });
});

describe('parseVoteviewCongress — file shapes', () => {
  const MEMBERS_HEADER = 'congress,chamber,icpsr,state_abbrev,party_code,bioname,bioguide_id';
  const ROLLCALLS_HEADER =
    'congress,chamber,rollnumber,date,session,clerk_rollnumber,majority_requirement,yea_count,nay_count,bill_number,vote_result,vote_desc,vote_question';
  const VOTES_HEADER = 'congress,chamber,rollnumber,icpsr,cast_code';
  const ROLL = '120,Senate,1,2027-01-06,1,1,1/2,1,1,S1,Passed,A bill,On Passage';

  /** One roll call; senator `i` casts code `i` and carries `parties[i]`. */
  function oneRollCall(parties: readonly string[]): VoteviewFiles {
    const members = parties.map(
      (party, i) => `120,Senate,${i + 1},ST,${party},SENATOR ${i},X00000${i}`,
    );
    const votes = parties.map((_party, i) => `120,Senate,1,${i + 1},${i}`);
    return {
      members: [MEMBERS_HEADER, '120,President,99999,USA,200,PRESIDENT,', ...members].join('\n'),
      rollcalls: [ROLLCALLS_HEADER, ROLL, '120,House,2,2027-01-06,1,1,1/2,1,1,,,,'].join('\n'),
      votes: [VOTES_HEADER, ...votes, '120,Senate,1,99999,1'].join('\n'),
    };
  }

  it('labels each cast code as the Senate does, and leaves out code 0', () => {
    const parties = ['100', '100', '200', '328', '100', '200', '100', '200', '100', '200'];
    const found = voteviewRollCallVote(parseVoteviewCongress(120, oneRollCall(parties)), 1, 1);
    expect(found?.members.map((m) => [m.name, m.voteCast])).toEqual([
      ['SENATOR 1', 'Yea'],
      ['SENATOR 2', 'Not Voting'],
      ['SENATOR 3', 'Not Voting'],
      ['SENATOR 4', 'Not Voting'],
      ['SENATOR 5', 'Not Voting'],
      ['SENATOR 6', 'Nay'],
      ['SENATOR 7', 'Present'],
      ['SENATOR 8', 'Present'],
      ['SENATOR 9', 'Not Voting'],
    ]);
    expect(found?.vote.count).toEqual({ yeas: 1, nays: 1, present: 2, absent: 5 });
  });

  it('leaves party unset for a code outside 100, 200, and 328', () => {
    const parties = ['100', '200', '328', '329', '', '100.0'];
    const found = voteviewRollCallVote(parseVoteviewCongress(120, oneRollCall(parties)), 1, 1);
    expect(found?.members.map((m) => [m.name, m.party])).toEqual([
      ['SENATOR 1', 'R'],
      ['SENATOR 2', 'I'],
      ['SENATOR 3', undefined],
      ['SENATOR 4', undefined],
      ['SENATOR 5', 'D'],
    ]);
  });

  it('reads a congress with no roll calls yet as empty', () => {
    const data = parseVoteviewCongress(120, {
      members: MEMBERS_HEADER,
      rollcalls: ROLLCALLS_HEADER,
      votes: VOTES_HEADER,
    });
    expect(data.rollCalls).toEqual([]);
    expect(latestVoteviewRollCall(data)).toBeUndefined();
  });

  it.each([
    ['a file with no header', { members: '' }, "Voteview's members file is empty."],
    [
      'a header missing a column it reads',
      { votes: 'congress,chamber,rollnumber,icpsr,vote' },
      "Voteview's votes file has no cast_code column.",
    ],
    [
      'a Senate number that is not whole',
      {
        rollcalls: [ROLLCALLS_HEADER, '120,Senate,1,2027-01-06,1.5,1,1/2,1,1,S1,P,D,Q'].join('\n'),
      },
      `Voteview's rollcalls file has a Senate row whose session is not a whole number ("1.5").`,
    ],
    [
      'a cast code past 9',
      { votes: [VOTES_HEADER, '120,Senate,1,1,10'].join('\n') },
      "Voteview's votes file has an unknown cast_code 10.",
    ],
  ])('rejects %s', (_label, override, message) => {
    const files = { ...oneRollCall(['100']), ...override };
    expect(() => parseVoteviewCongress(120, files)).toThrow(message);
  });
});

describe('VoteviewSource', () => {
  const UNAVAILABLE_HINT =
    "Retry after a short delay; House votes (chamber 'house') are unaffected.";
  const LIST_HINT =
    "Use operation 'list' with chamber 'senate' to see the Senate votes Voteview has for the congress and session, then retry.";

  function serve(voteview: Responder) {
    const router = routeFetch({ [VOTEVIEW_HOST]: voteview });
    vi.stubGlobal('fetch', router.fetch);
    return router;
  }
  const requested = (router: { requests: URL[] }) => router.requests.map(String).sort();
  /** Run pending macrotasks, so every request a call makes has been sent. */
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('answers from the three files, naming Voteview, its latest vote, and its citation', async () => {
    const router = serve(voteviewServing());
    const source = new VoteviewSource();
    const result = await source.sessionVotes(119, 2, createMockContext(), undefined);
    expect(result.votes.map((v) => v.voteNumber)).toEqual([254, 255, 256]);
    expect(result.source).toEqual(CAPTURED_SOURCE_119);
    expect(requested(router)).toEqual(voteviewFileUrls(119).sort());

    const vote = await source.rollCallVote(
      { congress: 119, session: 2, voteNumber: 256 },
      createMockContext(),
      undefined,
    );
    expect(vote.vote.count).toEqual({ yeas: 47, nays: 41, present: 0, absent: 12 });
    expect(vote.members).toHaveLength(100);
    expect(vote.source).toEqual(CAPTURED_SOURCE_119);
  });

  it('requests the three files at once', async () => {
    const held = heldUntilReleased(voteviewServing());
    const router = serve(held.responder);
    const call = new VoteviewSource().sessionVotes(119, 2, createMockContext(), undefined);
    await flush();
    expect(requested(router)).toEqual(voteviewFileUrls(119).sort());
    held.release();
    await expect(call).resolves.toMatchObject({ source: CAPTURED_SOURCE_119 });
  });

  it('fetches each file once per cache window, then again once the hour is up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const router = serve(voteviewServing());
    const source = new VoteviewSource();
    await source.sessionVotes(119, 2, createMockContext(), undefined);
    await source.sessionVotes(119, 1, createMockContext(), undefined);
    await source.rollCallVote(
      { congress: 119, session: 2, voteNumber: 255 },
      createMockContext(),
      undefined,
    );
    expect(router.requests).toHaveLength(3);

    vi.setSystemTime(start + 60 * 60 * 1000 - 1);
    await source.sessionVotes(119, 2, createMockContext(), undefined);
    expect(router.requests).toHaveLength(3);

    vi.setSystemTime(start + 60 * 60 * 1000);
    await source.sessionVotes(119, 2, createMockContext(), undefined);
    expect(router.requests).toHaveLength(6);
    expect(requested(router)).toEqual([...voteviewFileUrls(119), ...voteviewFileUrls(119)].sort());
  });

  it('evicts the least recently used congress once its byte bound is passed', async () => {
    const size = (congress: CapturedCongress) => parsed(congress).retainedBytes;
    /** Room for the 118th and 119th; the 101st takes no more than the 119th it displaces. */
    expect(size(101)).toBeLessThanOrEqual(size(119));
    const router = serve(voteviewServing());
    const source = new VoteviewSource(size(118) + size(119));
    const read = (congress: CapturedCongress) =>
      source.sessionVotes(congress, 2, createMockContext(), undefined);
    const filesOf = (congress: number) =>
      router.requests.filter((url) => url.pathname.endsWith(`/S${congress}_votes.csv`)).length;

    await read(118);
    await read(119);
    /** A hit makes the 118th the most recently used. */
    await read(118);
    await read(101);
    expect([filesOf(118), filesOf(119), filesOf(101)]).toEqual([1, 1, 1]);

    await read(118);
    expect(filesOf(118)).toBe(1);
    await read(119);
    expect(filesOf(119)).toBe(2);
  });

  it('never caches a congress larger than its byte bound', async () => {
    const router = serve(voteviewServing());
    const source = new VoteviewSource(parsed(119).retainedBytes - 1);
    await source.sessionVotes(119, 2, createMockContext(), undefined);
    await source.sessionVotes(119, 2, createMockContext(), undefined);
    expect(router.requests).toHaveLength(6);
  });

  it('shares one load among concurrent calls', async () => {
    const held = heldUntilReleased(voteviewServing());
    const router = serve(held.responder);
    const source = new VoteviewSource();
    const list = source.sessionVotes(119, 2, createMockContext(), undefined);
    const get = source.rollCallVote(
      { congress: 119, session: 1, voteNumber: 13 },
      createMockContext(),
      undefined,
    );
    await flush();
    held.release();
    await expect(list).resolves.toMatchObject({ source: CAPTURED_SOURCE_119 });
    await expect(get).resolves.toMatchObject({ vote: { voteNumber: 13 } });
    expect(router.requests).toHaveLength(3);
  });

  it("lets one caller's cancellation leave the other's wait untouched", async () => {
    const held = heldUntilReleased(voteviewServing());
    const router = serve(held.responder);
    const source = new VoteviewSource();
    const leaving = new AbortController();
    const staying = new AbortController();
    const gone = source
      .sessionVotes(119, 2, createMockContext(), leaving.signal)
      .catch((error: unknown) => error);
    const kept = source.sessionVotes(119, 2, createMockContext(), staying.signal);
    await flush();

    leaving.abort();
    const error = (await gone) as McpError;
    expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(error.message).toBe("The wait for Voteview's Senate vote files was cancelled.");
    expect(held.signals.some((signal) => signal.aborted)).toBe(false);

    held.release();
    await expect(kept).resolves.toMatchObject({ source: CAPTURED_SOURCE_119 });
    expect(router.requests).toHaveLength(3);
  });

  it('aborts the load once every caller has left, and caches nothing from it', async () => {
    const held = heldUntilReleased(voteviewServing());
    const router = serve(held.responder);
    const source = new VoteviewSource();
    const first = new AbortController();
    const second = new AbortController();
    const calls = [first, second].map((controller) =>
      source.sessionVotes(119, 2, createMockContext(), controller.signal).catch((e: unknown) => e),
    );
    await flush();
    first.abort();
    await flush();
    expect(held.signals.some((signal) => signal.aborted)).toBe(false);
    second.abort();
    for (const outcome of await Promise.all(calls)) {
      expect(outcome).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    }
    expect(held.signals).toHaveLength(3);
    expect(held.signals.every((signal) => signal.aborted)).toBe(true);

    held.release();
    await expect(
      source.sessionVotes(119, 2, createMockContext(), undefined),
    ).resolves.toMatchObject({ source: CAPTURED_SOURCE_119 });
    expect(router.requests).toHaveLength(6);
  });

  it('caches no failure: the next call fetches again', async () => {
    useFakeClock();
    let votesFailures = 2;
    const serving = voteviewServing();
    const router = serve(async (url, init) => {
      if (url.pathname.endsWith('/S119_votes.csv') && votesFailures-- > 0) {
        return textResponse('Service Unavailable', 503);
      }
      return serving(url, init);
    });
    const source = new VoteviewSource();
    const failing = source
      .sessionVotes(119, 2, createMockContext(), undefined)
      .catch((error: unknown) => error as McpError);
    await vi.runAllTimersAsync();
    expect(await failing).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_error', recovery: { hint: UNAVAILABLE_HINT } },
    });

    await expect(
      source.sessionVotes(119, 2, createMockContext(), undefined),
    ).resolves.toMatchObject({ source: CAPTURED_SOURCE_119 });
    const votesRequests = router.requests.filter((url) => url.pathname.endsWith('_votes.csv'));
    /** Two attempts for the failed load, one for the next. */
    expect(votesRequests).toHaveLength(3);
  });

  it('answers a congress Voteview has no files for as not found, without retrying', async () => {
    const router = serve(voteviewServing());
    const error = (await new VoteviewSource()
      .sessionVotes(120, 1, createMockContext(), undefined)
      .catch((e: unknown) => e)) as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe(
      "Voteview has no Senate roll call votes for the 120th Congress, and the Senate LIS feed can't be read.",
    );
    expect(error.data).toMatchObject({
      congress: 120,
      reason: 'not_found',
      recovery: {
        hint: 'Check the congress number. Voteview adds a congress once the Senate has voted in it; retry later for a congress that has just begun.',
      },
    });
    expect(requested(router)).toEqual(voteviewFileUrls(120).sort());
  });

  it('reports files in another format as a non-retryable upstream error', async () => {
    const router = serve(voteviewServing({ 'S119_rollcalls.csv': SENATE_FIREWALL_PAGE }));
    const error = (await new VoteviewSource()
      .sessionVotes(119, 2, createMockContext(), undefined)
      .catch((e: unknown) => e)) as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toBe(
      "Voteview's Senate vote files for the 119th Congress are not in the format this server reads.",
    );
    expect(error.data).toMatchObject({
      reason: 'upstream_error',
      retryable: false,
      recovery: { hint: UNAVAILABLE_HINT },
    });
    expect(router.requests).toHaveLength(3);
  });

  it('cancels the requests for the other files when one fails', async () => {
    const held = heldUntilReleased(voteviewServing());
    serve(async (url, init) =>
      url.pathname.endsWith('/S119_votes.csv')
        ? textResponse('Not Found', 404)
        : held.responder(url, init),
    );
    await expect(
      new VoteviewSource().sessionVotes(119, 2, createMockContext(), undefined),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
    expect(held.signals).toHaveLength(2);
    expect(held.signals.every((signal) => signal.aborted)).toBe(true);
  });

  describe('a file whose body breaks off', () => {
    const VOTES_FILE = '/S119_votes.csv';
    /** Voteview as captured, except that the votes file's first `cuts` responses break off halfway. */
    function cutting(cuts: number): Responder {
      const serving = voteviewServing();
      return async (url, init) =>
        url.pathname.endsWith(VOTES_FILE) && cuts-- > 0
          ? cutOffResponse(capturedFile('S119_votes.csv'))
          : serving(url, init);
    }
    const votesRequests = (router: { requests: URL[] }) =>
      router.requests.filter((url) => url.pathname.endsWith(VOTES_FILE)).length;
    /** The error at the end of `error`'s cause chain. */
    function rootCause(error: unknown): unknown {
      let current = error;
      while (current instanceof Error && current.cause !== undefined) current = current.cause;
      return current;
    }

    it('retries it, then fails as Voteview being unavailable, the broken read as its cause', async () => {
      useFakeClock();
      const router = serve(cutting(2));
      const failing = new VoteviewSource()
        .sessionVotes(119, 2, createMockContext(), undefined)
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await failing;

      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'Voteview is temporarily unavailable. (failed after 2 attempts)',
        data: { reason: 'upstream_error', recovery: { hint: UNAVAILABLE_HINT } },
      });
      expect((error as McpError).data?.retryable).toBeUndefined();
      const cause = rootCause(error);
      expect(cause).toBeInstanceOf(TypeError);
      expect((cause as TypeError).message).toBe('terminated');
      expect(votesRequests(router)).toBe(2);
    });

    it('answers from the retry when only the first read breaks off', async () => {
      useFakeClock();
      const router = serve(cutting(1));
      const call = new VoteviewSource().sessionVotes(119, 2, createMockContext(), undefined);
      await vi.runAllTimersAsync();
      await expect(call).resolves.toMatchObject({ source: CAPTURED_SOURCE_119 });
      expect(votesRequests(router)).toBe(2);
      expect(router.requests).toHaveLength(4);
    });

    it("keeps a caller's cancellation during the read as cancelled, without a retry", async () => {
      const stalled = stalledMidBody(capturedFile('S119_votes.csv'));
      const serving = voteviewServing();
      const router = serve((url, init) =>
        url.pathname.endsWith(VOTES_FILE) ? stalled.responder(url, init) : serving(url, init),
      );
      const caller = new AbortController();
      const call = new VoteviewSource()
        .sessionVotes(119, 2, createMockContext(), caller.signal)
        .catch((error: unknown) => error);
      await flush();
      expect(stalled.state.stalls, 'the votes file is mid-body when the caller leaves').toBe(1);

      caller.abort();
      expect(await call).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      await flush();
      expect(stalled.state.signals).toHaveLength(1);
      expect(stalled.state.signals[0]?.aborted).toBe(true);
      expect(votesRequests(router)).toBe(1);
    });
  });

  describe('a rate limit from Voteview', () => {
    const RATE_LIMITED_HINT =
      "Follow Retry-After when supplied, otherwise wait before retrying; House votes (chamber 'house') are unaffected.";
    const RATE_LIMITED_PREFIX =
      "Voteview, which serves Senate votes while the Senate LIS feed can't be read, is rate-limiting this server";

    it.each([
      [
        'naming its Retry-After',
        async () => retryAfterResponse(429, 30),
        `${RATE_LIMITED_PREFIX} (HTTP 429, Retry-After 30).`,
        { retryAfter: '30' },
      ],
      [
        'with no Retry-After to name',
        async () => textResponse('Too Many Requests', 429),
        `${RATE_LIMITED_PREFIX} (HTTP 429).`,
        {},
      ],
    ] as const)(
      'fails at once as rate-limited, %s',
      async (_label, respond, message, retryAfter) => {
        useFakeClock();
        const router = serve(respond);
        const start = Date.now();
        const call = track(
          new VoteviewSource().sessionVotes(119, 2, createMockContext(), undefined),
        );
        await vi.runAllTimersAsync();

        const error = call.state.error as McpError;
        expect(error).toBeInstanceOf(McpError);
        expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(error.message).toBe(message);
        expect(error.data).toEqual({
          reason: 'rate_limited',
          ...retryAfter,
          recovery: { hint: RATE_LIMITED_HINT },
        });
        /** One request per file and no backoff: a 429 is never retried. */
        expect(requested(router)).toEqual(voteviewFileUrls(119).sort());
        expect(call.state.settledAt).toBe(start);
      },
    );
  });

  describe("not found within Voteview's coverage", () => {
    const LATEST_119 =
      'Its latest Senate vote for the 119th Congress is session 2 vote 256 (2026-09-30); it adds votes after the Senate takes them.';

    /** Whether a congress has ended is read from the clock: hold it at the capture date. */
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
    });

    async function notFound(call: (source: VoteviewSource) => Promise<unknown>) {
      return (await call(new VoteviewSource()).catch((e: unknown) => e)) as McpError;
    }

    it("names Voteview's latest vote for a vote after it", async () => {
      serve(voteviewServing());
      const error = await notFound((source) =>
        source.rollCallVote(
          { congress: 119, session: 2, voteNumber: 257 },
          createMockContext(),
          undefined,
        ),
      );
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.message).toBe(
        `Senate roll call vote 257 of the 119th Congress, session 2 is not in Voteview, which serves Senate votes while the Senate LIS feed can't be read. ${LATEST_119}`,
      );
      expect(error.data).toMatchObject({
        congress: 119,
        session: 2,
        voteNumber: 257,
        latestVote: { session: 2, voteNumber: 256, date: '2026-09-30' },
        reason: 'not_found',
        recovery: { hint: LIST_HINT },
      });
    });

    it("names where the session ends for a vote past an earlier session's last", async () => {
      serve(voteviewServing());
      const error = await notFound((source) =>
        source.rollCallVote(
          { congress: 119, session: 1, voteNumber: 14 },
          createMockContext(),
          undefined,
        ),
      );
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.message).toBe(
        "Senate roll call vote 14 of the 119th Congress, session 1 was not found; in Voteview, which serves Senate votes while the Senate LIS feed can't be read, session 1 runs through vote 13.",
      );
      expect(error.data).toMatchObject({ latestVote: { session: 2, voteNumber: 256 } });
    });

    it("names Voteview's latest vote for a session it has no votes in", async () => {
      serve(voteviewServing());
      const error = await notFound((source) =>
        source.sessionVotes(119, 3, createMockContext(), undefined),
      );
      expect(error.message).toBe(
        `No Senate roll call votes for the 119th Congress, session 3 are in Voteview, which serves Senate votes while the Senate LIS feed can't be read. ${LATEST_119}`,
      );
      expect(error.data).toMatchObject({ congress: 119, session: 3, reason: 'not_found' });
    });

    it('says Voteview has no vote yet for a congress whose files hold none', async () => {
      const header = (kind: 'rollcalls' | 'votes' | 'members') =>
        capturedFile(`S119_${kind}.csv`).split('\n')[0] as string;
      serve(
        voteviewServing({
          'S120_rollcalls.csv': header('rollcalls'),
          'S120_votes.csv': header('votes'),
          'S120_members.csv': header('members'),
        }),
      );
      const clause =
        'Voteview has no Senate vote for the 120th Congress yet; it adds votes after the Senate takes them.';
      const list = await notFound((source) =>
        source.sessionVotes(120, 1, createMockContext(), undefined),
      );
      expect(list.message).toBe(
        `No Senate roll call votes for the 120th Congress, session 1 are in Voteview, which serves Senate votes while the Senate LIS feed can't be read. ${clause}`,
      );
      expect(list.data).not.toHaveProperty('latestVote');
      const get = await notFound((source) =>
        source.rollCallVote(
          { congress: 120, session: 1, voteNumber: 1 },
          createMockContext(),
          undefined,
        ),
      );
      expect(get.message).toBe(
        `Senate roll call vote 1 of the 120th Congress, session 1 is not in Voteview, which serves Senate votes while the Senate LIS feed can't be read. ${clause}`,
      );
    });

    it('names the last vote of a congress that has ended without saying more will come', async () => {
      serve(voteviewServing());
      const clause =
        'Its latest Senate vote for the 118th Congress is session 2 vote 336 (2024-12-20).';
      const get = await notFound((source) =>
        source.rollCallVote(
          { congress: 118, session: 2, voteNumber: 337 },
          createMockContext(),
          undefined,
        ),
      );
      expect(get.message).toBe(
        `Senate roll call vote 337 of the 118th Congress, session 2 is not in Voteview, which serves Senate votes while the Senate LIS feed can't be read. ${clause}`,
      );
      const list = await notFound((source) =>
        source.sessionVotes(118, 1, createMockContext(), undefined),
      );
      expect(list.message).toBe(
        `No Senate roll call votes for the 118th Congress, session 1 are in Voteview, which serves Senate votes while the Senate LIS feed can't be read. ${clause}`,
      );
    });

    it('treats the 119th Congress as ended once the 120th has begun', async () => {
      vi.setSystemTime(new Date('2027-02-01T12:00:00Z'));
      serve(voteviewServing());
      const error = await notFound((source) =>
        source.rollCallVote(
          { congress: 119, session: 2, voteNumber: 257 },
          createMockContext(),
          undefined,
        ),
      );
      expect(error.message).toBe(
        "Senate roll call vote 257 of the 119th Congress, session 2 is not in Voteview, which serves Senate votes while the Senate LIS feed can't be read. Its latest Senate vote for the 119th Congress is session 2 vote 256 (2026-09-30).",
      );
    });
  });

  describe('time', () => {
    it('gives each file two 20-second attempts when no call budget stands behind it', async () => {
      useFakeClock();
      const router = serve(neverAnswers);
      const start = Date.now();
      const call = track(new VoteviewSource().sessionVotes(119, 2, undefined, undefined));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(call.state.error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_error', recovery: { hint: UNAVAILABLE_HINT } },
      });
      expect((call.state.error as McpError).message).toBe(
        'Voteview is temporarily unavailable. (failed after 2 attempts)',
      );
      /** 2 × 20 s plus one 1 s backoff, ±25% jitter; the first file to fail ends the load. */
      const elapsed = (call.state.settledAt as number) - start;
      expect(elapsed).toBeGreaterThanOrEqual(40_750);
      expect(elapsed).toBeLessThanOrEqual(41_250);
      expect(requested(router)).toEqual(
        [...voteviewFileUrls(119), ...voteviewFileUrls(119)].sort(),
      );
    });

    it("reports Voteview's own timeouts inside the call budget as Voteview's failure, not the budget's", async () => {
      useFakeClock();
      serve(neverAnswers);
      const ctx = createMockContext();
      const start = Date.now();
      /** The LIS feed's refusal took half a second of this call. */
      await vi.advanceTimersByTimeAsync(500);
      const call = track(new VoteviewSource().sessionVotes(119, 2, ctx, undefined));
      await vi.advanceTimersByTimeAsync(CALL_BUDGET_MS);

      const elapsed = (call.state.settledAt as number) - start;
      expect(elapsed).toBeLessThan(CALL_BUDGET_MS);
      expect(call.state.error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_error' },
      });
      expect((call.state.error as McpError).message).toBe(
        'Voteview is temporarily unavailable. (failed after 2 attempts)',
      );
    });

    it("ends a caller's wait at its call budget, and the last caller leaving aborts the load", async () => {
      useFakeClock();
      const held = heldUntilReleased(voteviewServing());
      serve(held.responder);
      const ctx = createMockContext();
      const start = Date.now();
      /** Earlier requests in the same call spent 45 s. */
      await vi.advanceTimersByTimeAsync(45_000);
      const call = track(new VoteviewSource().sessionVotes(119, 2, ctx, undefined));
      await vi.advanceTimersByTimeAsync(10_000);

      expect(call.state.settledAt).toBe(start + CALL_BUDGET_MS);
      expect(call.state.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: {
          reason: 'upstream_timeout',
          budgetMs: CALL_BUDGET_MS,
          retryAttempts: 1,
          recovery: { hint: UNAVAILABLE_HINT },
        },
      });
      expect((call.state.error as McpError).message).toBe(
        "Voteview did not deliver the Senate vote files for the 119th Congress within this call's 50-second budget for upstream requests (1 attempt).",
      );
      expect(held.signals).toHaveLength(3);
      expect(held.signals.every((signal) => signal.aborted)).toBe(true);
    });
  });
});

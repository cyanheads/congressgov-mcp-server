/**
 * @fileoverview Tests for congressgov_roll_votes tool.
 * @module tests/mcp-server/tools/definitions/roll-votes.tool.test
 */

import { existsSync, readFileSync } from 'node:fs';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_TIMEOUT_MS,
  expectBudgetTimeout,
  jsonResponse,
  scriptedCongressApi,
  track,
  useFakeClock,
} from '../../../helpers/budget-fixtures.js';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

vi.mock('@/services/senate-lis/senate-vote-service.js', () => ({
  getSenateVoteService: vi.fn(),
  initSenateVoteService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    apiKey: 'test-api-key',
    baseUrl: 'https://api.congress.gov/v3',
  }),
}));

import { rollVotesTool } from '@/mcp-server/tools/definitions/roll-votes.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import { getSenateVoteService } from '@/services/senate-lis/senate-vote-service.js';

/**
 * The real clients, for the cases where a whole request path is under test: the call
 * budget across chained requests, and member filters applied to the roster each
 * service fetches and normalizes.
 */
const { CongressApiService } = await vi.importActual<
  typeof import('@/services/congress-api/congress-api-service.js')
>('@/services/congress-api/congress-api-service.js');
const { SenateVoteService } = await vi.importActual<
  typeof import('@/services/senate-lis/senate-vote-service.js')
>('@/services/senate-lis/senate-vote-service.js');

describe('rollVotesTool', () => {
  const mockApi = {
    listVotes: vi.fn(),
    getVote: vi.fn(),
    getVoteMembers: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('lists votes by congress and session', async () => {
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    mockApi.listVotes.mockResolvedValue({
      data: [{ voteNumber: 1 }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = rollVotesTool.input.parse({
      operation: 'list',
      congress: 118,
      session: 1,
    });
    const result = await rollVotesTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
  });

  it('gets a specific vote', async () => {
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    mockApi.getVote.mockResolvedValue({ vote: { question: 'On Passage' } });
    const input = rollVotesTool.input.parse({
      operation: 'get',
      congress: 118,
      session: 1,
      voteNumber: 42,
    });
    const result = await rollVotesTool.handler(input, ctx);
    expect(result.vote).toEqual({ question: 'On Passage' });
  });

  it('returns member positions as a roster in data[] with the vote as a sibling (issue #36)', async () => {
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    mockApi.getVoteMembers.mockResolvedValue({
      data: [{ bioguideId: 'S000148', lastName: 'Smith', voteCast: 'Yea' }],
      vote: { rollCallNumber: 42, voteQuestion: 'On Passage', result: 'Passed' },
      pagination: { count: 1, nextOffset: null },
    });
    const input = rollVotesTool.input.parse({
      operation: 'members',
      congress: 118,
      session: 1,
      voteNumber: 42,
    });
    const result = await rollVotesTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
    expect((result.vote as { results?: unknown }).results).toBeUndefined();
  });

  it('throws when get/members is missing voteNumber', async () => {
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    const input = rollVotesTool.input.parse({
      operation: 'get',
      congress: 118,
      session: 1,
    });
    await expect(rollVotesTool.handler(input, ctx)).rejects.toThrow(/voteNumber/);
  });

  it("order='recent' sorts strictly by updateDate desc across the full session (issue #27)", async () => {
    /** Mirrors the bug repro: upstream returns rows in opaque order; the head row
     * (Roll 176) has an older updateDate than Rolls 182-185. Strict newest-first
     * must put 185 first, not 176. */
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    mockApi.listVotes.mockResolvedValue({
      data: [
        { rollCallNumber: 176, updateDate: '2026-05-21T00:53:25-04:00' },
        { rollCallNumber: 185, updateDate: '2026-05-21T01:01:45-04:00' },
        { rollCallNumber: 184, updateDate: '2026-05-21T01:00:51-04:00' },
        { rollCallNumber: 183, updateDate: '2026-05-21T00:59:54-04:00' },
        { rollCallNumber: 182, updateDate: '2026-05-21T00:58:53-04:00' },
      ],
      pagination: { count: 5, nextOffset: null },
    });
    const input = rollVotesTool.input.parse({
      operation: 'list',
      congress: 119,
      session: 2,
      limit: 5,
      order: 'recent',
    });
    const result = await rollVotesTool.handler(input, ctx);
    const rolls = (result.data as Array<{ rollCallNumber: number }>).map((r) => r.rollCallNumber);
    expect(rolls).toEqual([185, 184, 183, 182, 176]);
  });

  it("order='recent' paginates across multiple upstream pages and returns the requested slice", async () => {
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    /** Total > PAGE_SIZE(250) triggers parallel page fetches. */
    mockApi.listVotes
      .mockResolvedValueOnce({
        data: Array.from({ length: 250 }, (_, i) => ({
          rollCallNumber: 1 + i,
          updateDate: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
        })),
        pagination: { count: 300, nextOffset: 250 },
      })
      .mockResolvedValueOnce({
        data: Array.from({ length: 50 }, (_, i) => ({
          rollCallNumber: 251 + i,
          updateDate: `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })),
        pagination: { count: 300, nextOffset: null },
      });
    const input = rollVotesTool.input.parse({
      operation: 'list',
      congress: 119,
      session: 2,
      limit: 3,
      offset: 0,
      order: 'recent',
    });
    const result = await rollVotesTool.handler(input, ctx);
    expect(result.data).toHaveLength(3);
    expect(result.pagination).toEqual({ count: 300, nextOffset: 3 });
    /** The strictly-newest 3 come from the second-page tail (rolls 300, 299, 298 by date). */
    const rolls = (result.data as Array<{ rollCallNumber: number }>).map((r) => r.rollCallNumber);
    expect(rolls[0]).toBe(300);
  });

  it("defaults chamber to 'house' and routes to the Congress.gov API", async () => {
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    mockApi.listVotes.mockResolvedValue({ data: [], pagination: { count: 0, nextOffset: null } });
    const input = rollVotesTool.input.parse({ operation: 'list', congress: 118, session: 1 });
    expect(input.chamber).toBe('house');
    await rollVotesTool.handler(input, ctx);
    expect(mockApi.listVotes).toHaveBeenCalledTimes(1);
  });
});

describe('rollVotesTool — Senate chamber', () => {
  const mockSenate = {
    listVotes: vi.fn(),
    getVote: vi.fn(),
    getVoteMembers: vi.fn(),
  };
  const mockApi = { listVotes: vi.fn(), getVote: vi.fn(), getVoteMembers: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSenateVoteService).mockReturnValue(mockSenate as any);
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('routes list to the Senate service, not the Congress.gov API', async () => {
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    mockSenate.listVotes.mockResolvedValue({
      chamber: 'senate',
      data: [{ chamber: 'senate', voteNumber: 339 }],
      pagination: { count: 339, nextOffset: 20 },
    });
    const input = rollVotesTool.input.parse({
      operation: 'list',
      chamber: 'senate',
      congress: 118,
      session: 2,
    });
    const result = await rollVotesTool.handler(input, ctx);
    expect(mockSenate.listVotes).toHaveBeenCalledTimes(1);
    expect(mockApi.listVotes).not.toHaveBeenCalled();
    expect(result.data).toHaveLength(1);
    expect(result.pagination?.count).toBe(339);
  });

  it('gets a specific Senate vote', async () => {
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    mockSenate.getVote.mockResolvedValue({
      chamber: 'senate',
      vote: { chamber: 'senate', voteNumber: 1, voteResult: 'Cloture Motion Agreed to' },
    });
    const input = rollVotesTool.input.parse({
      operation: 'get',
      chamber: 'senate',
      congress: 118,
      session: 2,
      voteNumber: 1,
    });
    const result = await rollVotesTool.handler(input, ctx);
    expect(mockSenate.getVote).toHaveBeenCalledWith(
      { congress: 118, session: 2, voteNumber: 1 },
      ctx,
    );
    expect((result.vote as { voteNumber: number }).voteNumber).toBe(1);
  });

  it('returns the Senate roster for members', async () => {
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    mockSenate.getVoteMembers.mockResolvedValue({
      chamber: 'senate',
      data: [{ chamber: 'senate', memberFull: 'Baldwin (D-WI)', voteCast: 'Yea' }],
      vote: { chamber: 'senate', voteNumber: 1 },
      pagination: { count: 100, nextOffset: 20 },
    });
    const input = rollVotesTool.input.parse({
      operation: 'members',
      chamber: 'senate',
      congress: 118,
      session: 2,
      voteNumber: 1,
    });
    const result = await rollVotesTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
    expect(result.vote).toBeDefined();
  });

  it('throws when get/members is missing voteNumber', async () => {
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    const input = rollVotesTool.input.parse({
      operation: 'members',
      chamber: 'senate',
      congress: 118,
      session: 2,
    });
    await expect(rollVotesTool.handler(input, ctx)).rejects.toThrow(/voteNumber/);
    expect(mockSenate.getVoteMembers).not.toHaveBeenCalled();
  });
});

/**
 * House `list` in recent order chains a first page and then a parallel stage
 * for the rest. Both stages spend the call's one budget.
 */
describe('rollVotesTool — call budget across the recent-order stages', () => {
  const upstream = scriptedCongressApi({
    /** The first page answers on its third attempt, after two full 10 s stalls. */
    '/v3/house-vote/118/1?offset=0': {
      stalls: 2,
      body: {
        houseRollCallVotes: [{ rollCallNumber: 1, updateDate: '2024-01-02T00:00:00Z' }],
        pagination: { count: 500, next: 'https://api.congress.gov/v3/house-vote/118/1' },
      },
    },
    /** The parallel stage never answers. */
    '/v3/house-vote/118/1?offset=250': { stalls: 0 },
  });

  beforeEach(() => {
    useFakeClock();
    vi.stubGlobal('fetch', upstream.fetch);
    vi.mocked(getCongressApi).mockReturnValue(new CongressApiService());
    for (const key of Object.keys(upstream.hits)) delete upstream.hits[key];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('settles inside the budget when the parallel stage stalls after a slow first page', async () => {
    const start = Date.now();
    const call = track(
      runToolContract(rollVotesTool, { operation: 'list', congress: 118, session: 1 }),
    );
    await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);

    expectBudgetTimeout(call, start);
    /** The first page took ~22 s; the parallel page got two full attempts and a clamped third. */
    expect(upstream.hits).toEqual({
      '/v3/house-vote/118/1?offset=0': 3,
      '/v3/house-vote/118/1?offset=250': 3,
    });
  });
});

// ── Member filters (issue #102) ──────────────────────────────────────────────

/** A roster row as Congress.gov serves it — `bioguideID`, which the service normalizes. */
const houseRow = (
  bioguideID: string,
  firstName: string,
  lastName: string,
  voteParty: string,
  voteState: string,
  voteCast: string,
) => ({ bioguideID, firstName, lastName, voteCast, voteParty, voteState });

/**
 * /house-vote/117/1/369/members (2026-11-03): H.R. 3684 final passage, trimmed to the
 * whole Washington delegation in roster order with three other members around it.
 */
const HOUSE_369_MEMBERS = {
  houseRollCallVoteMemberVotes: {
    congress: 117,
    identifier: 11712021369,
    legislationNumber: '3684',
    legislationType: 'HR',
    legislationUrl: 'https://www.congress.gov/bill/117/house-bill/3684',
    result: 'Passed',
    rollCallNumber: 369,
    sessionNumber: 1,
    sourceDataURL: 'https://clerk.house.gov/evs/2021/roll369.xml',
    startDate: '2021-11-05T23:24:00-04:00',
    updateDate: '2026-03-13T23:46:04-04:00',
    voteQuestion: 'On Motion to Concur in the Senate Amendment',
    voteType: 'Yea-and-Nay',
    results: [
      houseRow('S000168', 'Maria', 'Salazar', 'R', 'FL', 'Nay'),
      houseRow('S001216', 'Kim', 'Schrier', 'D', 'WA', 'Yea'),
      houseRow('N000189', 'Dan', 'Newhouse', 'R', 'WA', 'Nay'),
      houseRow('S001185', 'Terri', 'Sewell', 'D', 'AL', 'Yea'),
      houseRow('M001159', 'Cathy', 'Rodgers', 'R', 'WA', 'Nay'),
      houseRow('S001159', 'Marilyn', 'Strickland', 'D', 'WA', 'Yea'),
      houseRow('S000510', 'Adam', 'Smith', 'D', 'WA', 'Yea'),
      houseRow('J000298', 'Pramila', 'Jayapal', 'D', 'WA', 'Yea'),
      houseRow('L000560', 'Rick', 'Larsen', 'D', 'WA', 'Yea'),
      houseRow('D000617', 'Suzan', 'DelBene', 'D', 'WA', 'Yea'),
      houseRow('H001056', 'Jaime', 'Herrera Beutler', 'R', 'WA', 'Nay'),
      houseRow('K000381', 'Derek', 'Kilmer', 'D', 'WA', 'Yea'),
      houseRow('Z000017', 'Lee', 'Zeldin', 'R', 'NY', 'Nay'),
    ],
  },
};
const HOUSE_369_ROSTER = HOUSE_369_MEMBERS.houseRollCallVoteMemberVotes.results.length;

/** /house-vote/116/2/106/members (2026-11-03), trimmed: Amash sat as the House's one Libertarian. */
const HOUSE_106_MEMBERS = {
  houseRollCallVoteMemberVotes: {
    congress: 116,
    rollCallNumber: 106,
    sessionNumber: 2,
    result: 'Passed',
    voteQuestion: 'On Agreeing to the Resolution',
    results: [
      houseRow('T000467', 'Glenn', 'Thompson', 'R', 'PA', 'Nay'),
      houseRow('A000367', 'Justin', 'Amash', 'L', 'MI', 'Nay'),
      houseRow('D000624', 'Debbie', 'Dingell', 'D', 'MI', 'Yea'),
    ],
  },
};

/** The Senate LIS fixture for 118th Congress, session 2, vote 1: eight senators, two Independents. */
const SENATE_CLOTURE = readFileSync(
  new URL('../../../services/senate-lis/fixtures/vote-cloture.xml', import.meta.url),
  'utf8',
);

/**
 * One fetch for both upstreams, routed by host: api.congress.gov by path, the
 * Senate LIS feed with the cloture fixture. Anything else fails the request.
 */
function upstreamFetch() {
  return vi.fn(async (url: string | URL) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'api.congress.gov') {
      const body = {
        '/v3/house-vote/117/1/369/members': HOUSE_369_MEMBERS,
        '/v3/house-vote/116/2/106/members': HOUSE_106_MEMBERS,
      }[parsed.pathname];
      if (body) return jsonResponse(body);
    }
    if (parsed.hostname === 'www.senate.gov') {
      return new Response(SENATE_CLOTURE, {
        status: 200,
        headers: { 'content-type': 'text/xml' },
      });
    }
    throw new Error(`unrouted request ${parsed.hostname}${parsed.pathname}`);
  });
}

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;
type RosterOutput = {
  data: Array<Record<string, unknown>>;
  pagination: { count: number; nextOffset: number | null };
  memberFilter?: Record<string, unknown>;
  effectiveQuery: string;
  totalCount: number;
  notice?: string;
};

const structuredOf = (result: ContractResult) => {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as RosterOutput;
};
const contentOf = (result: ContractResult) =>
  (result.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? '').join('\n');
const lastNames = (output: RosterOutput) => output.data.map((row) => row.lastName);

describe('rollVotesTool — member filters on the House roster (issue #102)', () => {
  let fetchMock: ReturnType<typeof upstreamFetch>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = upstreamFetch();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getCongressApi).mockReturnValue(new CongressApiService());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const members369 = { operation: 'members', congress: 117, session: 1, voteNumber: 369 } as const;

  it('pages an unfiltered roster as before, with no filter on the output', async () => {
    const result = await runToolContract(rollVotesTool, { ...members369, limit: 3, offset: 3 });
    const output = structuredOf(result);
    expect(lastNames(output)).toEqual(['Sewell', 'Rodgers', 'Strickland']);
    expect(output.pagination).toEqual({ count: HOUSE_369_ROSTER, nextOffset: 6 });
    expect(output.memberFilter).toBeUndefined();
    expect(output.effectiveQuery).toBe(
      'member votes for roll 369 in the 117th Congress, session 1',
    );
    expect(contentOf(result)).not.toContain('**Filter:**');
  });

  it("returns one member's position by bioguideId", async () => {
    const result = await runToolContract(rollVotesTool, { ...members369, bioguideId: 'J000298' });
    const output = structuredOf(result);
    expect(output.data).toEqual([
      {
        bioguideId: 'J000298',
        firstName: 'Pramila',
        lastName: 'Jayapal',
        voteCast: 'Yea',
        voteParty: 'D',
        voteState: 'WA',
      },
    ]);
    expect(output.pagination).toEqual({ count: 1, nextOffset: null });
    expect(output.memberFilter).toEqual({ bioguideId: 'J000298', rosterCount: HOUSE_369_ROSTER });
    expect(output.totalCount).toBe(1);
    expect(output.effectiveQuery).toBe(
      'member votes for roll 369 in the 117th Congress, session 1 (bioguideId=J000298)',
    );
    expect(output.notice).toBeUndefined();

    const content = contentOf(result);
    expect(content).toContain(
      `**Filter:** bioguideId=J000298 — matches 1 of ${HOUSE_369_ROSTER} member positions`,
    );
    expect(content).toContain('- Pramila Jayapal (D-WA) → Yea');
  });

  it('matches every filter in any letter case', async () => {
    const result = await runToolContract(rollVotesTool, { ...members369, bioguideId: 'j000298' });
    expect(lastNames(structuredOf(result))).toEqual(['Jayapal']);
    expect(structuredOf(result).memberFilter).toEqual({
      bioguideId: 'J000298',
      rosterCount: HOUSE_369_ROSTER,
    });
  });

  it("returns a state's whole delegation by stateCode", async () => {
    const output = structuredOf(
      await runToolContract(rollVotesTool, { ...members369, stateCode: 'wa' }),
    );
    expect(output.data).toHaveLength(10);
    expect(output.data.every((row) => row.voteState === 'WA')).toBe(true);
    expect(output.pagination).toEqual({ count: 10, nextOffset: null });
    expect(output.effectiveQuery).toContain('(stateCode=WA)');
  });

  it('filters before paging: offset and limit walk the matching rows', async () => {
    const output = structuredOf(
      await runToolContract(rollVotesTool, { ...members369, stateCode: 'WA', limit: 3, offset: 3 }),
    );
    expect(lastNames(output)).toEqual(['Strickland', 'Smith', 'Jayapal']);
    expect(output.pagination).toEqual({ count: 10, nextOffset: 6 });
  });

  it('ends the walk on the last matching row', async () => {
    const output = structuredOf(
      await runToolContract(rollVotesTool, { ...members369, stateCode: 'WA', limit: 3, offset: 9 }),
    );
    expect(lastNames(output)).toEqual(['Kilmer']);
    expect(output.pagination).toEqual({ count: 10, nextOffset: null });
  });

  it('pages past the matching rows as an empty page, not a no-match', async () => {
    const result = await runToolContract(rollVotesTool, {
      ...members369,
      stateCode: 'WA',
      offset: 10,
    });
    const output = structuredOf(result);
    expect(output.data).toEqual([]);
    expect(output.pagination).toEqual({ count: 10, nextOffset: null });
    expect(output.notice).toBeUndefined();
    expect(contentOf(result)).toContain(
      '_Page is empty — offset is past the end of 10 matching member positions._',
    );
  });

  it('combines filters: every one must match', async () => {
    const output = structuredOf(
      await runToolContract(rollVotesTool, { ...members369, stateCode: 'WA', party: 'r' }),
    );
    expect(lastNames(output)).toEqual(['Newhouse', 'Rodgers', 'Herrera Beutler']);
    expect(output.memberFilter).toEqual({
      stateCode: 'WA',
      party: 'R',
      rosterCount: HOUSE_369_ROSTER,
    });
    expect(output.effectiveQuery).toContain('(stateCode=WA, party=R)');
  });

  it('matches a party code beyond D and R', async () => {
    const output = structuredOf(
      await runToolContract(rollVotesTool, {
        operation: 'members',
        congress: 116,
        session: 2,
        voteNumber: 106,
        party: 'l',
      }),
    );
    expect(output.data).toEqual([
      {
        bioguideId: 'A000367',
        firstName: 'Justin',
        lastName: 'Amash',
        voteCast: 'Nay',
        voteParty: 'L',
        voteState: 'MI',
      },
    ]);
    expect(output.effectiveQuery).toContain('116th Congress, session 2 (party=L)');
  });

  it('answers a filter that matches nothing with an empty page that does not claim no positions were recorded', async () => {
    const result = await runToolContract(rollVotesTool, { ...members369, stateCode: 'ZZ' });
    const output = structuredOf(result);
    expect(output.data).toEqual([]);
    expect(output.pagination).toEqual({ count: 0, nextOffset: null });
    expect(output.totalCount).toBe(0);
    expect(output.memberFilter).toEqual({ stateCode: 'ZZ', rosterCount: HOUSE_369_ROSTER });
    expect(output.notice).toBe(
      `No member position among the ${HOUSE_369_ROSTER} recorded for roll 369 matches stateCode=ZZ. Check the filter values, or drop a filter to widen the match.`,
    );

    const content = contentOf(result);
    expect(content).toContain('_No member position on this roll call matches the filter._');
    expect(content).not.toContain('No member positions recorded');
    expect(content).not.toContain('No member vote records found');
  });

  it('treats blank filters from form-based clients as omitted', async () => {
    const output = structuredOf(
      await runToolContract(rollVotesTool, {
        ...members369,
        bioguideId: '',
        stateCode: '',
        party: '',
        limit: 2,
      }),
    );
    expect(lastNames(output)).toEqual(['Salazar', 'Schrier']);
    expect(output.pagination).toEqual({ count: HOUSE_369_ROSTER, nextOffset: 2 });
    expect(output.memberFilter).toBeUndefined();
    expect(output.notice).toBeUndefined();
  });

  it('fetches the roster once whatever the filter', async () => {
    await runToolContract(rollVotesTool, { ...members369, stateCode: 'WA', limit: 1, offset: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('filters the whole roster, rows past the first 250 included', async () => {
    const results = Array.from({ length: 434 }, (_, i) =>
      houseRow(
        `M${String(i).padStart(6, '0')}`,
        'Member',
        `Row ${i}`,
        'D',
        i === 300 ? 'WA' : 'TX',
        'Yea',
      ),
    );
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        houseRollCallVoteMemberVotes: {
          ...HOUSE_369_MEMBERS.houseRollCallVoteMemberVotes,
          results,
        },
      }),
    );
    const output = structuredOf(
      await runToolContract(rollVotesTool, { ...members369, stateCode: 'WA' }),
    );
    expect(lastNames(output)).toEqual(['Row 300']);
    expect(output.pagination).toEqual({ count: 1, nextOffset: null });
    expect(output.memberFilter).toEqual({ stateCode: 'WA', rosterCount: 434 });
  });
});

describe('rollVotesTool — member filters on the Senate roster (issue #102)', () => {
  let fetchMock: ReturnType<typeof upstreamFetch>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = upstreamFetch();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getSenateVoteService).mockReturnValue(new SenateVoteService());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const senateMembers = {
    operation: 'members',
    chamber: 'senate',
    congress: 118,
    session: 2,
    voteNumber: 1,
  } as const;

  it("returns a state's senators by stateCode", async () => {
    const result = await runToolContract(rollVotesTool, { ...senateMembers, stateCode: 'me' });
    const output = structuredOf(result);
    expect(lastNames(output)).toEqual(['King']);
    expect(output.pagination).toEqual({ count: 1, nextOffset: null });
    expect(output.memberFilter).toEqual({ stateCode: 'ME', rosterCount: 8 });
    expect(output.effectiveQuery).toBe(
      'member votes for Senate roll 1 in the 118th Congress, session 2 (stateCode=ME)',
    );
    expect(contentOf(result)).toContain(
      '**Filter:** stateCode=ME — matches 1 of 8 member positions',
    );
    expect(contentOf(result)).toContain('- King (I-ME) → Yea');
  });

  it('returns a party by its code, paged after filtering', async () => {
    const output = structuredOf(
      await runToolContract(rollVotesTool, { ...senateMembers, party: 'I', limit: 1, offset: 1 }),
    );
    expect(lastNames(output)).toEqual(['Sanders']);
    expect(output.pagination).toEqual({ count: 2, nextOffset: null });
  });

  it('answers a filter that matches nothing with an empty page and a notice', async () => {
    const result = await runToolContract(rollVotesTool, { ...senateMembers, stateCode: 'ZZ' });
    const output = structuredOf(result);
    expect(output.data).toEqual([]);
    expect(output.pagination).toEqual({ count: 0, nextOffset: null });
    expect(output.notice).toBe(
      'No member position among the 8 recorded for Senate roll 1 matches stateCode=ZZ. Check the filter values, or drop a filter to widen the match.',
    );
    expect(contentOf(result)).not.toContain('No member positions recorded');
  });

  it('rejects bioguideId on a Senate roster, naming stateCode, before fetching', async () => {
    const result = await runToolContract(rollVotesTool, {
      ...senateMembers,
      bioguideId: 'S000033',
    });
    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: Record<string, unknown> }).error;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'unsupported_filter',
      field: 'bioguideId',
      chamber: 'senate',
    });
    expect(error.message).toContain('stateCode');
    expect(contentOf(result)).toContain('stateCode');
    expect(contentOf(result)).toContain('Recovery:');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a blank bioguideId from a form-based client as omitted', async () => {
    const output = structuredOf(
      await runToolContract(rollVotesTool, { ...senateMembers, bioguideId: '', limit: 2 }),
    );
    expect(lastNames(output)).toEqual(['Baldwin', 'Barrasso']);
    expect(output.pagination).toEqual({ count: 8, nextOffset: 2 });
  });
});

describe('rollVotesTool — filters on list and get (issue #102)', () => {
  const mockApi = { listVotes: vi.fn(), getVote: vi.fn(), getVoteMembers: vi.fn() };
  const mockSenate = { listVotes: vi.fn(), getVote: vi.fn(), getVoteMembers: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
    vi.mocked(getSenateVoteService).mockReturnValue(mockSenate as any);
  });

  it("serves 'list' and names the filter it ignored", async () => {
    mockApi.listVotes.mockResolvedValue({
      data: [{ rollCallNumber: 1 }],
      pagination: { count: 1, nextOffset: null },
    });
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    const input = rollVotesTool.input.parse({
      operation: 'list',
      congress: 117,
      session: 1,
      order: 'oldest',
      stateCode: 'WA',
    });
    const result = await rollVotesTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
    expect(getEnrichment(ctx).notice).toBe("'list' does not use stateCode, so it was ignored.");
  });

  it("serves 'get' and names every filter it ignored", async () => {
    mockApi.getVote.mockResolvedValue({ vote: { rollCallNumber: 369 } });
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    const input = rollVotesTool.input.parse({
      operation: 'get',
      congress: 117,
      session: 1,
      voteNumber: 369,
      bioguideId: 'J000298',
      party: 'D',
    });
    await rollVotesTool.handler(input, ctx);
    expect(mockApi.getVote).toHaveBeenCalledWith(
      { congress: 117, session: 1, voteNumber: 369 },
      ctx,
    );
    expect(getEnrichment(ctx).notice).toBe(
      "'get' does not use bioguideId or party, so they were ignored.",
    );
  });

  it("serves a Senate 'get' carrying bioguideId rather than rejecting it", async () => {
    mockSenate.getVote.mockResolvedValue({ chamber: 'senate', vote: { voteNumber: 1 } });
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    const input = rollVotesTool.input.parse({
      operation: 'get',
      chamber: 'senate',
      congress: 118,
      session: 2,
      voteNumber: 1,
      bioguideId: 'S000033',
    });
    await rollVotesTool.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toBe("'get' does not use bioguideId, so it was ignored.");
  });

  it('composes the ignored-filter notice with the no-votes notice', async () => {
    mockApi.listVotes.mockResolvedValue({ data: [], pagination: { count: 0, nextOffset: null } });
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    const input = rollVotesTool.input.parse({
      operation: 'list',
      congress: 114,
      session: 1,
      order: 'oldest',
      party: 'D',
    });
    await rollVotesTool.handler(input, ctx);
    const notice = getEnrichment(ctx).notice;
    expect(notice).toMatch(/^'list' does not use party, so it was ignored\. No votes found\./);
  });
});

describe('rollVotesTool — input validation (issue #102)', () => {
  const members = { operation: 'members', congress: 117, session: 1, voteNumber: 369 } as const;

  it.each([
    ['House', 'house'],
    ['HOUSE', 'house'],
    ['Senate', 'senate'],
    ['sEnAtE', 'senate'],
  ])('accepts chamber %s in any letter case', (chamber, expected) => {
    expect(rollVotesTool.input.parse({ ...members, chamber }).chamber).toBe(expected);
  });

  it('still rejects a chamber that names neither', () => {
    expect(rollVotesTool.input.safeParse({ ...members, chamber: 'Hous' }).success).toBe(false);
  });

  it('advertises the lowercase chamber values and the house default', () => {
    const json = z.toJSONSchema(rollVotesTool.input, { io: 'input' }) as {
      properties: Record<string, { enum?: string[]; default?: unknown; description?: string }>;
    };
    expect(json.properties.chamber).toMatchObject({ enum: ['house', 'senate'], default: 'house' });
    expect(json.properties.chamber?.description).toContain("'house'");
  });

  it.each([
    ['bioguideId', 'J00029'],
    ['bioguideId', 'JJ00298'],
    ['bioguideId', '0000298'],
    ['bioguideId', ' J000298'],
    ['stateCode', 'WAS'],
    ['stateCode', 'W1'],
    ['stateCode', 'W'],
    ['party', 'DEM'],
    ['party', '1'],
    ['party', 'D '],
  ])('rejects malformed %s %j', (field, value) => {
    expect(rollVotesTool.input.safeParse({ ...members, [field]: value }).success).toBe(false);
  });

  it('rejects a malformed filter as invalid arguments, naming the field', async () => {
    const result = await runToolContract(rollVotesTool, { ...members, stateCode: 'Washington' });
    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: { code: number; message: string } }).error;
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.message).toContain('stateCode');
  });

  it.each([
    ['bioguideId', 'J000298'],
    ['stateCode', 'WA'],
    ['party', 'D'],
    ['party', 'ID'],
  ])('accepts %s %j', (field, value) => {
    expect(rollVotesTool.input.safeParse({ ...members, [field]: value }).success).toBe(true);
  });
});

describe('rollVotesTool — House coverage (issue #102)', () => {
  const mockApi = { listVotes: vi.fn(), getVote: vi.fn(), getVoteMembers: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
    mockApi.listVotes.mockResolvedValue({ data: [], pagination: { count: 0, nextOffset: null } });
  });

  it.each(['recent', 'oldest'] as const)(
    "names the 115th Congress floor when a House 'list' (%s) finds no votes",
    async (order) => {
      const ctx = createMockContext({ errors: rollVotesTool.errors });
      const input = rollVotesTool.input.parse({
        operation: 'list',
        congress: 114,
        session: 1,
        order,
      });
      await rollVotesTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toBe(
        'No votes found. Verify the congress and session numbers — Congress.gov publishes House roll call votes from the 115th Congress (2017) onward.',
      );
    },
  );

  it('names the chain from bill actions and both coverage floors in the description', () => {
    expect(rollVotesTool.description).toContain('congressgov_bill_lookup');
    expect(rollVotesTool.description).toContain('rollVote');
    expect(rollVotesTool.description).toContain('115th Congress');
    expect(rollVotesTool.description).toContain('101st');
  });
});

describe('rollVotesTool — congress ordinals in the echo (issue #94)', () => {
  const mockApi = { listVotes: vi.fn(), getVote: vi.fn(), getVoteMembers: vi.fn() };
  const mockSenate = { listVotes: vi.fn(), getVote: vi.fn(), getVoteMembers: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
    vi.mocked(getSenateVoteService).mockReturnValue(mockSenate as any);
    const roster = { data: [{}], vote: {}, pagination: { count: 1, nextOffset: null } };
    mockApi.getVoteMembers.mockResolvedValue(roster);
    mockApi.getVote.mockResolvedValue({ vote: {} });
    mockSenate.getVoteMembers.mockResolvedValue({ chamber: 'senate', ...roster });
    mockSenate.getVote.mockResolvedValue({ chamber: 'senate', vote: {} });
  });

  it.each([
    ['house', 'members', 121, 'member votes for roll 7 in the 121st Congress, session 1'],
    ['house', 'get', 122, 'roll call 7 in the 122nd Congress, session 1'],
    ['senate', 'members', 101, 'member votes for Senate roll 7 in the 101st Congress, session 1'],
    ['senate', 'get', 103, 'Senate roll call 7 in the 103rd Congress, session 1'],
  ] as const)('%s %s in congress %i', async (chamber, operation, congress, echo) => {
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    const input = rollVotesTool.input.parse({
      operation,
      chamber,
      congress,
      session: 1,
      voteNumber: 7,
    });
    await rollVotesTool.handler(input, ctx);
    expect(getEnrichment(ctx).effectiveQuery).toBe(echo);
  });
});

// ── Senate votes from Voteview (issue #90) ───────────────────────────────────

const VOTEVIEW_FIXTURES = new URL(
  '../../../services/senate-lis/fixtures/voteview-2026-11-04/',
  import.meta.url,
);
const voteviewFixture = (name: string) => readFileSync(new URL(name, VOTEVIEW_FIXTURES), 'utf8');
const LIS_MENU = readFileSync(
  new URL('../../../services/senate-lis/fixtures/menu.xml', import.meta.url),
  'utf8',
);
const VOTEVIEW_FILE_RE =
  /^\/static\/data\/out\/(?:rollcalls|votes|members)\/(S\d+_(?:rollcalls|votes|members)\.csv)$/;

/** senate.gov answering the LIS feed with its firewall page and HTTP 403, as it answers automated clients. */
const lisRefused = () =>
  new Response(voteviewFixture('lis-403-firewall-2026-11-04.html.txt'), {
    status: 403,
    headers: { 'content-type': 'text/html' },
  });

/** The LIS feed answering: the 118th Congress, session 2 menu and its vote 1. */
const lisAnswering = (url: URL) =>
  new Response(url.pathname.includes('/roll_call_lists/') ? LIS_MENU : SENATE_CLOTURE, {
    status: 200,
    headers: { 'content-type': 'text/xml' },
  });

/**
 * One fetch for the Senate's two sources, counting requests per host: www.senate.gov
 * answers through `lis` (refusing by default), and voteview.com through `voteview`
 * when given, else with the files captured 2026-11-04 (its 404 page for any other).
 * Anything else fails the request.
 */
function senateSourcesFetch(lis: (url: URL) => Response = lisRefused, voteview?: () => Response) {
  const hosts: Record<string, number> = {};
  const fetch = vi.fn(async (url: string | URL) => {
    const parsed = new URL(String(url));
    hosts[parsed.hostname] = (hosts[parsed.hostname] ?? 0) + 1;
    if (parsed.hostname === 'www.senate.gov') return lis(parsed);
    if (parsed.hostname === 'voteview.com') {
      if (voteview) return voteview();
      const file = VOTEVIEW_FILE_RE.exec(parsed.pathname)?.[1];
      if (file && existsSync(new URL(file, VOTEVIEW_FIXTURES))) {
        return new Response(voteviewFixture(file), {
          status: 200,
          headers: { 'content-type': 'text/csv' },
        });
      }
      return new Response(voteviewFixture('voteview-404-2026-11-04.html.txt'), {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    }
    throw new Error(`unrouted request ${parsed.hostname}${parsed.pathname}`);
  });
  return { fetch, hosts };
}

/** The citation Voteview's data page asks for (voteview.com/data, 2026-11-04). */
const VOTEVIEW_CITATION =
  'Lewis, Jeffrey B., Keith Poole, Howard Rosenthal, Adam Boche, Aaron Rudkin, and Luke Sonnet (2026). Voteview: Congressional Roll-Call Votes Database. https://voteview.com/';

/** The fixture's 119th Congress runs through session 2 vote 256, taken 2026-09-30. */
const SOURCE_119 = {
  name: 'Voteview',
  url: 'https://voteview.com/',
  congress: 119,
  latestVote: { session: 2, voteNumber: 256, date: '2026-09-30' },
  citation: VOTEVIEW_CITATION,
};
const SOURCE_LINE_119 = `**Source:** Voteview (https://voteview.com/) answered for the Senate's LIS feed, which could not be read. Its latest Senate vote for the 119th Congress is session 2 vote 256 (2026-09-30); later votes are not in it yet. Cite as: ${VOTEVIEW_CITATION}`;

type VoteOutput = {
  data?: Array<Record<string, unknown>>;
  vote?: Record<string, unknown>;
  pagination?: { count: number; nextOffset: number | null };
  memberFilter?: Record<string, unknown>;
  source?: unknown;
  effectiveQuery: string;
  totalCount: number;
  notice?: string;
};
type ErrorOutput = { code: number; message: string; data: Record<string, unknown> };

const outputOf = (result: ContractResult) => {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as VoteOutput;
};
const errorOf = (result: ContractResult) => {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: ErrorOutput }).error;
};
const hintOf = (error: ErrorOutput) => (error.data.recovery as { hint: string }).hint;

describe('rollVotesTool — Senate votes from Voteview when the LIS feed is refused (issue #90)', () => {
  let upstream: ReturnType<typeof senateSourcesFetch>;

  beforeEach(() => {
    vi.clearAllMocks();
    /** Whether a congress has ended is read from the clock: hold it at the capture date. */
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
    upstream = senateSourcesFetch();
    vi.stubGlobal('fetch', upstream.fetch);
    vi.mocked(getSenateVoteService).mockReturnValue(new SenateVoteService());
    vi.mocked(getCongressApi).mockReturnValue(new CongressApiService());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const vote256 = { chamber: 'senate', congress: 119, session: 2, voteNumber: 256 } as const;

  it('gets the vote from Voteview and names the source, its latest vote, and its citation on both surfaces', async () => {
    const result = await runToolContract(rollVotesTool, { operation: 'get', ...vote256 });
    const output = outputOf(result);
    expect(output.vote).toEqual({
      chamber: 'senate',
      congress: 119,
      session: 2,
      voteNumber: 256,
      voteDateIso: '2026-09-30',
      question: 'On the Nomination',
      voteResult: 'Nomination Confirmed',
      voteDocumentText: 'Keith Sonderling, of Florida, to be Secretary of Labor',
      majorityRequirement: '1/2',
      issue: 'PN1129',
      count: { yeas: 47, nays: 41, present: 0, absent: 12 },
      partyTotals: [
        { party: 'R', yea: 47, nay: 0, present: 0, notVoting: 6 },
        { party: 'D', yea: 0, nay: 39, present: 0, notVoting: 6 },
        { party: 'I', yea: 0, nay: 2, present: 0, notVoting: 0 },
      ],
    });
    expect(output.source).toEqual(SOURCE_119);
    expect(output.totalCount).toBe(1);
    expect(output.effectiveQuery).toBe('Senate roll call 256 in the 119th Congress, session 2');

    const content = contentOf(result);
    expect(content).toContain('# Senate Vote 256 — Nomination Confirmed');
    expect(content).toContain('**Question:** On the Nomination');
    expect(content).toContain(
      '**Congress:** 119 | **Session:** 2 | **Date:** 2026-09-30 | **Majority Required:** 1/2 | **Issue:** PN1129',
    );
    expect(content).toContain('**Tally:** Yea 47 · Nay 41 · Present 0 · Not Voting 12');
    expect(content).toContain('- **I:** Yea 0, Nay 2, Present 0, Not Voting 0');
    expect(content).toContain('\n\nKeith Sonderling, of Florida, to be Secretary of Labor');
    expect(content).toContain(SOURCE_LINE_119);
    /** One refused LIS request, never retried, then each of the congress's three files once. */
    expect(upstream.hosts).toEqual({ 'www.senate.gov': 1, 'voteview.com': 3 });
  });

  it("returns a state's senators from Voteview with their bioguide IDs, on both surfaces", async () => {
    const result = await runToolContract(rollVotesTool, {
      operation: 'members',
      ...vote256,
      stateCode: 'wa',
    });
    const output = outputOf(result);
    expect(output.data).toEqual([
      {
        chamber: 'senate',
        name: 'CANTWELL, Maria E.',
        party: 'D',
        state: 'WA',
        voteCast: 'Nay',
        bioguideId: 'C000127',
      },
      {
        chamber: 'senate',
        name: 'MURRAY, Patty',
        party: 'D',
        state: 'WA',
        voteCast: 'Nay',
        bioguideId: 'M001111',
      },
    ]);
    expect(output.pagination).toEqual({ count: 2, nextOffset: null });
    expect(output.memberFilter).toEqual({ stateCode: 'WA', rosterCount: 100 });
    expect(output.source).toEqual(SOURCE_119);
    expect(output.effectiveQuery).toBe(
      'member votes for Senate roll 256 in the 119th Congress, session 2 (stateCode=WA)',
    );

    const content = contentOf(result);
    expect(content).toContain('# Senate Vote 256 — 119th Congress, session 2');
    expect(content).toContain('**On the Nomination** — Nomination Confirmed');
    expect(content).toContain('**Filter:** stateCode=WA — matches 2 of 100 member positions');
    expect(content).toContain('- CANTWELL, Maria E. (D-WA) → Nay — bioguideId: C000127');
    expect(content).toContain('- MURRAY, Patty (D-WA) → Nay — bioguideId: M001111');
    expect(content).toContain(SOURCE_LINE_119);
  });

  it('pages the unfiltered Voteview roster with the source on every page, past the end included', async () => {
    const first = await runToolContract(rollVotesTool, {
      operation: 'members',
      ...vote256,
      limit: 2,
    });
    const output = outputOf(first);
    expect(
      output.data?.map((row) => [row.name, row.party, row.state, row.voteCast, row.bioguideId]),
    ).toEqual([
      ['ALSOBROOKS, Angela Deneece', 'D', 'MD', 'Nay', 'A000382'],
      ['ARMSTRONG, Alan', 'R', 'OK', 'Yea', 'A000383'],
    ]);
    expect(output.pagination).toEqual({ count: 100, nextOffset: 2 });
    expect(output.memberFilter).toBeUndefined();
    expect(output.source).toEqual(SOURCE_119);
    expect(contentOf(first)).toContain('**Members 1–2 of 100** · next offset: 2');
    expect(contentOf(first)).toContain(SOURCE_LINE_119);

    const pastEnd = await runToolContract(rollVotesTool, {
      operation: 'members',
      ...vote256,
      offset: 100,
    });
    const empty = outputOf(pastEnd);
    expect(empty.data).toEqual([]);
    expect(empty.pagination).toEqual({ count: 100, nextOffset: null });
    expect(empty.notice).toBeUndefined();
    expect(empty.source).toEqual(SOURCE_119);
    expect(contentOf(pastEnd)).toContain(
      '_Page is empty — offset is past the end of 100 member positions._',
    );
    expect(contentOf(pastEnd)).toContain(SOURCE_LINE_119);
    /** The second call reads the congress from the cache; only the LIS feed is asked again. */
    expect(upstream.hosts).toEqual({ 'www.senate.gov': 2, 'voteview.com': 3 });
  });

  it("lists a session's votes from Voteview newest first, paged as the feed pages them", async () => {
    const list = { operation: 'list', chamber: 'senate', congress: 119, session: 2 } as const;
    const result = await runToolContract(rollVotesTool, list);
    const output = outputOf(result);
    expect(output.data?.map((row) => row.voteNumber)).toEqual([256, 255, 254]);
    expect(output.data?.[0]).toEqual({
      chamber: 'senate',
      voteNumber: 256,
      yeas: 47,
      nays: 41,
      voteDateIso: '2026-09-30',
      issue: 'PN1129',
      question: 'On the Nomination',
      result: 'Nomination Confirmed',
      title: 'Keith Sonderling, of Florida, to be Secretary of Labor',
    });
    expect(output.pagination).toEqual({ count: 3, nextOffset: null });
    expect(output.source).toEqual(SOURCE_119);
    expect(output.effectiveQuery).toBe('Senate roll call votes (congress=119, session=2)');
    const content = contentOf(result);
    expect(content).toContain('### 1. Vote 256: PN1129 — Nomination Confirmed');
    expect(content).toContain('**Date:** 2026-09-30 | **Yeas:** 47 | **Nays:** 41');
    expect(content).toContain(SOURCE_LINE_119);

    const oldest = outputOf(
      await runToolContract(rollVotesTool, { ...list, order: 'oldest', limit: 2 }),
    );
    expect(oldest.data?.map((row) => row.voteNumber)).toEqual([254, 255]);
    expect(oldest.pagination).toEqual({ count: 3, nextOffset: 2 });

    const empty = outputOf(await runToolContract(rollVotesTool, { ...list, offset: 3 }));
    expect(empty.data).toEqual([]);
    expect(empty.pagination).toEqual({ count: 3, nextOffset: null });
    expect(empty.notice).toBeUndefined();
    expect(empty.source).toEqual(SOURCE_119);
  });

  it.each(['get', 'members'] as const)(
    "answers %s for a vote after Voteview's latest as not found naming that vote, and its recovery lists it",
    async (operation) => {
      const result = await runToolContract(rollVotesTool, {
        operation,
        ...vote256,
        voteNumber: 257,
      });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.message).toContain(
        'Senate roll call vote 257 of the 119th Congress, session 2 is not in Voteview',
      );
      expect(error.message).toContain(
        'Its latest Senate vote for the 119th Congress is session 2 vote 256 (2026-09-30)',
      );
      expect(error.data).toMatchObject({
        reason: 'not_found',
        congress: 119,
        session: 2,
        voteNumber: 257,
        latestVote: { session: 2, voteNumber: 256, date: '2026-09-30' },
      });
      const hint = hintOf(error);
      expect(hint).toContain("operation 'list' with chamber 'senate'");
      const content = contentOf(result);
      expect(content).toContain('session 2 vote 256 (2026-09-30)');
      expect(content).toContain(hint);

      /** Following the hint: the session's list leads with the latest vote the error named. */
      const listed = outputOf(
        await runToolContract(rollVotesTool, {
          operation: 'list',
          chamber: 'senate',
          congress: 119,
          session: 2,
        }),
      );
      expect(listed.data?.[0]?.voteNumber).toBe(256);
    },
  );

  it('names the last vote of a congress that has ended without saying more will come', async () => {
    const result = await runToolContract(rollVotesTool, {
      operation: 'get',
      chamber: 'senate',
      congress: 118,
      session: 2,
      voteNumber: 336,
    });
    expect(outputOf(result).source).toEqual({
      ...SOURCE_119,
      congress: 118,
      latestVote: { session: 2, voteNumber: 336, date: '2024-12-20' },
    });
    const content = contentOf(result);
    expect(content).toContain(
      `**Source:** Voteview (https://voteview.com/) answered for the Senate's LIS feed, which could not be read. Its latest Senate vote for the 118th Congress is session 2 vote 336 (2024-12-20). Cite as: ${VOTEVIEW_CITATION}`,
    );
    expect(content).not.toContain('not in it yet');
  });

  it('names where a session ends in Voteview for a vote past it that precedes the latest', async () => {
    const result = await runToolContract(rollVotesTool, {
      operation: 'get',
      chamber: 'senate',
      congress: 119,
      session: 1,
      voteNumber: 14,
    });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toContain('session 1 runs through vote 13');
    expect(contentOf(result)).toContain('session 1 runs through vote 13');
  });

  it('still rejects bioguideId on a Senate roster before any request, though Voteview rows carry it', async () => {
    const result = await runToolContract(rollVotesTool, {
      operation: 'members',
      ...vote256,
      bioguideId: 'C000127',
    });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'unsupported_filter', field: 'bioguideId' });
    expect(contentOf(result)).toContain('stateCode');
    expect(upstream.fetch).not.toHaveBeenCalled();
  });

  it('fails as upstream_error on both surfaces when Voteview cannot be read either', async () => {
    useFakeClock();
    try {
      upstream = senateSourcesFetch(
        lisRefused,
        () =>
          new Response('Service Unavailable', {
            status: 503,
            headers: { 'content-type': 'text/plain' },
          }),
      );
      vi.stubGlobal('fetch', upstream.fetch);
      const call = track(runToolContract(rollVotesTool, { operation: 'get', ...vote256 }));
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);

      const result = call.state.value as ContractResult;
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'upstream_error' });
      expect(error.message).toContain('Voteview');
      expect(hintOf(error)).toContain("House votes (chamber 'house') are unaffected");
      expect(contentOf(result)).toContain(error.message);
      expect(contentOf(result)).toContain(hintOf(error));
      expect(upstream.hosts['www.senate.gov']).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rollVotesTool — Senate votes while the LIS feed answers (issue #90)', () => {
  let upstream: ReturnType<typeof senateSourcesFetch>;

  beforeEach(() => {
    vi.clearAllMocks();
    upstream = senateSourcesFetch(lisAnswering);
    vi.stubGlobal('fetch', upstream.fetch);
    vi.mocked(getSenateVoteService).mockReturnValue(new SenateVoteService());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['get', { voteNumber: 1 }],
    ['members', { voteNumber: 1 }],
    ['members', { voteNumber: 1, stateCode: 'ME' }],
    ['list', {}],
  ] as const)('%s %o carries no source and asks Voteview nothing', async (operation, extra) => {
    const result = await runToolContract(rollVotesTool, {
      operation,
      chamber: 'senate',
      congress: 118,
      session: 2,
      ...extra,
    });
    expect(outputOf(result)).not.toHaveProperty('source');
    expect(contentOf(result)).not.toContain('Voteview');
    expect(contentOf(result)).not.toContain('**Source:**');
    expect(upstream.hosts).toEqual({ 'www.senate.gov': 1 });
  });

  it('renders an LIS vote with its timestamp and document and no Voteview-only lines', async () => {
    const result = await runToolContract(rollVotesTool, {
      operation: 'get',
      chamber: 'senate',
      congress: 118,
      session: 2,
      voteNumber: 1,
    });
    const vote = outputOf(result).vote;
    expect(vote).not.toHaveProperty('voteDateIso');
    expect(vote).not.toHaveProperty('issue');
    const content = contentOf(result);
    expect(content).toMatch(
      /\*\*Congress:\*\* 118 \| \*\*Session:\*\* 2 \| \*\*Date:\*\* January 8, 2024,\s+05:27 PM \| \*\*Majority Required:\*\* 1\/2\n/,
    );
    expect(content).not.toContain('**Issue:**');
    expect(content).toContain('**Document:** PN — PN1020');
  });
});

// ── House votes before the 115th Congress (issue #109) ────────────────────────

/** Congress.gov's House vote coverage, as issue #109 states it. */
const HOUSE_COVERAGE =
  'Congress.gov publishes House roll call votes from the 115th Congress (2017) onward';

/**
 * api.congress.gov for the coverage boundary: every 114th Congress House vote path
 * answers 404, as Congress.gov does for a vote it doesn't hold, and the 115th's
 * first roll call answers with a record trimmed to its identifiers.
 */
function houseCoverageFetch() {
  return vi.fn(async (url: string | URL) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'api.congress.gov') {
      if (parsed.pathname.startsWith('/v3/house-vote/114/')) {
        return new Response(JSON.stringify({ error: 'Not Found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      const identifiers = { congress: 115, sessionNumber: 1, rollCallNumber: 1 };
      if (parsed.pathname === '/v3/house-vote/115/1/1') {
        return jsonResponse({ houseRollCallVote: identifiers });
      }
      if (parsed.pathname === '/v3/house-vote/115/1/1/members') {
        return jsonResponse({ houseRollCallVoteMemberVotes: { ...identifiers, results: [] } });
      }
    }
    throw new Error(`unrouted request ${parsed.hostname}${parsed.pathname}`);
  });
}

describe('rollVotesTool — House votes before the 115th Congress (issue #109)', () => {
  let fetchMock: ReturnType<typeof houseCoverageFetch>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = houseCoverageFetch();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getCongressApi).mockReturnValue(new CongressApiService());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** H.R. 2029's actions cite this roll call (clerk.house.gov/evs/2015/roll705.xml). */
  const roll705 = { congress: 114, session: 1, voteNumber: 705 } as const;

  it.each([
    ['get', {}],
    ['members', {}],
    ['members', { stateCode: 'WA', limit: 5 }],
  ] as const)(
    '%s %o fails as not found naming the coverage and the Clerk XML, before any request',
    async (operation, extra) => {
      const result = await runToolContract(rollVotesTool, { operation, ...roll705, ...extra });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.message).toBe(
        `House roll call vote 705 of the 114th Congress, session 1 is not on Congress.gov: ${HOUSE_COVERAGE}. A bill action that records the vote carries the House Clerk's vote XML in its recordedVotes entry.`,
      );
      expect(error.data).toMatchObject({ reason: 'not_found', ...roll705 });
      const hint = hintOf(error);
      expect(hint).toContain("congressgov_bill_lookup 'actions'");
      expect(hint).toContain('recordedVotes');
      expect(hint).toContain('clerk.house.gov/evs/{year}/roll{number}.xml');
      expect(hint).not.toMatch(/\blist\b/);

      const content = contentOf(result);
      expect(content).toContain(HOUSE_COVERAGE);
      expect(content).toContain('recordedVotes');
      expect(content).toContain(hint);
      expect(content).not.toContain('list or browse');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['get', '/v3/house-vote/115/1/1'],
    ['members', '/v3/house-vote/115/1/1/members'],
  ] as const)('still asks Congress.gov for %s at the 115th Congress', async (operation, path) => {
    const result = await runToolContract(rollVotesTool, {
      operation,
      congress: 115,
      session: 1,
      voteNumber: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(path);
  });
});

describe('rollVotesTool — description', () => {
  it('names the Voteview fallback and the hand-off to congressgov_amendment_lookup', () => {
    expect(rollVotesTool.description).toContain("answered from Voteview's published vote files");
    expect(rollVotesTool.description).toContain(
      "A House vote on an amendment carries amendmentType and amendmentNumber; pass them, with congress, to congressgov_amendment_lookup for the amendment's sponsor, actions, cosponsors, and text.",
    );
  });
});

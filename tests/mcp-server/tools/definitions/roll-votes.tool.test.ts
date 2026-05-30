/**
 * @fileoverview Tests for congressgov_roll_votes tool.
 * @module tests/mcp-server/tools/definitions/roll-votes.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { rollVotesTool } from '@/mcp-server/tools/definitions/roll-votes.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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

  it('gets vote member positions', async () => {
    const ctx = createMockContext();
    mockApi.getVoteMembers.mockResolvedValue({
      vote: { results: [{ member: 'Smith', position: 'Yea' }] },
      pagination: { count: 1, nextOffset: null },
    });
    const input = rollVotesTool.input.parse({
      operation: 'members',
      congress: 118,
      session: 1,
      voteNumber: 42,
    });
    const result = await rollVotesTool.handler(input, ctx);
    expect((result.vote as { results: unknown[] }).results).toHaveLength(1);
  });

  it('throws when get/members is missing voteNumber', async () => {
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
});

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
    mockApi.getVoteMembers.mockResolvedValue({ vote: [{ member: 'Smith', position: 'Yea' }] });
    const input = rollVotesTool.input.parse({
      operation: 'members',
      congress: 118,
      session: 1,
      voteNumber: 42,
    });
    const result = await rollVotesTool.handler(input, ctx);
    expect(result.vote).toHaveLength(1);
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
});

/**
 * @fileoverview Tests for SenateVoteService — URL construction, ordering, client-side
 * pagination, and the "200 HTML page means not found" behavior of the Senate host.
 * @module tests/services/senate-lis/senate-vote-service.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSenateVoteService,
  initSenateVoteService,
  SenateVoteService,
} from '@/services/senate-lis/senate-vote-service.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const MENU = fixture('menu.xml');
const CLOTURE = fixture('vote-cloture.xml');

/** A 200 HTML error page — what Senate.gov serves for an unknown congress/session/vote. */
const HTML_404_PAGE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"><html><head><title>Page Not Found</title></head><body>Not found</body></html>';

function xmlResponse(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    text: async () => body,
  };
}

describe('SenateVoteService', () => {
  let service: SenateVoteService;
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(xmlResponse(MENU));
    vi.stubGlobal('fetch', mockFetch);
    service = new SenateVoteService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('list', () => {
    it('builds the session menu URL', async () => {
      await service.listVotes(
        { congress: 118, session: 2, order: 'recent', limit: 5, offset: 0 },
        createMockContext(),
      );
      expect(String(mockFetch.mock.calls[0][0])).toBe(
        'https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_118_2.xml',
      );
    });

    it('orders newest-first by roll number for "recent"', async () => {
      const result = await service.listVotes(
        { congress: 118, session: 2, order: 'recent', limit: 10, offset: 0 },
        createMockContext(),
      );
      expect(result.chamber).toBe('senate');
      expect(result.data.map((v) => v.voteNumber)).toEqual([339, 337, 336, 1]);
      expect(result.pagination.count).toBe(4);
    });

    it('orders ascending for "oldest"', async () => {
      const result = await service.listVotes(
        { congress: 118, session: 2, order: 'oldest', limit: 10, offset: 0 },
        createMockContext(),
      );
      expect(result.data.map((v) => v.voteNumber)).toEqual([1, 336, 337, 339]);
    });

    it('paginates client-side with an accurate nextOffset', async () => {
      const page1 = await service.listVotes(
        { congress: 118, session: 2, order: 'recent', limit: 2, offset: 0 },
        createMockContext(),
      );
      expect(page1.data.map((v) => v.voteNumber)).toEqual([339, 337]);
      expect(page1.pagination).toEqual({ count: 4, nextOffset: 2 });

      const page2 = await service.listVotes(
        { congress: 118, session: 2, order: 'recent', limit: 2, offset: 2 },
        createMockContext(),
      );
      expect(page2.data.map((v) => v.voteNumber)).toEqual([336, 1]);
      expect(page2.pagination).toEqual({ count: 4, nextOffset: null });
    });

    it('treats a 200 HTML page as not found', async () => {
      mockFetch.mockResolvedValue(xmlResponse(HTML_404_PAGE));
      const error = (await service
        .listVotes(
          { congress: 99, session: 1, order: 'recent', limit: 5, offset: 0 },
          createMockContext(),
        )
        .catch((e: unknown) => e)) as McpError;
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('not_found');
      expect(error.message).toContain('99th Congress');
    });
  });

  describe('get', () => {
    it('builds the vote URL with a zero-padded roll number', async () => {
      mockFetch.mockResolvedValue(xmlResponse(CLOTURE));
      await service.getVote({ congress: 118, session: 2, voteNumber: 1 }, createMockContext());
      expect(String(mockFetch.mock.calls[0][0])).toBe(
        'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1182/vote_118_2_00001.xml',
      );
    });

    it('returns the vote with party totals derived from the roster', async () => {
      mockFetch.mockResolvedValue(xmlResponse(CLOTURE));
      const result = await service.getVote(
        { congress: 118, session: 2, voteNumber: 1 },
        createMockContext(),
      );
      expect(result.chamber).toBe('senate');
      expect(result.vote.voteNumber).toBe(1);
      expect(result.vote.partyTotals).toEqual([
        { party: 'D', yea: 3, nay: 0, present: 0, notVoting: 0 },
        { party: 'R', yea: 0, nay: 2, present: 0, notVoting: 1 },
        { party: 'I', yea: 2, nay: 0, present: 0, notVoting: 0 },
      ]);
    });

    it('maps a missing vote (200 HTML) to a not-found error', async () => {
      mockFetch.mockResolvedValue(xmlResponse(HTML_404_PAGE));
      const error = (await service
        .getVote({ congress: 118, session: 2, voteNumber: 99999 }, createMockContext())
        .catch((e: unknown) => e)) as McpError;
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.message).toContain('99999');
    });
  });

  describe('members', () => {
    it('paginates the roster and carries the vote as a sibling', async () => {
      mockFetch.mockResolvedValue(xmlResponse(CLOTURE));
      const result = await service.getVoteMembers(
        { congress: 118, session: 2, voteNumber: 1, limit: 3, offset: 0 },
        createMockContext(),
      );
      expect(result.data).toHaveLength(3);
      expect(result.pagination).toEqual({ count: 8, nextOffset: 3 });
      expect(result.vote.voteNumber).toBe(1);
      /** The roster lives in `data[]`; the vote sibling omits the derived party totals. */
      expect(result.vote.partyTotals).toBeUndefined();
    });
  });

  describe('upstream errors', () => {
    it('classifies an empty body as service unavailable', async () => {
      mockFetch.mockResolvedValue(xmlResponse(''));
      await expect(
        service.listVotes(
          { congress: 118, session: 2, order: 'recent', limit: 5, offset: 0 },
          createMockContext(),
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    });

    it('wraps network failures as service unavailable and retries them', async () => {
      mockFetch.mockRejectedValue(new Error('socket hang up'));
      await expect(
        service.getVote({ congress: 118, session: 2, voteNumber: 1 }, createMockContext()),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('singleton', () => {
    it('initializes and returns the service', () => {
      expect(() => initSenateVoteService()).not.toThrow();
      expect(() => getSenateVoteService()).not.toThrow();
    });
  });
});

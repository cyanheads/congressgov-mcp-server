/**
 * @fileoverview Tests for SenateVoteService — URL construction, ordering, client-side
 * pagination, the "200 HTML page means not found" behavior of the Senate host, and
 * how a refusal (403) differs from an outage (5xx, timeout).
 * @module tests/services/senate-lis/senate-vote-service.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rollVotesTool } from '@/mcp-server/tools/definitions/roll-votes.tool.js';
import {
  getSenateVoteService,
  initSenateVoteService,
  SenateVoteService,
} from '@/services/senate-lis/senate-vote-service.js';
import {
  CALL_BUDGET_MS,
  CLIENT_TIMEOUT_MS,
  contentText,
  stalledHeadersFetch,
  track,
  useFakeClock,
} from '../../helpers/budget-fixtures.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const MENU = fixture('menu.xml');
const CLOTURE = fixture('vote-cloture.xml');
/** A session whose last two votes were cast on January 1 of the following year. */
const ROLLOVER = fixture('menu-116-2-rollover.xml');

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
      expect(String(mockFetch.mock.calls[0]![0])).toBe(
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

    it('resolves the same calendar date under either order and at any offset', async () => {
      mockFetch.mockResolvedValue(xmlResponse(ROLLOVER));
      const page = (order: 'recent' | 'oldest', offset: number, limit = 4) =>
        service.listVotes({ congress: 116, session: 2, order, limit, offset }, createMockContext());

      const newest = await page('recent', 0);
      expect(newest.data.map((v) => [v.voteNumber, v.voteDateIso])).toEqual([
        [292, '2021-01-01'],
        [291, '2021-01-01'],
        [290, '2020-12-30'],
        [289, '2020-12-21'],
      ]);

      const oldest = await page('oldest', 0);
      expect(oldest.data.map((v) => [v.voteNumber, v.voteDateIso])).toEqual([
        [1, '2020-01-06'],
        [33, '2020-02-05'],
        [63, '2020-03-02'],
        [81, '2020-05-04'],
      ]);

      /** The tail of the ascending pages is the head of the descending one, reversed. */
      const lastAscending = await page('oldest', 11);
      expect(lastAscending.data.map((v) => [v.voteNumber, v.voteDateIso])).toEqual([
        [289, '2020-12-21'],
        [290, '2020-12-30'],
        [291, '2021-01-01'],
        [292, '2021-01-01'],
      ]);
      expect(lastAscending.pagination).toEqual({ count: 15, nextOffset: null });

      const middle = await page('recent', 5, 2);
      expect(middle.data.map((v) => [v.voteNumber, v.voteDateIso])).toEqual([
        [225, '2020-11-09'],
        [200, '2020-10-01'],
      ]);
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

    it('names the feed coverage in the not-found message', async () => {
      mockFetch.mockResolvedValue(xmlResponse(HTML_404_PAGE));
      const error = (await service
        .listVotes(
          { congress: 100, session: 2, order: 'recent', limit: 5, offset: 0 },
          createMockContext(),
        )
        .catch((e: unknown) => e)) as McpError;
      expect(error.message).toBe(
        'No Senate roll call votes found for the 100th Congress, session 2. Valid sessions are 1 and 2; the Senate publishes roll call votes from the 101st Congress (1989) onward.',
      );
    });
  });

  describe('get', () => {
    it('builds the vote URL with a zero-padded roll number', async () => {
      mockFetch.mockResolvedValue(xmlResponse(CLOTURE));
      await service.getVote({ congress: 118, session: 2, voteNumber: 1 }, createMockContext());
      expect(String(mockFetch.mock.calls[0]![0])).toBe(
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
    it('preserves in-flight caller cancellation without retrying', async () => {
      const controller = new AbortController();
      mockFetch.mockImplementation(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
            queueMicrotask(() => controller.abort());
          }),
      );
      await expect(
        service.getVote(
          { congress: 118, session: 2, voteNumber: 1 },
          { ...createMockContext(), signal: controller.signal },
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('does not retry an upstream 501 declared non-retryable', async () => {
      mockFetch.mockResolvedValue(xmlResponse('Not Implemented', 501));
      await expect(
        service.getVote({ congress: 118, session: 2, voteNumber: 1 }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_error', retryable: false },
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

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
      vi.useFakeTimers();
      try {
        mockFetch.mockRejectedValue(new Error('socket hang up'));
        const outcome = expect(
          service.getVote({ congress: 118, session: 2, voteNumber: 1 }, createMockContext()),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
        await vi.runAllTimersAsync();
        await outcome;
        expect(mockFetch).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    describe('senate.gov refusals and outages (issue #89)', () => {
      /** What senate.gov's firewall serves a non-browser client, trimmed. */
      const AKAMAI_403_PAGE =
        '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1>You don\'t have permission to access "http://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_2.xml" on this server.</BODY></HTML>';
      const REFUSED_MESSAGE = 'senate.gov refused the request for the Senate LIS feed (HTTP 403).';
      const REFUSED_HINT =
        "Senate roll call votes cannot be retrieved while senate.gov refuses automated requests; House votes (chamber 'house') are unaffected.";
      /** The retry loop appends the attempt count once it gives up. */
      const UNAVAILABLE_MESSAGE =
        'The Senate.gov LIS feed is temporarily unavailable. (failed after 3 attempts)';
      const UNAVAILABLE_HINT =
        'Retry after a short delay; the Senate.gov LIS feed may be temporarily unavailable.';

      /** Serve `respond` for senate.gov requests; count them. */
      let senateHits = 0;
      function serveSenate(respond: (init: RequestInit) => Promise<unknown>) {
        senateHits = 0;
        mockFetch.mockImplementation((url: string | URL, init: RequestInit) => {
          if (new URL(String(url)).hostname !== 'www.senate.gov') {
            return Promise.reject(new Error(`unexpected host in ${String(url)}`));
          }
          senateHits++;
          return respond(init);
        });
      }

      /** Settle `promise` with fake time run out, so retry backoff and deadlines elapse without waiting. */
      async function settle(promise: Promise<unknown>): Promise<McpError> {
        const outcome = promise.then(
          () => {
            throw new Error('expected the call to fail');
          },
          (error: unknown) => error as McpError,
        );
        await vi.runAllTimersAsync();
        return outcome;
      }

      const listMenu = () =>
        service.listVotes(
          { congress: 119, session: 2, order: 'recent', limit: 5, offset: 0 },
          createMockContext(),
        );

      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('fails a 403 refusal on the first attempt, non-retryable, without the URL', async () => {
        serveSenate(async () => xmlResponse(AKAMAI_403_PAGE, 403));
        const error = await settle(listMenu());
        expect(senateHits).toBe(1);
        expect(error.message).toBe(REFUSED_MESSAGE);
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_error', retryable: false, recovery: { hint: REFUSED_HINT } },
        });
        for (const text of [error.message, JSON.stringify(error.data)]) {
          expect(text).not.toContain('legislative/LIS');
          expect(text).not.toContain('vote_menu');
        }
      });

      it.each([
        ['a 503', async () => xmlResponse('Service Unavailable', 503)],
        [
          /** Never answers; rejects only when fetchWithTimeout's deadline aborts the request. */
          'a request timeout',
          (init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            }),
        ],
      ])('retries %s and keeps the temporarily-unavailable wording', async (_label, respond) => {
        serveSenate(respond);
        const error = await settle(listMenu());
        expect(senateHits).toBe(3);
        expect(error.message).toBe(UNAVAILABLE_MESSAGE);
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_error', recovery: { hint: UNAVAILABLE_HINT } },
        });
        expect(error.data?.retryable).toBeUndefined();
      });

      it('reports the refusal on both surfaces of congressgov_roll_votes', async () => {
        initSenateVoteService();
        serveSenate(async () => xmlResponse(AKAMAI_403_PAGE, 403));
        const pending = runToolContract(rollVotesTool, {
          operation: 'list',
          chamber: 'senate',
          congress: 119,
          session: 2,
        });
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(senateHits).toBe(1);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ServiceUnavailable,
            message: REFUSED_MESSAGE,
            data: { reason: 'upstream_error', retryable: false, recovery: { hint: REFUSED_HINT } },
          },
        });
        const content = contentText(result);
        expect(content).toContain(REFUSED_MESSAGE);
        expect(content).toContain(REFUSED_HINT);
        expect(content).not.toContain('legislative/LIS');
      });
    });
  });

  /**
   * Every request a call makes spends one budget counted from the call's start.
   * The mechanism is tabled in tests/services/call-budget.test.ts; these cases
   * prove this service's wiring and its unbudgeted path.
   */
  describe('call budget', () => {
    const getVote = (ctx?: ReturnType<typeof createMockContext>) =>
      service.getVote({ congress: 118, session: 2, voteNumber: 1 }, ctx);

    beforeEach(() => {
      useFakeClock();
      mockFetch.mockImplementation(stalledHeadersFetch);
    });
    afterEach(() => vi.useRealTimers());

    it('clamps the attempt to what the call has left and settles at the budget', async () => {
      const ctx = createMockContext();
      const start = Date.now();
      /** Earlier requests in the same call spent 45 s. */
      await vi.advanceTimersByTimeAsync(45_000);
      const call = track(getVote(ctx));
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);

      expect(call.state.settledAt).toBe(start + CALL_BUDGET_MS);
      expect(call.state.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: {
          reason: 'upstream_timeout',
          budgetMs: CALL_BUDGET_MS,
          retryAttempts: 1,
          recovery: {
            hint: 'Retry after a short delay; the Senate.gov LIS feed may be temporarily unavailable.',
          },
        },
      });
      expect((call.state.error as McpError).message).toBe(
        "senate.gov did not deliver the Senate LIS feed within this call's 50-second budget for upstream requests (1 attempt).",
      );
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('runs three full 12 s attempts when no call stands behind the request', async () => {
      const start = Date.now();
      const call = track(getVote());
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);

      expect(call.state.error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_error' },
      });
      /** 3 × 12 s plus two backoffs of 1 s and 2 s, each ±25% jitter. */
      const elapsed = (call.state.settledAt as number) - start;
      expect(elapsed).toBeGreaterThanOrEqual(36_000 + 2_250);
      expect(elapsed).toBeLessThanOrEqual(36_000 + 3_750);
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

/**
 * @fileoverview Tests for SenateVoteService — URL construction, ordering, client-side
 * pagination, the "200 HTML page means not found" behavior of the Senate host, and
 * which LIS failures fall back to Voteview's files and which stay the call's answer.
 * @module tests/services/senate-lis/senate-vote-service.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
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
  retryAfterResponse,
  stalledHeadersFetch,
  track,
  useFakeClock,
} from '../../helpers/budget-fixtures.js';
import {
  CAPTURED_SOURCE_119,
  cutOffResponse,
  neverAnswers,
  type Responder,
  routeFetch,
  SENATE_FIREWALL_PAGE,
  SENATE_HOST,
  textResponse,
  VOTEVIEW_HOST,
  voteviewFileUrls,
  voteviewServing,
} from './voteview-fixtures.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const MENU = fixture('menu.xml');
const CLOTURE = fixture('vote-cloture.xml');
/** A session whose last two votes were cast on January 1 of the following year. */
const ROLLOVER = fixture('menu-116-2-rollover.xml');

/** A 200 HTML error page — what Senate.gov serves for an unknown congress/session/vote. */
const HTML_404_PAGE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"><html><head><title>Page Not Found</title></head><body>Not found</body></html>';

/** The page senate.gov's CDN (Akamai) serves a refused client, trimmed. */
const ACCESS_DENIED_PAGE =
  '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1>You don\'t have permission to access "http://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_2.xml" on this server.</BODY></HTML>';

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

  /**
   * When the LIS feed can't answer, Voteview's files answer the call instead
   * (issue #90). Each case stubs what senate.gov and voteview.com answer and
   * checks the outcome and every request each host received.
   */
  describe('falling back to Voteview', () => {
    let router: ReturnType<typeof routeFetch>;

    function serve(lis: Responder, voteview: Responder = voteviewServing()): void {
      router = routeFetch({ [SENATE_HOST]: lis, [VOTEVIEW_HOST]: voteview });
      vi.stubGlobal('fetch', router.fetch);
    }
    const voteviewRequests = () =>
      router.requests
        .filter((url) => url.hostname === VOTEVIEW_HOST)
        .map(String)
        .sort();
    const ALL_119_FILES = voteviewFileUrls(119).sort();

    /** Settle `promise` with fake time run out, so backoff and deadlines elapse without waiting. */
    async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: McpError }> {
      const outcome = promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error: error as McpError }),
      );
      await vi.runAllTimersAsync();
      return outcome;
    }

    const LIST_119_2 = {
      congress: 119,
      session: 2,
      order: 'recent',
      limit: 5,
      offset: 0,
    } as const;
    const VOTE_119_2_256 = { congress: 119, session: 2, voteNumber: 256 } as const;
    const refused = async () => textResponse(SENATE_FIREWALL_PAGE, 403);

    beforeEach(() => {
      vi.useFakeTimers();
      /** Whether a congress has ended is read from the clock: hold it at the capture date. */
      vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    describe('the feed answering', () => {
      it('lists from one senate.gov request, asks Voteview nothing, and carries no source', async () => {
        serve(async () => xmlResponse(MENU));
        const { value } = await settle(
          service.listVotes(
            { congress: 118, session: 2, order: 'recent', limit: 2, offset: 0 },
            createMockContext(),
          ),
        );
        expect(Object.keys(value ?? {})).toEqual(['chamber', 'data', 'pagination']);
        expect(value?.pagination).toEqual({ count: 4, nextOffset: 2 });
        expect(router.hits(SENATE_HOST)).toBe(1);
        expect(router.hits(VOTEVIEW_HOST)).toBe(0);
      });

      it('gets and pages members from one senate.gov request each, without Voteview', async () => {
        serve(async () => xmlResponse(CLOTURE));
        const vote = await settle(
          service.getVote({ congress: 118, session: 2, voteNumber: 1 }, createMockContext()),
        );
        expect(Object.keys(vote.value ?? {})).toEqual(['chamber', 'vote']);
        const members = await settle(
          service.getVoteMembers(
            { congress: 118, session: 2, voteNumber: 1, limit: 3, offset: 0 },
            createMockContext(),
          ),
        );
        expect(Object.keys(members.value ?? {})).toEqual(['chamber', 'data', 'vote', 'pagination']);
        expect(router.hits(SENATE_HOST)).toBe(2);
        expect(router.hits(VOTEVIEW_HOST)).toBe(0);
      });
    });

    describe('the feed unable to answer', () => {
      /** What the feed answers, and how many attempts it gets before the call falls back. */
      const CANNOT_ANSWER: ReadonlyArray<readonly [string, Responder, number]> = [
        ['its firewall page with HTTP 200', async () => textResponse(SENATE_FIREWALL_PAGE), 1],
        ['its firewall page with HTTP 403', refused, 1],
        [
          "its CDN's Access Denied page with HTTP 200",
          async () => textResponse(ACCESS_DENIED_PAGE),
          1,
        ],
        [
          "its CDN's Access Denied page with HTTP 403",
          async () => textResponse(ACCESS_DENIED_PAGE, 403),
          1,
        ],
        ['HTTP 404', async () => textResponse('Not Found', 404), 3],
        ['HTTP 400', async () => textResponse('Bad Request', 400), 3],
        ['HTTP 503', async () => textResponse('Service Unavailable', 503), 3],
        ['HTTP 501, declared not retryable', async () => textResponse('Not Implemented', 501), 1],
        ['attempt timeouts', neverAnswers, 3],
        [
          'a network error',
          async () => {
            throw new TypeError('fetch failed');
          },
          3,
        ],
        ['an empty body', async () => textResponse(''), 1],
      ];

      it.each(CANNOT_ANSWER)('lists from Voteview after %s', async (_label, lis, attempts) => {
        serve(lis);
        const { value, error } = await settle(service.listVotes(LIST_119_2, createMockContext()));
        expect(error).toBeUndefined();
        expect(value?.data.map((row) => row.voteNumber)).toEqual([256, 255, 254]);
        expect(value?.data[0]).toEqual({
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
        expect(value?.pagination).toEqual({ count: 3, nextOffset: null });
        expect(value?.source).toEqual(CAPTURED_SOURCE_119);
        expect(router.hits(SENATE_HOST)).toBe(attempts);
        expect(voteviewRequests()).toEqual(ALL_119_FILES);
      });

      it("gets a vote from Voteview, its party totals derived from Voteview's roster", async () => {
        serve(refused);
        const { value } = await settle(service.getVote(VOTE_119_2_256, createMockContext()));
        expect(value).toEqual({
          chamber: 'senate',
          vote: {
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
            partyTotals: [
              { party: 'R', yea: 47, nay: 0, present: 0, notVoting: 6 },
              { party: 'D', yea: 0, nay: 39, present: 0, notVoting: 6 },
              { party: 'I', yea: 0, nay: 2, present: 0, notVoting: 0 },
            ],
          },
          source: CAPTURED_SOURCE_119,
        });
        expect(router.hits(SENATE_HOST)).toBe(1);
        expect(voteviewRequests()).toEqual(ALL_119_FILES);
      });

      it('pages members from Voteview, each keyed by bioguide ID', async () => {
        serve(refused);
        const { value } = await settle(
          service.getVoteMembers({ ...VOTE_119_2_256, limit: 3, offset: 0 }, createMockContext()),
        );
        expect(value?.data).toEqual([
          {
            chamber: 'senate',
            name: 'ALSOBROOKS, Angela Deneece',
            party: 'D',
            state: 'MD',
            voteCast: 'Nay',
            bioguideId: 'A000382',
          },
          {
            chamber: 'senate',
            name: 'ARMSTRONG, Alan',
            party: 'R',
            state: 'OK',
            voteCast: 'Yea',
            bioguideId: 'A000383',
          },
          {
            chamber: 'senate',
            name: 'BALDWIN, Tammy',
            party: 'D',
            state: 'WI',
            voteCast: 'Nay',
            bioguideId: 'B001230',
          },
        ]);
        expect(value?.pagination).toEqual({ count: 100, nextOffset: 3 });
        expect(value?.vote).toMatchObject({ voteNumber: 256, count: { yeas: 47, nays: 41 } });
        expect(value?.vote.partyTotals).toBeUndefined();
        expect(value?.source).toEqual(CAPTURED_SOURCE_119);
      });

      it('reads the congress from Voteview once for list, get, and members in turn', async () => {
        serve(refused);
        const ctx = () => createMockContext();
        await settle(service.listVotes(LIST_119_2, ctx()));
        await settle(service.getVote(VOTE_119_2_256, ctx()));
        await settle(service.getVoteMembers({ ...VOTE_119_2_256, limit: 5, offset: 0 }, ctx()));
        expect(router.hits(SENATE_HOST)).toBe(3);
        expect(voteviewRequests()).toEqual(ALL_119_FILES);
      });

      it("answers a vote Voteview lacks with Voteview's not-found, naming its latest vote", async () => {
        serve(refused);
        const { error } = await settle(
          service.getVote({ congress: 119, session: 2, voteNumber: 257 }, createMockContext()),
        );
        expect(error?.code).toBe(JsonRpcErrorCode.NotFound);
        expect(error?.message).toBe(
          "Senate roll call vote 257 of the 119th Congress, session 2 is not in Voteview, which serves Senate votes while the Senate LIS feed can't be read. Its latest Senate vote for the 119th Congress is session 2 vote 256 (2026-09-30); it adds votes after the Senate takes them.",
        );
        expect(error?.data).toMatchObject({
          latestVote: { session: 2, voteNumber: 256, date: '2026-09-30' },
          reason: 'not_found',
        });
      });
    });

    describe('answers and ends that never fall back', () => {
      it("keeps the feed's not-found page as not found, asking Voteview nothing", async () => {
        serve(async () => xmlResponse(HTML_404_PAGE));
        const { error } = await settle(
          service.getVote({ congress: 119, session: 2, voteNumber: 999 }, createMockContext()),
        );
        expect(error?.code).toBe(JsonRpcErrorCode.NotFound);
        expect(error?.message).toBe(
          'Senate roll call vote 999 was not found in the 119th Congress, session 2.',
        );
        expect(router.hits(SENATE_HOST)).toBe(1);
        expect(router.hits(VOTEVIEW_HOST)).toBe(0);
      });

      it('keeps a caller cancellation as cancelled, asking Voteview nothing', async () => {
        const controller = new AbortController();
        serve((_url, init) => {
          queueMicrotask(() => controller.abort());
          return neverAnswers(_url, init);
        });
        const { error } = await settle(
          service.getVote(VOTE_119_2_256, createMockContext({ signal: controller.signal })),
        );
        expect(error?.code).toBe(JsonRpcErrorCode.RequestCancelled);
        expect(router.hits(SENATE_HOST)).toBe(1);
        expect(router.hits(VOTEVIEW_HOST)).toBe(0);
      });

      it("keeps a spent call budget as the budget's timeout, asking Voteview nothing", async () => {
        serve(neverAnswers);
        const ctx = createMockContext();
        /** Earlier requests in the same call spent 45 s; the one feed attempt left is clamped to 5 s. */
        await vi.advanceTimersByTimeAsync(45_000);
        const { error } = await settle(service.getVote(VOTE_119_2_256, ctx));
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.Timeout,
          data: { reason: 'upstream_timeout', budgetMs: CALL_BUDGET_MS },
        });
        expect(router.hits(SENATE_HOST)).toBe(1);
        expect(router.hits(VOTEVIEW_HOST)).toBe(0);
      });

      /**
       * Voteview is consulted only for congresses the feed publishes, so a congress
       * before the 101st keeps the feed's own failure, refusal and outage alike.
       */
      describe('a congress before the feed publishes votes', () => {
        const REFUSED_MESSAGE =
          'senate.gov refused the request for the Senate LIS feed (HTTP 403).';
        const REFUSED_HINT =
          "Senate roll call votes cannot be retrieved while senate.gov refuses automated requests; House votes (chamber 'house') are unaffected.";
        /** The retry loop appends the attempt count once it gives up. */
        const UNAVAILABLE_MESSAGE =
          'The Senate.gov LIS feed is temporarily unavailable. (failed after 3 attempts)';
        const UNAVAILABLE_HINT =
          'Retry after a short delay; the Senate.gov LIS feed may be temporarily unavailable.';
        const listMenu100 = () =>
          service.listVotes(
            { congress: 100, session: 2, order: 'recent', limit: 5, offset: 0 },
            createMockContext(),
          );

        it('keeps a 403 refusal: one attempt, not retryable, without the URL', async () => {
          serve(refused);
          const { error } = await settle(listMenu100());
          expect(router.hits(SENATE_HOST)).toBe(1);
          expect(router.hits(VOTEVIEW_HOST)).toBe(0);
          expect(error?.message).toBe(REFUSED_MESSAGE);
          expect(error).toMatchObject({
            code: JsonRpcErrorCode.ServiceUnavailable,
            data: { reason: 'upstream_error', retryable: false, recovery: { hint: REFUSED_HINT } },
          });
          for (const text of [error?.message, JSON.stringify(error?.data)]) {
            expect(text).not.toContain('legislative/LIS');
            expect(text).not.toContain('vote_menu');
          }
        });

        it.each([
          ['a 503', async () => textResponse('Service Unavailable', 503)],
          ['a request timeout', neverAnswers],
        ] as const)(
          'retries %s and keeps the temporarily-unavailable wording',
          async (_label, lis) => {
            serve(lis);
            const { error } = await settle(listMenu100());
            expect(router.hits(SENATE_HOST)).toBe(3);
            expect(router.hits(VOTEVIEW_HOST)).toBe(0);
            expect(error?.message).toBe(UNAVAILABLE_MESSAGE);
            expect(error).toMatchObject({
              code: JsonRpcErrorCode.ServiceUnavailable,
              data: { reason: 'upstream_error', recovery: { hint: UNAVAILABLE_HINT } },
            });
            expect(error?.data?.retryable).toBeUndefined();
          },
        );
      });
    });

    /**
     * While senate.gov refuses automated clients, every Senate call meets a 403.
     * One the call falls back from is expected, not an error to page anyone over.
     */
    describe('logging a refusal', () => {
      const spies: Array<{ mockRestore: () => void }> = [];
      afterEach(() => {
        for (const spy of spies.splice(0)) spy.mockRestore();
      });
      function spyOnLogger(level: 'debug' | 'error') {
        const spy = vi.spyOn(logger, level);
        spies.push(spy);
        return spy;
      }
      /** `fetchWithTimeout`'s line for a non-2xx, its body under `extra.responseBody`. */
      const FETCH_LINE = 'Fetch failed for https://www.senate.gov/… with status 403.';
      const FETCH_FIELDS = expect.objectContaining({
        extra: expect.objectContaining({ statusCode: 403, responseBody: ACCESS_DENIED_PAGE }),
      });

      it('logs a refusal it falls back from at notice, with no error line and no page body', async () => {
        const error = spyOnLogger('error');
        const debug = spyOnLogger('debug');
        serve(async () => textResponse(ACCESS_DENIED_PAGE, 403));
        const ctx = createMockContext();
        const { value } = await settle(service.listVotes(LIST_119_2, ctx));
        expect(value?.source).toEqual(CAPTURED_SOURCE_119);

        expect(error).not.toHaveBeenCalled();
        expect(debug).toHaveBeenCalledWith(FETCH_LINE, FETCH_FIELDS);
        const calls = (ctx.log as MockContextLogger).calls;
        expect(calls).toEqual([
          {
            level: 'notice',
            msg: 'Senate LIS feed could not be read; serving the call from Voteview.',
            data: {
              congress: 119,
              url: 'https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_2.xml',
              status: 403,
              lisError: 'senate.gov refused the request for the Senate LIS feed (HTTP 403).',
            },
          },
        ]);
      });

      it('keeps a refusal it does not fall back from at error', async () => {
        const error = spyOnLogger('error');
        serve(async () => textResponse(ACCESS_DENIED_PAGE, 403));
        const ctx = createMockContext();
        await settle(
          service.listVotes(
            { congress: 100, session: 2, order: 'recent', limit: 5, offset: 0 },
            ctx,
          ),
        );
        expect(error).toHaveBeenCalledWith(FETCH_LINE, FETCH_FIELDS);
        expect((ctx.log as MockContextLogger).calls).toEqual([]);
      });
    });

    describe('the feed and Voteview both failing', () => {
      const BOTH_MESSAGE =
        'The Senate LIS feed could not be read, and Voteview, the source this server falls back to, is unavailable too.';
      const BOTH_HINT = "Retry after a short delay; House votes (chamber 'house') are unaffected.";

      it.each([
        ['unavailable', async () => textResponse('Service Unavailable', 503), undefined],
        [
          'serving files in another format',
          voteviewServing({ 'S119_votes.csv': SENATE_FIREWALL_PAGE }),
          false,
        ],
        [
          'breaking its files off mid-body',
          async () => cutOffResponse('congress,chamber,rollnumber\n119,Senate,1\n'),
          undefined,
        ],
      ] as const)('reports both when Voteview is %s', async (_label, voteview, retryable) => {
        serve(refused, voteview);
        const { error } = await settle(service.listVotes(LIST_119_2, createMockContext()));
        expect(error?.message).toBe(BOTH_MESSAGE);
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_error', recovery: { hint: BOTH_HINT } },
        });
        expect(error?.data?.retryable).toBe(retryable);
        expect(router.hits(SENATE_HOST)).toBe(1);
        expect(router.hits(VOTEVIEW_HOST)).toBeGreaterThanOrEqual(3);
      });

      it("reports Voteview's own timeouts inside the budget as both failing, not as the budget's end", async () => {
        /** The refusal arrives after 300 ms; Voteview never answers. */
        serve(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve(textResponse(SENATE_FIREWALL_PAGE, 403)), 300),
            ),
          neverAnswers,
        );
        const ctx = createMockContext();
        const start = Date.now();
        const call = track(service.listVotes(LIST_119_2, ctx));
        await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);

        expect((call.state.settledAt as number) - start).toBeLessThan(CALL_BUDGET_MS);
        expect((call.state.error as McpError).message).toBe(BOTH_MESSAGE);
        expect(call.state.error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
        /** Two 20 s attempts at each of the three files. */
        expect(router.hits(VOTEVIEW_HOST)).toBe(6);
      });

      it('reports both on both surfaces of congressgov_roll_votes', async () => {
        initSenateVoteService();
        serve(refused, async () => textResponse('Service Unavailable', 503));
        const pending = runToolContract(rollVotesTool, {
          operation: 'list',
          chamber: 'senate',
          congress: 119,
          session: 2,
        });
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ServiceUnavailable,
            message: BOTH_MESSAGE,
            data: { reason: 'upstream_error', recovery: { hint: BOTH_HINT } },
          },
        });
        const content = contentText(result);
        expect(content).toContain(BOTH_MESSAGE);
        expect(content).toContain(BOTH_HINT);
        expect(content).not.toContain('legislative/LIS');
        expect(content).not.toContain('static/data/out');
      });
    });

    /** A 429 is never retried: it surfaces as Voteview's rate limit, not as Voteview being unavailable. */
    describe('Voteview rate-limiting the fallback', () => {
      const RATE_LIMITED_MESSAGE =
        "Voteview, which serves Senate votes while the Senate LIS feed can't be read, is rate-limiting this server (HTTP 429, Retry-After 30).";
      const RATE_LIMITED_DATA = {
        reason: 'rate_limited',
        retryAfter: '30',
        recovery: {
          hint: "Follow Retry-After when supplied, otherwise wait before retrying; House votes (chamber 'house') are unaffected.",
        },
      };
      const rateLimiting = async () => retryAfterResponse(429, 30);

      it('fails as rate-limited after one request per file, Retry-After intact', async () => {
        serve(refused, rateLimiting);
        const { error } = await settle(service.getVote(VOTE_119_2_256, createMockContext()));
        expect(error).toBeInstanceOf(McpError);
        expect(error?.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(error?.message).toBe(RATE_LIMITED_MESSAGE);
        expect(error?.data).toEqual(RATE_LIMITED_DATA);
        expect(router.hits(SENATE_HOST)).toBe(1);
        expect(voteviewRequests()).toEqual(ALL_119_FILES);
      });

      it('returns the rate limit on both surfaces of congressgov_roll_votes', async () => {
        initSenateVoteService();
        serve(refused, rateLimiting);
        const pending = runToolContract(rollVotesTool, {
          operation: 'list',
          chamber: 'senate',
          congress: 119,
          session: 2,
        });
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual({
          error: {
            code: JsonRpcErrorCode.RateLimited,
            message: RATE_LIMITED_MESSAGE,
            data: RATE_LIMITED_DATA,
          },
        });
        const content = contentText(result);
        expect(content).toContain(RATE_LIMITED_MESSAGE);
        expect(content).toContain(RATE_LIMITED_DATA.recovery.hint);
        expect(content).not.toContain('static/data/out');
      });
    });
  });

  /**
   * Every request a call makes spends one budget counted from the call's start.
   * The mechanism is tabled in tests/services/call-budget.test.ts; these cases
   * prove this service's wiring, its unbudgeted path, and where the fallback to
   * Voteview lands inside the budget.
   */
  describe('call budget', () => {
    const getVote = (ctx?: ReturnType<typeof createMockContext>) =>
      service.getVote({ congress: 119, session: 2, voteNumber: 256 }, ctx);

    /** senate.gov never answers; Voteview answers as `voteview` does, noting when it is first asked. */
    function serve(voteview: Responder) {
      const asked: { at?: number } = {};
      const router = routeFetch({
        [SENATE_HOST]: neverAnswers,
        [VOTEVIEW_HOST]: (url, init) => {
          asked.at ??= Date.now();
          return voteview(url, init);
        },
      });
      vi.stubGlobal('fetch', router.fetch);
      return { router, asked };
    }

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
      expect(new URL(String(mockFetch.mock.calls[0]![0])).hostname).toBe(SENATE_HOST);
    });

    it('falls back after three timed-out feed attempts with over 10 s of the budget left', async () => {
      const { router, asked } = serve(voteviewServing());
      const ctx = createMockContext();
      const start = Date.now();
      const call = track(getVote(ctx));
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);

      expect(call.state.value?.source).toEqual(CAPTURED_SOURCE_119);
      expect(router.hits(SENATE_HOST)).toBe(3);
      /** 3 × 12 s attempts and backoffs of 1 s and 2 s, each ±25% jitter. */
      const spent = (asked.at as number) - start;
      expect(spent).toBeGreaterThanOrEqual(36_000 + 2_250);
      expect(spent).toBeLessThanOrEqual(36_000 + 3_750);
      expect(CALL_BUDGET_MS - spent).toBeGreaterThanOrEqual(10_250);
      expect(call.state.settledAt).toBe(asked.at);
    });

    it('ends the call at its budget when Voteview is slow too, naming Voteview', async () => {
      const { router } = serve(neverAnswers);
      const ctx = createMockContext();
      const start = Date.now();
      const call = track(getVote(ctx));
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);

      expect(call.state.settledAt).toBe(start + CALL_BUDGET_MS);
      expect(call.state.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'upstream_timeout', budgetMs: CALL_BUDGET_MS, retryAttempts: 1 },
      });
      expect((call.state.error as McpError).message).toBe(
        "Voteview did not deliver the Senate vote files for the 119th Congress within this call's 50-second budget for upstream requests (1 attempt).",
      );
      expect(router.hits(SENATE_HOST)).toBe(3);
      expect(router.hits(VOTEVIEW_HOST)).toBe(3);
    });

    it('runs three full 12 s feed attempts when no call stands behind the request, then reads Voteview', async () => {
      const { router, asked } = serve(voteviewServing());
      const start = Date.now();
      const call = track(getVote());
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);

      expect(call.state.value).toMatchObject({
        vote: { voteNumber: 256, count: { yeas: 47, nays: 41 } },
        source: CAPTURED_SOURCE_119,
      });
      /** 3 × 12 s plus two backoffs of 1 s and 2 s, each ±25% jitter. */
      const elapsed = (asked.at as number) - start;
      expect(elapsed).toBeGreaterThanOrEqual(36_000 + 2_250);
      expect(elapsed).toBeLessThanOrEqual(36_000 + 3_750);
      expect(router.hits(SENATE_HOST)).toBe(3);
      expect(router.hits(VOTEVIEW_HOST)).toBe(3);
    });
  });

  describe('singleton', () => {
    it('initializes and returns the service', () => {
      expect(() => initSenateVoteService()).not.toThrow();
      expect(() => getSenateVoteService()).not.toThrow();
    });
  });
});

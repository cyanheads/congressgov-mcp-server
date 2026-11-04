/**
 * @fileoverview Senate LIS roll-call vote client — fetch, retry, XML parse, normalize.
 *
 * The Congress.gov API v3 exposes House votes only (validated 2026-05-31: the
 * `/senate-vote/...` namespace 404s). Senate roll call votes are published by the
 * Senate's official LIS XML feed, which has no API key and no JSON. This service
 * fetches and normalizes that feed into the same list/detail/members envelopes the
 * House path returns, so a single tool can serve both chambers.
 *
 * Two endpoints back the three operations:
 * - Session menu → `list` (the whole session is one file; paginate client-side).
 * - Individual vote → `get` (metadata + derived party totals) and `members`
 *   (the roster from the same file; paginate client-side).
 *
 * The host returns HTTP 200 with an HTML error page for unknown congress/session/
 * vote, so "not found" is detected from the body, not the status code.
 *
 * When the feed can't answer — senate.gov refuses automated clients with HTTP 403,
 * and a 5xx, timeout, or empty body leaves it unread just the same — every
 * operation is served from Voteview's per-congress files (`VoteviewSource`) under
 * the same call budget, and the result carries a `source` naming Voteview and its
 * latest vote. The feed's own "not found", a caller's cancellation, and a spent
 * budget are answers or ends, not failures to work around: none of them falls back.
 *
 * @module services/senate-lis/senate-vote-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import {
  defaultIsTransient,
  fetchWithTimeout,
  requestContextService,
} from '@cyanheads/mcp-ts-core/utils';
import { type BudgetedAttempt, withCallBudget } from '@/services/call-budget.js';
import { ordinal } from '@/utils/congress-calendar.js';
import {
  computePartyTotals,
  parseRollCallVote,
  parseVoteMenu,
  SENATE_VOTE_COVERAGE,
  SENATE_VOTE_FIRST_CONGRESS,
} from './parse.js';
import type {
  ParsedRollCallVote,
  SenateMemberVote,
  SenateVoteDetail,
  SenateVoteSource,
  SenateVoteSummary,
} from './types.js';
import { UNAVAILABLE_RECOVERY, VoteviewSource } from './voteview-source.js';

const DEFAULT_BASE_URL = 'https://www.senate.gov/legislative/LIS';
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;

/** A 200 response whose body is an HTML page (the host's "not found" surface). */
const HTML_RESPONSE_RE = /^\s*<(!DOCTYPE|html[\s>])/i;
/**
 * The pages senate.gov serves the clients it refuses: its firewall's ("Senate.gov
 * - Unauthorized") and its CDN's ("Access Denied"), each seen with HTTP 403 in
 * November 2026. Served with a 200, either is still a refusal, not the host's
 * page for an unknown vote.
 */
const REFUSAL_PAGE_RE = /<title>\s*(?:Senate\.gov - Unauthorized|Access Denied)\s*<\/title>/i;
/** A valid feed body opens with one of these roots once the XML declaration is past. */
const FEED_ROOT_RE = /<(vote_summary|roll_call_vote)[\s>]/;

const NOT_FOUND_RECOVERY = {
  reason: 'not_found',
  recovery: {
    hint: "Use operation 'list' with chamber 'senate' to find valid vote numbers for the congress and session, then retry.",
  },
} as const;
/**
 * senate.gov's firewall answers non-browser clients with HTTP 403. A retry meets
 * the same refusal, so it fails on the first attempt and says so, rather than
 * reading as a brief outage.
 */
const REFUSED_RECOVERY = {
  reason: 'upstream_error',
  retryable: false,
  recovery: {
    hint: "Senate roll call votes cannot be retrieved while senate.gov refuses automated requests; House votes (chamber 'house') are unaffected.",
  },
} as const;
const UPSTREAM_ERROR_RECOVERY = {
  reason: 'upstream_error',
  recovery: {
    hint: 'Retry after a short delay; the Senate.gov LIS feed may be temporarily unavailable.',
  },
} as const;

interface ListVotesParams {
  congress: number;
  limit: number;
  offset: number;
  order: 'recent' | 'oldest';
  session: number;
}
interface GetVoteParams {
  congress: number;
  session: number;
  voteNumber: number;
}
interface GetVoteMembersParams extends GetVoteParams {
  limit: number;
  offset: number;
}

type Pagination = {
  count: number;
  nextOffset: number | null;
};
/** `source` is present only when Voteview served the call. */
export type SenateVoteListResult = {
  chamber: 'senate';
  data: SenateVoteSummary[];
  pagination: Pagination;
  source?: SenateVoteSource;
};
export type SenateVoteDetailResult = {
  chamber: 'senate';
  vote: SenateVoteDetail;
  source?: SenateVoteSource;
};
export type SenateVoteMembersResult = {
  chamber: 'senate';
  data: SenateMemberVote[];
  vote: SenateVoteDetail;
  pagination: Pagination;
  source?: SenateVoteSource;
};

/**
 * Whether the LIS feed failed to answer at all — a refusal, an outage, a timeout
 * the retries could not outlast, an empty body — as distinct from answering
 * "not found", the caller cancelling, or the call's budget running out.
 */
function lisCouldNotAnswer(error: unknown): error is McpError {
  return error instanceof McpError && error.code === JsonRpcErrorCode.ServiceUnavailable;
}

/** Voteview answers for the congresses the LIS feed publishes, when the feed can't. */
function voteviewAnswersFor(congress: number): boolean {
  return congress >= SENATE_VOTE_FIRST_CONGRESS;
}

/** The HTTP status the feed answered with, from the first error in the chain that carries one. */
function httpStatusOf(error: Error): number | undefined {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const status = current instanceof McpError ? current.data?.status : undefined;
    if (typeof status === 'number') return status;
  }
  return;
}

function isNativeAbortSignal(value: unknown): value is AbortSignal {
  if (
    typeof AbortSignal !== 'function' ||
    typeof AbortSignal.prototype.throwIfAborted !== 'function' ||
    !value
  ) {
    return false;
  }
  try {
    AbortSignal.prototype.throwIfAborted.call(value);
    return true;
  } catch (error) {
    return !(error instanceof TypeError);
  }
}

export class SenateVoteService {
  private readonly baseUrl: string;
  private readonly voteview = new VoteviewSource();

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async listVotes(params: ListVotesParams, ctx?: Context): Promise<SenateVoteListResult> {
    const url = `${this.baseUrl}/roll_call_lists/vote_menu_${params.congress}_${params.session}.xml`;
    const { votes: all, source } = await this.lisOrVoteview<{
      votes: SenateVoteSummary[];
      source?: SenateVoteSource;
    }>(
      params.congress,
      url,
      ctx,
      async () => ({
        votes: parseVoteMenu(
          await this.fetchXml(
            url,
            `SenateVoteService GET vote_menu_${params.congress}_${params.session}`,
            ctx,
            `No Senate roll call votes found for the ${ordinal(params.congress)} Congress, session ${params.session}. Valid sessions are 1 and 2; ${SENATE_VOTE_COVERAGE}.`,
            { congress: params.congress, session: params.session },
          ),
        ),
      }),
      () =>
        this.voteview.sessionVotes(params.congress, params.session, ctx, this.getAbortSignal(ctx)),
    );

    /** Roll number is chronological within a session; sort explicitly so order does
     * not depend on feed ordering. */
    const sorted = [...all].sort((a, b) =>
      params.order === 'oldest' ? a.voteNumber - b.voteNumber : b.voteNumber - a.voteNumber,
    );
    const slice = sorted.slice(params.offset, params.offset + params.limit);
    const nextOffset =
      params.offset + slice.length < sorted.length ? params.offset + slice.length : null;
    return {
      chamber: 'senate',
      data: slice,
      pagination: { count: sorted.length, nextOffset },
      ...(source ? { source } : {}),
    };
  }

  async getVote(params: GetVoteParams, ctx?: Context): Promise<SenateVoteDetailResult> {
    const { vote, members, source } = await this.fetchVote(params, ctx);
    /** Derive the party breakdown from the roster — the feed publishes none. */
    return {
      chamber: 'senate',
      vote: { ...vote, partyTotals: computePartyTotals(members) },
      ...(source ? { source } : {}),
    };
  }

  async getVoteMembers(
    params: GetVoteMembersParams,
    ctx?: Context,
  ): Promise<SenateVoteMembersResult> {
    const { vote, members, source } = await this.fetchVote(params, ctx);
    const slice = members.slice(params.offset, params.offset + params.limit);
    const nextOffset =
      params.offset + slice.length < members.length ? params.offset + slice.length : null;
    return {
      chamber: 'senate',
      data: slice,
      vote,
      pagination: { count: members.length, nextOffset },
      ...(source ? { source } : {}),
    };
  }

  private fetchVote(
    params: GetVoteParams,
    ctx?: Context,
  ): Promise<ParsedRollCallVote & { source?: SenateVoteSource }> {
    const padded = String(params.voteNumber).padStart(5, '0');
    const url = `${this.baseUrl}/roll_call_votes/vote${params.congress}${params.session}/vote_${params.congress}_${params.session}_${padded}.xml`;
    const voteParams = {
      congress: params.congress,
      session: params.session,
      voteNumber: params.voteNumber,
    };
    return this.lisOrVoteview<ParsedRollCallVote & { source?: SenateVoteSource }>(
      params.congress,
      url,
      ctx,
      async () =>
        parseRollCallVote(
          await this.fetchXml(
            url,
            `SenateVoteService GET vote_${params.congress}_${params.session}_${padded}`,
            ctx,
            `Senate roll call vote ${params.voteNumber} was not found in the ${ordinal(params.congress)} Congress, session ${params.session}.`,
            voteParams,
          ),
        ),
      () => this.voteview.rollCallVote(voteParams, ctx, this.getAbortSignal(ctx)),
    );
  }

  /**
   * Answer from the LIS feed, or from Voteview when the feed could not answer.
   * Both spend the call's one budget. A congress before the feed's coverage keeps
   * the feed's failure: Voteview is consulted only for votes the feed publishes.
   */
  private async lisOrVoteview<T>(
    congress: number,
    url: string,
    ctx: Context | undefined,
    fromLis: () => Promise<T>,
    fromVoteview: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fromLis();
    } catch (lisError) {
      if (!lisCouldNotAnswer(lisError) || !voteviewAnswersFor(congress)) throw lisError;
      const status = httpStatusOf(lisError);
      ctx?.log.notice('Senate LIS feed could not be read; serving the call from Voteview.', {
        congress,
        url,
        ...(status === undefined ? {} : { status }),
        lisError: lisError.message,
      });
      try {
        return await fromVoteview();
      } catch (voteviewError) {
        if (!lisCouldNotAnswer(voteviewError)) throw voteviewError;
        throw serviceUnavailable(
          'The Senate LIS feed could not be read, and Voteview, the source this server falls back to, is unavailable too.',
          {
            reason: 'upstream_error',
            recovery: UNAVAILABLE_RECOVERY,
            ...(voteviewError.data?.retryable === false ? { retryable: false } : {}),
          },
          { cause: voteviewError },
        );
      }
    }
  }

  private async fetchXml(
    url: string,
    operation: string,
    ctx: Context | undefined,
    notFoundMessage: string,
    data: { congress: number; session: number; voteNumber?: number },
  ): Promise<string> {
    const requestContext = this.getRequestContext(ctx, operation);
    const signal = this.getAbortSignal(ctx);
    const refusalFallsBack = voteviewAnswersFor(data.congress);

    const text = await withCallBudget(
      (attempt) => this.doFetch(url, requestContext, attempt, refusalFallsBack),
      {
        call: ctx,
        attemptTimeoutMs: REQUEST_TIMEOUT_MS,
        upstream: 'senate.gov',
        request: 'the Senate LIS feed',
        recovery: UPSTREAM_ERROR_RECOVERY.recovery,
        operation,
        context: requestContext,
        baseDelayMs: BASE_BACKOFF_MS,
        maxRetries: MAX_ATTEMPTS - 1,
        isTransient: (error: unknown) => this.isRetryableError(error),
        ...(signal ? { signal } : {}),
      },
    );

    const trimmed = text.trim();
    if (!trimmed) {
      throw serviceUnavailable('The Senate LIS feed returned an empty response.', {
        ...UPSTREAM_ERROR_RECOVERY,
      });
    }
    if (REFUSAL_PAGE_RE.test(trimmed)) {
      throw serviceUnavailable(
        'senate.gov refused the request for the Senate LIS feed (it answered with its firewall page).',
        REFUSED_RECOVERY,
      );
    }
    /** The host serves a 200 HTML page for unknown congress/session/vote — treat any
     * non-feed body as not found rather than letting the parser choke on it. */
    if (HTML_RESPONSE_RE.test(trimmed) || !FEED_ROOT_RE.test(trimmed)) {
      throw notFound(notFoundMessage, { ...data, ...NOT_FOUND_RECOVERY });
    }
    return trimmed;
  }

  /**
   * `refusalFallsBack`: a 403 will be answered from Voteview, so it is an expected
   * outcome while senate.gov refuses automated clients — `fetchWithTimeout` logs it
   * at debug instead of as an error carrying the refusal page. The refusal itself
   * is logged once, at notice, when the call falls back.
   */
  private async doFetch(
    url: string,
    requestContext: RequestContext,
    attempt: BudgetedAttempt,
    refusalFallsBack: boolean,
  ): Promise<string> {
    try {
      const response = await fetchWithTimeout(url, attempt.timeoutMs, requestContext, {
        headers: { Accept: 'application/xml, text/xml, */*' },
        signal: attempt.signal,
        expectedStatuses: refusalFallsBack ? [403] : [],
      });
      return await response.text();
    } catch (error) {
      /** fetchWithTimeout throws a status-mapped McpError whose message embeds the
       *  full URL. The missing-resource case never lands here (the host answers 200
       *  with HTML), so a 403 is the host refusing the client and any other non-2xx
       *  is an outage/timeout — surface either as a clean upstream error without
       *  echoing the URL. */
      if (error instanceof McpError) {
        if (error.code === JsonRpcErrorCode.RequestCancelled) throw error;
        if (error.data?.status === 403) {
          throw serviceUnavailable(
            'senate.gov refused the request for the Senate LIS feed (HTTP 403).',
            REFUSED_RECOVERY,
            { cause: error },
          );
        }
        throw serviceUnavailable(
          'The Senate.gov LIS feed is temporarily unavailable.',
          {
            ...UPSTREAM_ERROR_RECOVERY,
            ...(error.data?.retryable === false ? { retryable: false } : {}),
          },
          { cause: error },
        );
      }
      throw error;
    }
  }

  private isRetryableError(error: unknown): boolean {
    return (
      !(error instanceof McpError && error.code === JsonRpcErrorCode.RateLimited) &&
      defaultIsTransient(error)
    );
  }

  /**
   * Derive the context the network helpers log and report against. `Context`
   * extends `RequestContext`, so the handler's own context is the parent — the
   * request ID carries through and only the operation label is per-call.
   */
  private getRequestContext(ctx: Context | undefined, operation: string): RequestContext {
    return requestContextService.createRequestContext({
      operation,
      ...(ctx ? { parentContext: ctx } : {}),
    });
  }

  private getAbortSignal(ctx?: Context): AbortSignal | undefined {
    const signal = ctx?.signal;
    return isNativeAbortSignal(signal) ? signal : undefined;
  }
}

let _service: SenateVoteService | undefined;

export function initSenateVoteService(): void {
  _service = new SenateVoteService();
}

export function getSenateVoteService(): SenateVoteService {
  if (!_service) {
    throw new Error('SenateVoteService not initialized — call initSenateVoteService() in setup()');
  }
  return _service;
}

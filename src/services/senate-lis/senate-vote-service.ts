/**
 * @fileoverview Senate LIS roll-call vote client — fetch, retry, XML parse, normalize.
 *
 * The Congress.gov API v3 exposes House votes only (validated 2026-05-31: the
 * `/senate-vote/...` namespace 404s). Senate roll call votes live solely in the
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
 * @module services/senate-lis/senate-vote-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { computePartyTotals, parseRollCallVote, parseVoteMenu } from './parse.js';
import type { SenateMemberVote, SenateVoteDetail, SenateVoteSummary } from './types.js';

const DEFAULT_BASE_URL = 'https://www.senate.gov/legislative/LIS';
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;

/** A 200 response whose body is an HTML page (the host's "not found" surface). */
const HTML_RESPONSE_RE = /^\s*<(!DOCTYPE|html[\s>])/i;
/** A valid feed body opens with one of these roots once the XML declaration is past. */
const FEED_ROOT_RE = /<(vote_summary|roll_call_vote)[\s>]/;

const NOT_FOUND_RECOVERY = {
  reason: 'not_found',
  recovery: {
    hint: "Use operation 'list' with chamber 'senate' to find valid vote numbers for the congress and session, then retry.",
  },
} as const;
const UPSTREAM_ERROR_RECOVERY = {
  reason: 'upstream_error',
  recovery: {
    hint: 'Retry after a short delay; the Senate.gov LIS feed may be temporarily unavailable.',
  },
} as const;

interface RequestContextLike extends Record<string, unknown> {
  operation: string;
  requestId: string;
  timestamp: string;
}

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
export type SenateVoteListResult = {
  chamber: 'senate';
  data: SenateVoteSummary[];
  pagination: Pagination;
};
export type SenateVoteDetailResult = {
  chamber: 'senate';
  vote: SenateVoteDetail;
};
export type SenateVoteMembersResult = {
  chamber: 'senate';
  data: SenateMemberVote[];
  vote: SenateVoteDetail;
  pagination: Pagination;
};

/** English ordinal for a congress number — "118" → "118th". */
function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
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

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async listVotes(params: ListVotesParams, ctx?: Context): Promise<SenateVoteListResult> {
    const url = `${this.baseUrl}/roll_call_lists/vote_menu_${params.congress}_${params.session}.xml`;
    const xml = await this.fetchXml(
      url,
      `SenateVoteService GET vote_menu_${params.congress}_${params.session}`,
      ctx,
      `No Senate roll call votes found for the ${ordinal(params.congress)} Congress, session ${params.session}. Valid sessions are 1 and 2; the Senate publishes roll call votes from the 101st Congress (1989) onward.`,
      { congress: params.congress, session: params.session },
    );

    const all = parseVoteMenu(xml);
    /** Roll number is chronological within a session; sort explicitly so order does
     * not depend on feed ordering. */
    const sorted = [...all].sort((a, b) =>
      params.order === 'oldest' ? a.voteNumber - b.voteNumber : b.voteNumber - a.voteNumber,
    );
    const slice = sorted.slice(params.offset, params.offset + params.limit);
    const nextOffset =
      params.offset + slice.length < sorted.length ? params.offset + slice.length : null;
    return { chamber: 'senate', data: slice, pagination: { count: sorted.length, nextOffset } };
  }

  async getVote(params: GetVoteParams, ctx?: Context): Promise<SenateVoteDetailResult> {
    const { vote, members } = await this.fetchVote(params, ctx);
    /** Derive the party breakdown from the roster — the feed publishes none. */
    return { chamber: 'senate', vote: { ...vote, partyTotals: computePartyTotals(members) } };
  }

  async getVoteMembers(
    params: GetVoteMembersParams,
    ctx?: Context,
  ): Promise<SenateVoteMembersResult> {
    const { vote, members } = await this.fetchVote(params, ctx);
    const slice = members.slice(params.offset, params.offset + params.limit);
    const nextOffset =
      params.offset + slice.length < members.length ? params.offset + slice.length : null;
    return {
      chamber: 'senate',
      data: slice,
      vote,
      pagination: { count: members.length, nextOffset },
    };
  }

  private async fetchVote(params: GetVoteParams, ctx?: Context) {
    const padded = String(params.voteNumber).padStart(5, '0');
    const url = `${this.baseUrl}/roll_call_votes/vote${params.congress}${params.session}/vote_${params.congress}_${params.session}_${padded}.xml`;
    const xml = await this.fetchXml(
      url,
      `SenateVoteService GET vote_${params.congress}_${params.session}_${padded}`,
      ctx,
      `Senate roll call vote ${params.voteNumber} was not found in the ${ordinal(params.congress)} Congress, session ${params.session}.`,
      { congress: params.congress, session: params.session, voteNumber: params.voteNumber },
    );
    return parseRollCallVote(xml);
  }

  private async fetchXml(
    url: string,
    operation: string,
    ctx: Context | undefined,
    notFoundMessage: string,
    data: Record<string, unknown>,
  ): Promise<string> {
    const requestContext = this.getRequestContext(ctx, operation);
    const signal = this.getAbortSignal(ctx);

    const text = await withRetry(() => this.doFetch(url, requestContext, signal), {
      operation,
      context: requestContext,
      baseDelayMs: BASE_BACKOFF_MS,
      maxRetries: MAX_ATTEMPTS - 1,
      isTransient: (error: unknown) => this.isRetryableError(error),
      ...(signal ? { signal } : {}),
    });

    const trimmed = text.trim();
    if (!trimmed) {
      throw serviceUnavailable('The Senate LIS feed returned an empty response.', {
        ...UPSTREAM_ERROR_RECOVERY,
      });
    }
    /** The host serves a 200 HTML page for unknown congress/session/vote — treat any
     * non-feed body as not found rather than letting the parser choke on it. */
    if (HTML_RESPONSE_RE.test(trimmed) || !FEED_ROOT_RE.test(trimmed)) {
      throw notFound(notFoundMessage, { ...data, ...NOT_FOUND_RECOVERY });
    }
    return trimmed;
  }

  private async doFetch(
    url: string,
    requestContext: RequestContextLike,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, requestContext, {
        headers: { Accept: 'application/xml, text/xml, */*' },
        ...(signal ? { signal } : {}),
      });
      return await response.text();
    } catch (error) {
      /** fetchWithTimeout throws a status-mapped McpError whose message embeds the
       *  full URL. The missing-resource case never lands here (the host answers 200
       *  with HTML), so a genuine non-2xx is an outage/timeout — surface it as a clean,
       *  retryable upstream error without echoing the URL. */
      if (error instanceof McpError) {
        throw serviceUnavailable(
          'The Senate.gov LIS feed is temporarily unavailable.',
          { ...UPSTREAM_ERROR_RECOVERY },
          { cause: error },
        );
      }
      throw error;
    }
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof McpError) {
      return (
        error.code === JsonRpcErrorCode.ServiceUnavailable ||
        error.code === JsonRpcErrorCode.Timeout
      );
    }
    return true;
  }

  private getRequestContext(ctx: Context | undefined, operation: string): RequestContextLike {
    const ctxRecord = ctx as unknown as Record<string, unknown> | undefined;
    const requestId =
      typeof ctxRecord?.requestId === 'string' ? ctxRecord.requestId : 'senate-vote-service';
    const timestamp =
      typeof ctxRecord?.timestamp === 'string' ? ctxRecord.timestamp : new Date().toISOString();
    return { operation, requestId, timestamp };
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

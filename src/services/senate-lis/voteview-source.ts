/**
 * @fileoverview Voteview's Senate roll call files, the source `SenateVoteService`
 * falls back to when the Senate LIS feed can't be read.
 *
 * Voteview (UCLA) publishes each congress as three CSV files — roll calls, member
 * positions, members — about 3 MB together for a recent congress. They are
 * fetched together, parsed once, and cached per congress for an hour, in a cache
 * bounded by the bytes each parsed congress keeps alive. Concurrent calls for a
 * congress share one load: each waits on it under its own call budget and
 * cancellation, so one caller giving up never fails another, and the load is
 * aborted only when no caller is left waiting on it.
 *
 * Voteview adds votes after the Senate takes them, so every answer names
 * Voteview's latest vote for the congress, and a vote after it is not found
 * rather than guessed at.
 *
 * @module services/senate-lis/voteview-source
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  requestCancelled,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import {
  defaultIsTransient,
  fetchWithTimeout,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { CALL_BUDGET_MS, withCallBudget } from '@/services/call-budget.js';
import { currentCongressNumber, ordinal } from '@/utils/congress-calendar.js';
import type { ParsedRollCallVote, SenateVoteSource, SenateVoteSummary } from './types.js';
import {
  latestVoteviewRollCall,
  parseVoteviewCongress,
  type VoteviewCongress,
  voteviewRollCallVote,
  voteviewSessionVotes,
} from './voteview-parse.js';

const DEFAULT_BASE_URL = 'https://voteview.com/static/data/out';
const VOTEVIEW_URL = 'https://voteview.com/';

/** The citation Voteview asks for on its data page (voteview.com/data, 2026-11-04). */
export const VOTEVIEW_CITATION =
  'Lewis, Jeffrey B., Keith Poole, Howard Rosenthal, Adam Boche, Aaron Rudkin, and Luke Sonnet (2026). Voteview: Congressional Roll-Call Votes Database. https://voteview.com/';

const FILE_KINDS = ['rollcalls', 'votes', 'members'] as const;

/**
 * Voteview rewrites its files in a batch after a day's votes (the 2026-09-30
 * votes were in files modified 2026-10-01 07:01 UTC), so an hour-old copy is at
 * most an hour behind Voteview itself.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * A parsed recent congress keeps at most about 1.3 MB alive by its
 * `retainedBytes` account (the 119th: 1.27 MB), so this holds a dozen or more.
 */
export const VOTEVIEW_CACHE_MAX_BYTES = 16 * 1024 * 1024;

/** One file's whole exchange; the 119th's 2.6 MB votes file took 0.5 s on 2026-11-04. */
const FILE_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 2;
const BASE_BACKOFF_MS = 1000;

export const UNAVAILABLE_RECOVERY = {
  hint: "Retry after a short delay; House votes (chamber 'house') are unaffected.",
} as const;
const RATE_LIMITED_RECOVERY = {
  hint: "Follow Retry-After when supplied, otherwise wait before retrying; House votes (chamber 'house') are unaffected.",
} as const;
const LIST_RECOVERY = {
  hint: "Use operation 'list' with chamber 'senate' to see the Senate votes Voteview has for the congress and session, then retry.",
} as const;

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** One in-flight fetch of a congress's files, shared by every call waiting on it. */
interface SharedLoad {
  readonly controller: AbortController;
  readonly settled: Promise<Settled<VoteviewCongress>>;
  waiters: number;
}

interface CacheEntry {
  data: VoteviewCongress;
  loadedAt: number;
}

export interface VoteviewVoteParams {
  congress: number;
  session: number;
  voteNumber: number;
}

export class VoteviewSource {
  private readonly baseUrl: string;
  private readonly maxBytes: number;
  /** Insertion order is recency: a hit moves its entry to the end. */
  private readonly cache = new Map<number, CacheEntry>();
  private cachedBytes = 0;
  private readonly loads = new Map<number, SharedLoad>();

  constructor(maxBytes: number = VOTEVIEW_CACHE_MAX_BYTES, baseUrl: string = DEFAULT_BASE_URL) {
    this.maxBytes = maxBytes;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * A session's votes, ascending by vote number.
   *
   * @throws {McpError} `NotFound` when Voteview has no vote for the session.
   */
  async sessionVotes(
    congress: number,
    session: number,
    ctx: Context | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ votes: SenateVoteSummary[]; source: SenateVoteSource }> {
    const data = await this.congressData(congress, ctx, signal);
    const latest = latestVoteviewRollCall(data);
    const votes = voteviewSessionVotes(data, session);
    if (!latest || votes.length === 0) {
      throw notFound(
        `No Senate roll call votes for the ${ordinal(congress)} Congress, session ${session} are in Voteview, which serves Senate votes while the Senate LIS feed can't be read. ${latestClause(data)}`,
        {
          congress,
          session,
          ...(latest ? { latestVote: latestVoteOf(latest) } : {}),
          reason: 'not_found',
          recovery: LIST_RECOVERY,
        },
      );
    }
    return { votes, source: sourceOf(data, latest) };
  }

  /**
   * One vote and its roster.
   *
   * @throws {McpError} `NotFound` when the vote is not in Voteview — after its
   * latest vote, or past the end of its session.
   */
  async rollCallVote(
    params: VoteviewVoteParams,
    ctx: Context | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ParsedRollCallVote & { source: SenateVoteSource }> {
    const data = await this.congressData(params.congress, ctx, signal);
    const latest = latestVoteviewRollCall(data);
    const found = voteviewRollCallVote(data, params.session, params.voteNumber);
    if (found && latest) return { ...found, source: sourceOf(data, latest) };

    const afterLatest =
      !latest ||
      params.session > latest.session ||
      (params.session === latest.session && params.voteNumber > latest.voteNumber);
    const sessionEnd = data.rollCalls.findLast((r) => r.session === params.session)?.voteNumber;
    const where = `Senate roll call vote ${params.voteNumber} of the ${ordinal(params.congress)} Congress, session ${params.session}`;
    throw notFound(
      afterLatest || sessionEnd === undefined
        ? `${where} is not in Voteview, which serves Senate votes while the Senate LIS feed can't be read. ${latestClause(data)}`
        : `${where} was not found; in Voteview, which serves Senate votes while the Senate LIS feed can't be read, session ${params.session} runs through vote ${sessionEnd}.`,
      {
        ...params,
        ...(latest ? { latestVote: latestVoteOf(latest) } : {}),
        reason: 'not_found',
        recovery: LIST_RECOVERY,
      },
    );
  }

  /** The congress from the cache, else from a load shared with every concurrent call. */
  private async congressData(
    congress: number,
    ctx: Context | undefined,
    signal: AbortSignal | undefined,
  ): Promise<VoteviewCongress> {
    const cached = this.cache.get(congress);
    if (cached) {
      this.cache.delete(congress);
      if (Date.now() - cached.loadedAt < CACHE_TTL_MS) {
        this.cache.set(congress, cached);
        return cached.data;
      }
      this.cachedBytes -= cached.data.retainedBytes;
    }
    const load = this.loads.get(congress) ?? this.startLoad(congress);
    return await this.waitFor(load, congress, ctx, signal);
  }

  private startLoad(congress: number): SharedLoad {
    const controller = new AbortController();
    const settled = this.fetchCongress(congress, controller.signal).then(
      (value): Settled<VoteviewCongress> => {
        this.finish(congress, load);
        this.store(congress, value);
        return { ok: true, value };
      },
      (error: unknown): Settled<VoteviewCongress> => {
        this.finish(congress, load);
        return { ok: false, error };
      },
    );
    const load: SharedLoad = { controller, settled, waiters: 0 };
    this.loads.set(congress, load);
    return load;
  }

  private finish(congress: number, load: SharedLoad): void {
    if (this.loads.get(congress) === load) this.loads.delete(congress);
  }

  /**
   * Wait on a shared load under this call's own budget and cancellation. The last
   * waiter to leave an unfinished load aborts it; a failed load is not cached, so
   * the next call starts a new one.
   *
   * Only the wait runs under the budget. The load's own failure is rethrown
   * after it, untouched: inside the budget's ladder, a Voteview attempt timeout
   * in its cause chain would read as the budget running out.
   */
  private async waitFor(
    load: SharedLoad,
    congress: number,
    ctx: Context | undefined,
    signal: AbortSignal | undefined,
  ): Promise<VoteviewCongress> {
    load.waiters++;
    const operation = `VoteviewSource wait S${congress}`;
    let outcome: Settled<VoteviewCongress>;
    try {
      outcome = await withCallBudget((attempt) => settledOrAborted(load.settled, attempt.signal), {
        call: ctx,
        /** The wait has no timeout of its own: the call's budget is what bounds it. */
        attemptTimeoutMs: CALL_BUDGET_MS,
        upstream: 'Voteview',
        request: `the Senate vote files for the ${ordinal(congress)} Congress`,
        recovery: UNAVAILABLE_RECOVERY,
        operation,
        context: this.requestContext(ctx, operation),
        maxRetries: 0,
        ...(signal ? { signal } : {}),
      });
    } finally {
      load.waiters--;
      if (load.waiters === 0 && this.loads.get(congress) === load) {
        this.loads.delete(congress);
        load.controller.abort(new DOMException('No call is waiting on this load.', 'AbortError'));
      }
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  private store(congress: number, data: VoteviewCongress): void {
    const previous = this.cache.get(congress);
    if (previous) {
      this.cache.delete(congress);
      this.cachedBytes -= previous.data.retainedBytes;
    }
    if (data.retainedBytes > this.maxBytes) return;
    this.cache.set(congress, { data, loadedAt: Date.now() });
    this.cachedBytes += data.retainedBytes;
    for (const [key, entry] of this.cache) {
      if (this.cachedBytes <= this.maxBytes) break;
      this.cache.delete(key);
      this.cachedBytes -= entry.data.retainedBytes;
    }
  }

  /** Fetch the three files together and parse them; a failure cancels the others. */
  private async fetchCongress(congress: number, signal: AbortSignal): Promise<VoteviewCongress> {
    const sibling = new AbortController();
    const linked = AbortSignal.any([signal, sibling.signal]);
    let texts: string[];
    try {
      texts = await Promise.all(FILE_KINDS.map((kind) => this.fetchFile(congress, kind, linked)));
    } catch (error) {
      sibling.abort();
      throw error;
    }
    const [rollcalls, votes, members] = texts as [string, string, string];
    try {
      return parseVoteviewCongress(congress, { rollcalls, votes, members });
    } catch (error) {
      throw serviceUnavailable(
        `Voteview's Senate vote files for the ${ordinal(congress)} Congress are not in the format this server reads.`,
        { reason: 'upstream_error', retryable: false, recovery: UNAVAILABLE_RECOVERY },
        { cause: error },
      );
    }
  }

  private fetchFile(
    congress: number,
    kind: (typeof FILE_KINDS)[number],
    signal: AbortSignal,
  ): Promise<string> {
    const file = `S${congress}_${kind}.csv`;
    const url = `${this.baseUrl}/${kind}/${file}`;
    const operation = `VoteviewSource GET ${file}`;
    const context = this.requestContext(undefined, operation);
    return withRetry(
      async ({ signal: attemptSignal }) => {
        try {
          const response = await fetchWithTimeout(url, FILE_TIMEOUT_MS, context, {
            headers: { Accept: 'text/csv, */*' },
            signal: attemptSignal,
          });
          return await response.text();
        } catch (error) {
          /**
           * The caller gone, the load abandoned, a sibling file failed: an end,
           * rethrown as it came, never a failure to classify.
           */
          if (
            attemptSignal.aborted ||
            (error instanceof McpError && error.code === JsonRpcErrorCode.RequestCancelled)
          ) {
            throw error;
          }
          /**
           * `fetchWithTimeout` maps a 429 to `RateLimited`, which `isTransient`
           * never retries. The message names Voteview's Retry-After too, since
           * `content[]` renders the message but not `data.retryAfter`.
           */
          if (error instanceof McpError && error.code === JsonRpcErrorCode.RateLimited) {
            const retryAfter =
              typeof error.data?.retryAfter === 'string' ? error.data.retryAfter : undefined;
            const asked = retryAfter === undefined ? '' : `, Retry-After ${retryAfter}`;
            throw rateLimited(
              `Voteview, which serves Senate votes while the Senate LIS feed can't be read, is rate-limiting this server (HTTP 429${asked}).`,
              {
                reason: 'rate_limited',
                ...(retryAfter === undefined ? {} : { retryAfter }),
                recovery: RATE_LIMITED_RECOVERY,
              },
              { cause: error },
            );
          }
          if (error instanceof McpError && error.data?.status === 404) {
            throw notFound(
              `Voteview has no Senate roll call votes for the ${ordinal(congress)} Congress, and the Senate LIS feed can't be read.`,
              {
                congress,
                reason: 'not_found',
                recovery: {
                  hint: 'Check the congress number. Voteview adds a congress once the Senate has voted in it; retry later for a congress that has just begun.',
                },
              },
              { cause: error },
            );
          }
          /** Any other status, a network failure, or a body broken off mid-read (`TypeError: terminated`). */
          throw serviceUnavailable(
            'Voteview is temporarily unavailable.',
            {
              reason: 'upstream_error',
              recovery: UNAVAILABLE_RECOVERY,
              ...(error instanceof McpError && error.data?.retryable === false
                ? { retryable: false }
                : {}),
            },
            { cause: error },
          );
        }
      },
      {
        operation,
        context,
        signal,
        maxRetries: MAX_ATTEMPTS - 1,
        baseDelayMs: BASE_BACKOFF_MS,
        isTransient: (error: unknown) =>
          !(error instanceof McpError && error.code === JsonRpcErrorCode.RateLimited) &&
          defaultIsTransient(error),
      },
    );
  }

  private requestContext(ctx: Context | undefined, operation: string): RequestContext {
    return requestContextService.createRequestContext({
      operation,
      ...(ctx ? { parentContext: ctx } : {}),
    });
  }
}

/**
 * Resolve with the load's outcome, or reject as cancelled as soon as `signal`
 * aborts — leaving the load to its other waiters.
 */
async function settledOrAborted<T>(
  settled: Promise<Settled<T>>,
  signal: AbortSignal,
): Promise<Settled<T>> {
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = () =>
    reject(requestCancelled("The wait for Voteview's Senate vote files was cancelled."));
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([settled, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function latestVoteOf(rollCall: { session: number; voteNumber: number; date: string }) {
  return { session: rollCall.session, voteNumber: rollCall.voteNumber, date: rollCall.date };
}

function sourceOf(
  data: VoteviewCongress,
  latest: { session: number; voteNumber: number; date: string },
): SenateVoteSource {
  return {
    name: 'Voteview',
    url: VOTEVIEW_URL,
    congress: data.congress,
    latestVote: latestVoteOf(latest),
    citation: VOTEVIEW_CITATION,
  };
}

/**
 * Where Voteview's coverage of the congress ends, as a sentence. Only a congress
 * still sitting can gain votes, so only its clause says more will come.
 */
function latestClause(data: VoteviewCongress): string {
  const latest = latestVoteviewRollCall(data);
  if (!latest) {
    return `Voteview has no Senate vote for the ${ordinal(data.congress)} Congress yet; it adds votes after the Senate takes them.`;
  }
  const more =
    data.congress >= currentCongressNumber() ? '; it adds votes after the Senate takes them' : '';
  return `Its latest Senate vote for the ${ordinal(data.congress)} Congress is session ${latest.session} vote ${latest.voteNumber} (${latest.date})${more}.`;
}

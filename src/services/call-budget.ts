/**
 * @fileoverview One time budget for every upstream request a tool call or
 * resource read makes, shared by `CongressApiService`, `SenateVoteService`, and
 * `CongressDocumentsService`.
 *
 * MCP SDK clients give up on a request after 60 seconds by default. A call can
 * chain several upstream requests — a lookup before a document fetch, a roster
 * paged two deep before the request it resolves, a first page and then a
 * parallel stage — and each request runs its own retry ladder, so per-attempt
 * timeouts bound neither the ladder nor the chain: a stalled upstream could run
 * a call past the client's patience, which then sees its own timeout instead of
 * this server's classified error.
 *
 * Every request made for a call therefore spends one {@link CALL_BUDGET_MS}
 * budget counted from the call's start — `ctx.timestamp`, which the framework
 * stamps when the tool call or resource read begins. The request's ladder gets
 * what is left as `withRetry`'s `deadlineMs`, so a backoff or a `Retry-After`
 * wait the remainder cannot hold fails fast instead of sleeping; each attempt's
 * timeout is clamped to the remainder and its I/O carries the budget's signal;
 * a request the budget no longer covers is never sent; and running out is
 * `Timeout` with reason `upstream_timeout`. Requests issued in parallel share
 * the same end instant.
 *
 * A request with no call behind it — the mirror ingester and the `mirror:*`
 * scripts call `CongressApiService` without a context — runs the plain
 * per-request ladder, unbudgeted.
 *
 * @module services/call-budget
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  requestCancelled,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import type { RetryAttempt, RetryOptions } from '@cyanheads/mcp-ts-core/utils';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';

/**
 * The time every upstream request of one call shares. It ends under the
 * 60-second request timeout MCP SDK clients apply by default, leaving room for
 * the classified error to reach the client.
 */
export const CALL_BUDGET_MS = 50_000;

/** Declared once in `congressErrorContracts`, which every tool carries. */
const UPSTREAM_TIMEOUT = 'upstream_timeout';

/** What one attempt gets: the signal to thread into its I/O and its clamped timeout. */
export interface BudgetedAttempt {
  /** Aborts on the caller's cancellation or the budget's expiry. */
  readonly signal: AbortSignal;
  /** The attempt's own timeout, clamped to what is left of the budget. */
  readonly timeoutMs: number;
}

/** `withRetry` options minus the deadline, which the budget sets, plus what the budget needs. */
export interface CallBudgetOptions extends Omit<RetryOptions, 'deadlineMs'> {
  /** One attempt's timeout before the clamp — the whole exchange, headers and body. */
  attemptTimeoutMs: number;
  /**
   * The tool call or resource read the request is made for — the handler's own
   * `ctx`, never a context derived from it, which carries a later timestamp.
   * `undefined` runs the request unbudgeted.
   */
  call: Context | undefined;
  /**
   * The service's own hint for the expiry, as its other upstream failures carry
   * one. Without it the tool's declared `upstream_timeout` contract fills one.
   */
  recovery?: { hint: string } | undefined;
  /** What the request fetches, as the budget's messages name it (`the document`). */
  request: string;
  /** Who is asked, as the budget's messages name it (`Congress.gov`). */
  upstream: string;
}

/**
 * Run one upstream request's retry ladder under its call's budget.
 *
 * Throws `Timeout` (`upstream_timeout`, `budgetMs`, `retryAttempts`) when the
 * budget is spent before the request starts or runs out during it. A caller
 * abort keeps precedence: it is never relabelled as the budget's expiry. Every
 * other failure — a rate limit, a `Retry-After` wait the remainder cannot hold,
 * an exhausted ladder that finished inside the budget — leaves unchanged.
 */
export async function withCallBudget<T>(
  fn: (attempt: BudgetedAttempt) => Promise<T>,
  options: CallBudgetOptions,
): Promise<T> {
  const { attemptTimeoutMs, call, recovery, request, upstream, ...retry } = options;
  const expired = (attemptsMade: number, cause?: unknown) =>
    budgetExpired({ upstream, request, recovery }, attemptsMade, cause);
  let attempts = 0;
  let lastAttemptClamped = false;
  const run = ({ signal, remainingMs }: RetryAttempt): Promise<T> => {
    attempts++;
    lastAttemptClamped = remainingMs < attemptTimeoutMs;
    return fn({ signal, timeoutMs: Math.min(attemptTimeoutMs, remainingMs) });
  };

  if (call === undefined) return withRetry(run, retry);

  const remainingMs = Date.parse(call.timestamp) + CALL_BUDGET_MS - Date.now();
  if (!(remainingMs > 0)) {
    if (retry.signal?.aborted) {
      throw requestCancelled(`${upstream} was not asked for ${request}: the call was cancelled.`);
    }
    throw expired(0);
  }

  try {
    /** Capped at the budget so a clock step backwards cannot hand a request more. */
    return await withRetry(run, { ...retry, deadlineMs: Math.min(remainingMs, CALL_BUDGET_MS) });
  } catch (error) {
    /**
     * The clock usually ends a clamped attempt through its signal, which
     * `withRetry` reports as its deadline expiry. The attempt's own timer is
     * armed for the same instant, though, and on the last attempt it can fire
     * first — `withRetry` then sees an ordinary timeout and reports the
     * exhausted ladder. Both are this budget running out.
     */
    if (isRetryDeadlineExpiry(error) || (lastAttemptClamped && endedByAttemptTimeout(error))) {
      throw expired(attempts, error);
    }
    throw error;
  }
}

/** `withRetry`'s expiry of the `deadlineMs` the budget passed it. */
function isRetryDeadlineExpiry(error: unknown): boolean {
  return (
    error instanceof McpError &&
    error.code === JsonRpcErrorCode.Timeout &&
    error.data?.reason === 'retry_deadline_exceeded'
  );
}

/** Whether `fetchWithTimeout`'s own timer ended the attempt, however the service wrapped it. */
function endedByAttemptTimeout(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof McpError && current.data?.errorSource === 'FetchTimeout') return true;
  }
  return false;
}

/**
 * The budget ran out — before the request could start (`attempts` 0) or across
 * the attempts it made. Names the call's budget, never the slice of it this
 * request had left.
 */
function budgetExpired(
  { upstream, request, recovery }: Pick<CallBudgetOptions, 'recovery' | 'request' | 'upstream'>,
  attempts: number,
  cause?: unknown,
): McpError {
  const seconds = CALL_BUDGET_MS / 1000;
  const message =
    attempts === 0
      ? `${upstream} was not asked for ${request}: this call's ${seconds}-second budget for upstream requests ran out first.`
      : `${upstream} did not deliver ${request} within this call's ${seconds}-second budget for upstream requests (${attempts} attempt${attempts === 1 ? '' : 's'}).`;
  return timeout(
    message,
    {
      reason: UPSTREAM_TIMEOUT,
      retryable: true,
      budgetMs: CALL_BUDGET_MS,
      retryAttempts: attempts,
      ...(recovery ? { recovery } : {}),
    },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * @fileoverview The per-call upstream budget at its own seam: what an attempt is
 * given, the spent budget, the expiry relabel, `Retry-After` and backoff waits
 * the remainder cannot hold, cancellation precedence, and the unbudgeted path.
 * Each service's wiring and each chained tool path are proven in their own
 * suites; this table is not repeated there.
 * @module tests/services/call-budget.test
 */

import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BudgetedAttempt,
  type CallBudgetOptions,
  withCallBudget,
} from '@/services/call-budget.js';
import { CALL_BUDGET_MS, track, useFakeClock } from '../helpers/budget-fixtures.js';

const ATTEMPT_TIMEOUT_MS = 10_000;

/** Settles only when the attempt's signal aborts, rejecting with its reason as `fetch` does. */
function stall(attempt: BudgetedAttempt): Promise<never> {
  return new Promise((_resolve, reject) => {
    attempt.signal.addEventListener('abort', () => reject(attempt.signal.reason), { once: true });
  });
}

/** A transient upstream failure, as a service classifies a 503. */
const unavailable = (data: Record<string, unknown> = {}) =>
  serviceUnavailable('Upstream returned an unexpected error (HTTP 503).', {
    reason: 'upstream_error',
    ...data,
  });

/** What `fetchWithTimeout` throws when its own timer ends an attempt, wrapped as the services wrap it. */
const ownTimeout = () =>
  serviceUnavailable(
    'Upstream is unavailable.',
    { reason: 'upstream_error' },
    {
      cause: timeout('fetch GET https://upstream.example/… timed out.', {
        errorSource: 'FetchTimeout',
      }),
    },
  );

function options(overrides: Partial<CallBudgetOptions> = {}): CallBudgetOptions {
  return {
    call: createMockContext(),
    attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
    upstream: 'Upstream.example',
    request: 'the record',
    maxRetries: 2,
    baseDelayMs: 1000,
    ...overrides,
  };
}

/** The expiry as every service surfaces it. */
function budgetExpiry(retryAttempts: number) {
  return {
    code: JsonRpcErrorCode.Timeout,
    data: {
      reason: 'upstream_timeout',
      retryable: true,
      budgetMs: CALL_BUDGET_MS,
      retryAttempts,
    },
  };
}

describe('withCallBudget', () => {
  let start: number;

  beforeEach(() => {
    useFakeClock();
    start = Date.now();
  });
  afterEach(() => vi.useRealTimers());

  describe('what an attempt is given', () => {
    it.each([
      { spentMs: 0, ceilingMs: 10_000, timeoutMs: 10_000 },
      { spentMs: 39_999, ceilingMs: 10_000, timeoutMs: 10_000 },
      { spentMs: 45_000, ceilingMs: 10_000, timeoutMs: 5_000 },
      { spentMs: 20_000, ceilingMs: 30_000, timeoutMs: 30_000 },
      { spentMs: 25_000, ceilingMs: 30_000, timeoutMs: 25_000 },
      { spentMs: 49_999, ceilingMs: 30_000, timeoutMs: 1 },
    ])(
      '$spentMs ms into the call, a $ceilingMs ms attempt runs for $timeoutMs ms',
      async ({ spentMs, ceilingMs, timeoutMs }) => {
        const call = createMockContext();
        await vi.advanceTimersByTimeAsync(spentMs);
        const given: BudgetedAttempt[] = [];
        await withCallBudget(
          async (attempt) => {
            given.push(attempt);
            return 'ok';
          },
          options({ call, attemptTimeoutMs: ceilingMs }),
        );
        expect(given.map((attempt) => attempt.timeoutMs)).toEqual([timeoutMs]);
        expect(given[0]?.signal.aborted).toBe(false);
      },
    );

    it('gives a retry what is left after the attempt and backoff before it', async () => {
      const given: Array<{ atMs: number; timeoutMs: number }> = [];
      const result = track(
        withCallBudget(
          (attempt) => {
            given.push({ atMs: Date.now() - start, timeoutMs: attempt.timeoutMs });
            /** The attempt's own timer, as `fetchWithTimeout` arms it. */
            return new Promise((_resolve, reject) => {
              setTimeout(() => reject(ownTimeout()), attempt.timeoutMs);
            });
          },
          options({ attemptTimeoutMs: 30_000 }),
        ),
      );
      await vi.advanceTimersByTimeAsync(CALL_BUDGET_MS);

      /** The first attempt ran its full 30 s; after a 1 s ± 25% backoff the second got the rest. */
      expect(given).toHaveLength(2);
      expect(given[0]).toEqual({ atMs: 0, timeoutMs: 30_000 });
      const second = given[1] as { atMs: number; timeoutMs: number };
      expect(second.atMs).toBeGreaterThanOrEqual(30_750);
      expect(second.atMs).toBeLessThanOrEqual(31_250);
      expect(second.timeoutMs).toBe(CALL_BUDGET_MS - second.atMs);
      expect(result.state.settledAt).toBe(start + CALL_BUDGET_MS);
      expect(result.state.error).toMatchObject(budgetExpiry(2));
    });

    it('leaves a call that succeeds inside the budget exactly as it would run without one', async () => {
      const given: number[] = [];
      const call = track(
        withCallBudget(async (attempt) => {
          given.push(attempt.timeoutMs);
          if (given.length === 1) throw unavailable();
          return 'ok';
        }, options()),
      );
      await vi.advanceTimersByTimeAsync(CALL_BUDGET_MS);
      expect(call.state.value).toBe('ok');
      expect(given).toEqual([ATTEMPT_TIMEOUT_MS, ATTEMPT_TIMEOUT_MS]);
      expect((call.state.settledAt as number) - start).toBeLessThanOrEqual(1_250);
    });
  });

  describe('a spent budget', () => {
    it.each([CALL_BUDGET_MS, CALL_BUDGET_MS + 10_000])(
      'sends nothing %s ms into the call',
      async (spentMs) => {
        const call = createMockContext();
        await vi.advanceTimersByTimeAsync(spentMs);
        const fn = vi.fn(async () => 'ok');
        const error = await withCallBudget(fn, options({ call })).catch((e: unknown) => e);
        expect(error).toMatchObject(budgetExpiry(0));
        expect((error as McpError).message).toBe(
          "Upstream.example was not asked for the record: this call's 50-second budget for upstream requests ran out first.",
        );
        expect(fn).not.toHaveBeenCalled();
      },
    );
  });

  describe('expiry', () => {
    it('ends a stalled attempt at the budget and names the budget, not the attempt', async () => {
      const call = createMockContext();
      await vi.advanceTimersByTimeAsync(45_000);
      const fn = vi.fn(stall);
      const result = track(withCallBudget(fn, options({ call })));
      await vi.advanceTimersByTimeAsync(CALL_BUDGET_MS);

      expect(result.state.settledAt).toBe(start + CALL_BUDGET_MS);
      expect(result.state.error).toMatchObject(budgetExpiry(1));
      expect((result.state.error as McpError).message).toBe(
        "Upstream.example did not deliver the record within this call's 50-second budget for upstream requests (1 attempt).",
      );
      expect((result.state.error as McpError).cause).toMatchObject({
        data: { reason: 'retry_deadline_exceeded' },
      });
      expect(fn).toHaveBeenCalledOnce();
    });

    it('fails fast when the next backoff would outlast what is left', async () => {
      const call = createMockContext();
      /** 500 ms left; the first backoff is 1 s ± 25%. */
      await vi.advanceTimersByTimeAsync(49_500);
      const fn = vi.fn(async () => {
        throw unavailable();
      });
      const result = track(withCallBudget(fn, options({ call })));
      await vi.advanceTimersByTimeAsync(0);

      expect(result.state.settledAt).toBe(start + 49_500);
      expect(result.state.error).toMatchObject(budgetExpiry(1));
      expect(fn).toHaveBeenCalledOnce();
    });

    it('names the budget when a clamped last attempt is ended by its own timer, not the clock', async () => {
      const call = createMockContext();
      await vi.advanceTimersByTimeAsync(45_000);
      const result = track(
        withCallBudget(
          (attempt) =>
            new Promise((_resolve, reject) => {
              /** The attempt's own timer fires a millisecond ahead of the budget's clock. */
              setTimeout(() => reject(ownTimeout()), attempt.timeoutMs - 1);
            }),
          options({ call, maxRetries: 0 }),
        ),
      );
      await vi.advanceTimersByTimeAsync(CALL_BUDGET_MS);

      expect(result.state.settledAt).toBe(start + CALL_BUDGET_MS - 1);
      expect(result.state.error).toMatchObject(budgetExpiry(1));
    });

    it('leaves an exhausted ladder that finished inside the budget as the upstream failed it', async () => {
      const result = track(
        withCallBudget(
          (attempt) =>
            new Promise((_resolve, reject) => {
              setTimeout(() => reject(ownTimeout()), attempt.timeoutMs);
            }),
          options({ maxRetries: 0 }),
        ),
      );
      await vi.advanceTimersByTimeAsync(CALL_BUDGET_MS);

      expect(result.state.settledAt).toBe(start + ATTEMPT_TIMEOUT_MS);
      expect(result.state.error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_error' },
      });
    });

    it.each([
      { label: "the service's own hint", recovery: { hint: 'Retry after a short delay.' } },
      { label: 'no hint, for the contract to fill', recovery: undefined },
    ])('carries $label on the expiry', async ({ recovery }) => {
      const call = createMockContext();
      await vi.advanceTimersByTimeAsync(CALL_BUDGET_MS);
      const error = (await withCallBudget(async () => 'ok', options({ call, recovery })).catch(
        (e: unknown) => e,
      )) as McpError;
      expect(error.data?.recovery).toEqual(recovery);
    });

    it('ends requests issued in parallel for one call at the same instant', async () => {
      const call = createMockContext();
      await vi.advanceTimersByTimeAsync(20_000);
      const first = track(withCallBudget(stall, options({ call })));
      await vi.advanceTimersByTimeAsync(7_000);
      const second = track(withCallBudget(stall, options({ call })));
      await vi.advanceTimersByTimeAsync(CALL_BUDGET_MS);

      expect(first.state.settledAt).toBe(start + CALL_BUDGET_MS);
      expect(second.state.settledAt).toBe(start + CALL_BUDGET_MS);
      expect(first.state.error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
      expect(second.state.error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    });
  });

  describe('Retry-After', () => {
    it('fails fast with the upstream error when the wait would outlast what is left', async () => {
      const call = createMockContext();
      await vi.advanceTimersByTimeAsync(25_000);
      const fn = vi.fn(async () => {
        throw unavailable({ retryAfter: '30' });
      });
      const result = track(withCallBudget(fn, options({ call })));
      await vi.advanceTimersByTimeAsync(0);

      expect(result.state.settledAt).toBe(start + 25_000);
      expect(result.state.error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_error', retryAfter: '30' },
      });
      expect(fn).toHaveBeenCalledOnce();
    });

    it('waits out a Retry-After that fits and retries', async () => {
      let attempts = 0;
      const result = track(
        withCallBudget(async () => {
          if (attempts++ === 0) throw unavailable({ retryAfter: '30' });
          return 'ok';
        }, options()),
      );
      await vi.advanceTimersByTimeAsync(CALL_BUDGET_MS);

      expect(result.state.value).toBe('ok');
      expect(result.state.settledAt).toBe(start + 30_000);
    });
  });

  describe('cancellation precedence', () => {
    it('is RequestCancelled, not the budget, when the call is already cancelled and spent', async () => {
      const controller = new AbortController();
      const call = createMockContext({ signal: controller.signal });
      await vi.advanceTimersByTimeAsync(CALL_BUDGET_MS);
      controller.abort();
      const fn = vi.fn(async () => 'ok');
      const error = await withCallBudget(fn, options({ call, signal: controller.signal })).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(fn).not.toHaveBeenCalled();
    });

    it("keeps the attempt's own cancellation when the caller aborts mid-attempt", async () => {
      const controller = new AbortController();
      const call = createMockContext({ signal: controller.signal });
      await vi.advanceTimersByTimeAsync(45_000);
      const cancelled = new McpError(JsonRpcErrorCode.RequestCancelled, 'The request was aborted.');
      const result = track(
        withCallBudget(
          (attempt) =>
            new Promise((_resolve, reject) => {
              attempt.signal.addEventListener('abort', () => reject(cancelled), { once: true });
            }),
          options({ call, signal: controller.signal }),
        ),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      controller.abort();
      await result.done;

      expect(result.state.settledAt).toBe(start + 47_000);
      expect(result.state.error).toBe(cancelled);
    });

    it('rejects with the abort itself when the caller aborts during a backoff', async () => {
      const controller = new AbortController();
      const call = createMockContext({ signal: controller.signal });
      const fn = vi.fn(async () => {
        throw unavailable();
      });
      const result = track(withCallBudget(fn, options({ call, signal: controller.signal })));
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await result.done;

      expect(result.state.error).toMatchObject({ name: 'AbortError' });
      expect(fn).toHaveBeenCalledOnce();
    });
  });

  describe('with no call behind the request', () => {
    it('runs the plain ladder: full attempts, honored waits, no budget', async () => {
      const given: BudgetedAttempt[] = [];
      const result = track(
        withCallBudget(
          async (attempt) => {
            given.push(attempt);
            throw unavailable({ retryAfter: '30' });
          },
          options({ call: undefined }),
        ),
      );
      await vi.advanceTimersByTimeAsync(2 * CALL_BUDGET_MS);

      /** Two honored 30 s waits run past the 50 s a call would get. */
      expect(result.state.settledAt).toBe(start + 60_000);
      expect(given.map((attempt) => attempt.timeoutMs)).toEqual([
        ATTEMPT_TIMEOUT_MS,
        ATTEMPT_TIMEOUT_MS,
        ATTEMPT_TIMEOUT_MS,
      ]);
      expect(result.state.error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_error', retryAttempts: 3 },
      });
    });
  });
});

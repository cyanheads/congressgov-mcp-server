/**
 * @fileoverview Fake-clock fixtures for the per-call upstream budget: the
 * independent time facts the budget is held to, an upstream that never answers,
 * a JSON answer, a tracker that records the fake instant a call settles, and the
 * assertion for a tool call the budget ended.
 * @module tests/helpers/budget-fixtures
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { expect, vi } from 'vitest';

/** The request timeout MCP SDK clients apply by default — an independent fact, not the server's own budget. */
export const CLIENT_TIMEOUT_MS = 60_000;

/** The budget every tool call and resource read gives its upstream requests. */
export const CALL_BUDGET_MS = 50_000;

/** Fake the clocks the budget reads; `setImmediate` stays real for stream internals. */
export function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
}

/**
 * A fetch whose response never arrives. It settles only when its signal aborts,
 * rejecting with the abort reason as the platform `fetch` does.
 */
export function stalledHeadersFetch(_url: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** A 200 JSON response, as api.congress.gov answers. */
export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** An error response carrying `Retry-After`, as an upstream asking to be left alone answers. */
export function retryAfterResponse(status: number, retryAfterSeconds: number): Response {
  return new Response('Service Unavailable', {
    status,
    headers: { 'content-type': 'text/plain', 'retry-after': String(retryAfterSeconds) },
  });
}

/** One api.congress.gov route's script: its first `stalls` attempts never answer, then it answers `body` — or never, when `body` is absent. */
interface RouteScript {
  body?: unknown;
  stalls: number;
}

/**
 * A fetch serving api.congress.gov from per-route scripts, keyed by path plus
 * its `offset` query when one is sent (`/v3/committee?offset=250`), counting
 * every attempt per route in `hits`. An unscripted route fails the request.
 */
export function scriptedCongressApi(routes: Record<string, RouteScript>) {
  const hits: Record<string, number> = {};
  const fetch = (url: string | URL, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(String(url));
    if (parsed.hostname !== 'api.congress.gov') {
      return Promise.reject(new Error(`unexpected host ${parsed.hostname}`));
    }
    const offset = parsed.searchParams.get('offset');
    const key = offset === null ? parsed.pathname : `${parsed.pathname}?offset=${offset}`;
    const attempt = (hits[key] ?? 0) + 1;
    hits[key] = attempt;
    const route = routes[key];
    if (!route) return Promise.reject(new Error(`unscripted route ${key}`));
    return attempt <= route.stalls || route.body === undefined
      ? stalledHeadersFetch(url, init)
      : Promise.resolve(jsonResponse(route.body));
  };
  return { fetch, hits };
}

/** Records the fake-clock instant a promise settles, and how. */
export function track<T>(promise: Promise<T>) {
  const state: { error?: unknown; settledAt?: number; value?: T } = {};
  const done = promise.then(
    (value) => {
      state.settledAt = Date.now();
      state.value = value;
    },
    (error: unknown) => {
      state.settledAt = Date.now();
      state.error = error;
    },
  );
  return { done, state };
}

/**
 * Assert a tracked tool call was ended by the call budget itself: it settled at
 * the budget's end, before the client timeout, as an `upstream_timeout` error on
 * both surfaces — `structuredContent` carries the Timeout code with `budgetMs`
 * and `recovery`, and `content[]` names the budget. Every caller stalls its last
 * request, so an earlier settle means something other than the budget ended it.
 */
export function expectBudgetTimeout(
  call: {
    state: {
      settledAt?: number;
      value?: { content: unknown[]; isError?: boolean | undefined; structuredContent?: unknown };
    };
  },
  startedAt: number,
  recovery: { hint: unknown } = { hint: expect.any(String) },
): void {
  expect(call.state.settledAt, 'settled before the client timeout').toBeDefined();
  expect((call.state.settledAt as number) - startedAt).toBe(CALL_BUDGET_MS);
  const result = call.state.value;
  expect(result?.isError).toBe(true);
  expect(result?.structuredContent).toMatchObject({
    error: {
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout', budgetMs: CALL_BUDGET_MS, recovery },
    },
  });
  expect(contentText(result as { content: unknown[] })).toContain('50-second budget');
}

/** Every text block of a tool result, joined — the `content[]` surface as a client reads it. */
export function contentText(result: { content: unknown[] }): string {
  return result.content
    .map((block) =>
      typeof block === 'object' && block !== null && 'text' in block ? String(block.text) : '',
    )
    .join('\n');
}

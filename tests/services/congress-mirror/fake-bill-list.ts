/**
 * @fileoverview A stand-in for Congress.gov's `/bill/{congress}` list that keeps
 * the properties the mirror's bill walk has to survive. Each fake bill carries a
 * hidden second-resolution update time (`updatedAt`); the list sorts and filters
 * on it but shows a row only its UTC date (`updateDate`, `updateDateIncludingText`).
 * `fromDateTime` and `toDateTime` are exclusive whole-second bounds, and a
 * fractional or malformed bound is rejected. The order inside a tie (bills sharing
 * one second) changes with the request's offset, limit, and bounds, so a page
 * boundary that splits a tie repeats some of its bills and drops others. Also a
 * 200 whose JSON body pauses or stalls halfway, as a slow upstream page does.
 * @module tests/services/congress-mirror/fake-bill-list
 */

/** One bill as the fake upstream holds it: a list row plus its hidden update time. */
export type FakeBill = Record<string, unknown> & {
  congress: number;
  number: number | string;
  type: string;
  /** Second-resolution UTC update time (`YYYY-MM-DDTHH:MM:SSZ`) the list sorts on. */
  updatedAt: string;
};

/** The bill-list query parameters the fake honors. */
export interface BillListQuery {
  congress: number;
  fromDateTime?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  sort?: string | undefined;
  toDateTime?: string | undefined;
}

/** The only date-time form Congress.gov's date filters accept. */
const WHOLE_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function parseBound(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return;
  if (!WHOLE_SECOND.test(value)) {
    throw new Error(`fake bill list: ${name}=${value} does not match %Y-%m-%dT%H:%M:%SZ`);
  }
  return Date.parse(value);
}

/** FNV-1a over a string — a deterministic order that differs per request. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Answer one bill-list request the way the live list does. Only the ascending
 * update sort the mirror requests is modeled; any other sort is rejected rather
 * than answered in the wrong order.
 */
export function listBillsPage(bills: readonly FakeBill[], query: BillListQuery) {
  if (query.sort !== 'updateDate asc') {
    throw new Error(`fake bill list: sort=${query.sort} is not modeled`);
  }
  const from = parseBound(query.fromDateTime, 'fromDateTime');
  const to = parseBound(query.toDateTime, 'toDateTime');
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 20;
  const salt = `${offset}|${limit}|${query.fromDateTime ?? ''}|${query.toDateTime ?? ''}`;
  const matched = bills
    .filter((bill) => bill.congress === query.congress)
    .map((bill) => {
      const at = parseBound(bill.updatedAt, 'updatedAt') as number;
      return { bill, at, tie: fnv1a(`${bill.type}/${bill.number}|${salt}`) };
    })
    .filter(({ at }) => (from === undefined || at > from) && (to === undefined || at < to))
    .sort((a, b) => a.at - b.at || a.tie - b.tie);
  const data = matched.slice(offset, offset + limit).map(({ bill }) => {
    const { updatedAt, ...row } = bill;
    const date = updatedAt.slice(0, 10);
    return { ...row, updateDate: date, updateDateIncludingText: date };
  });
  return {
    data,
    pagination: {
      count: matched.length,
      nextOffset: offset + limit < matched.length ? offset + limit : null,
    },
  };
}

/** `count` bills of one congress, numbered from `firstNumber`, the i-th updated at `at(i)`. */
export function fakeBills(
  congress: number,
  count: number,
  firstNumber: number,
  at: (i: number) => string,
  title = (i: number) => `Bill ${firstNumber + i}`,
): FakeBill[] {
  return Array.from({ length: count }, (_, i) => ({
    congress,
    type: 'hr',
    number: firstNumber + i,
    title: title(i),
    originChamber: 'House',
    updatedAt: at(i),
  }));
}

/** `base` (`YYYY-MM-DDTHH:MM:SSZ`) moved forward by `seconds`. */
export function plusSeconds(base: string, seconds: number): string {
  return new Date(Date.parse(base) + seconds * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * A 200 carrying `body` (JSON text) in two halves: the first at once, the second
 * `pauseMs` later. Without `pauseMs` the second half never comes. Until it does,
 * `signal` aborting — the request's own, which `fetchWithTimeout` aborts at its
 * deadline — errors the read with the abort reason, as an interrupted `fetch`
 * body does.
 */
export function halvedBodyResponse(
  body: string,
  signal: AbortSignal | null | undefined,
  pauseMs?: number,
): Response {
  const bytes = new TextEncoder().encode(body);
  const half = bytes.length >> 1;
  let sent = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes.subarray(0, half));
          return;
        }
        if (signal?.aborted) {
          controller.error(signal.reason);
          return;
        }
        return new Promise<void>((resolve) => {
          const abort = () => {
            clearTimeout(timer);
            controller.error(signal?.reason);
            resolve();
          };
          signal?.addEventListener('abort', abort, { once: true });
          if (pauseMs === undefined) return;
          timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            controller.enqueue(bytes.subarray(half));
            controller.close();
            resolve();
          }, pauseMs);
        });
      },
      cancel() {
        clearTimeout(timer);
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

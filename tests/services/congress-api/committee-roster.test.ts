/**
 * @fileoverview Tests for the committee roster — paging `/committee[/{chamber}]`
 * to its end through the real API client, over a routed api.congress.gov that
 * orders tied rows afresh on each page request, as the live lists do.
 * @module tests/services/congress-api/committee-roster.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../../helpers/budget-fixtures.js';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    apiKey: 'test-api-key',
    baseUrl: 'https://api.congress.gov/v3',
  }),
}));

import { fetchAllCommittees, listedChamber } from '@/services/congress-api/committee-roster.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

const { CongressApiService } = await vi.importActual<
  typeof import('@/services/congress-api/congress-api-service.js')
>('@/services/congress-api/congress-api-service.js');

type Row = { systemCode: string; chamber: string; name: string; updateDate: string };

/** One update instant a bulk edit stamped on many rows, as Congress.gov's 2024-03-05T13:15:17Z batch. */
const TIED_AT = '2024-03-05T13:15:17.000Z';
const TIED_MS = Date.parse(TIED_AT);

/**
 * `count` rows of one chamber updated a second apart, newest first, the newest
 * `newestSeconds` after the tied instant (before it when negative).
 */
function dated(chamber: string, prefix: string, count: number, newestSeconds: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    systemCode: `${prefix}${String(i).padStart(3, '0')}`,
    chamber,
    name: `${chamber} Committee ${i}`,
    updateDate: new Date(TIED_MS + (newestSeconds - i) * 1000).toISOString(),
  }));
}

const tied = (chamber: string, codes: string[]): Row[] =>
  codes.map((systemCode) => ({
    systemCode,
    chamber,
    name: `Historical ${systemCode}`,
    updateDate: TIED_AT,
  }));

/**
 * api.congress.gov's committee lists as it pages them: newest-updated first, with
 * the rows that share an update instant in an order of each request's own —
 * ascending by code for the page at offset 0, descending for every other — so a
 * page boundary inside a tied group repeats some of its rows on both pages and
 * leaves as many on neither. A path no list serves answers 404; `fail` answers
 * a path with that response instead.
 */
function committeeLists(lists: Record<string, Row[]>, fail: Record<string, () => Response> = {}) {
  const requests: string[] = [];
  const fetch = vi.fn(async (url: string | URL) => {
    const parsed = new URL(String(url));
    if (parsed.origin !== 'https://api.congress.gov') throw new Error(`unrouted ${parsed.origin}`);
    const offset = Number(parsed.searchParams.get('offset'));
    const limit = Number(parsed.searchParams.get('limit'));
    requests.push(`${parsed.pathname}?offset=${offset}`);
    const failure = fail[parsed.pathname];
    if (failure) return failure();
    const rows = lists[parsed.pathname];
    if (!rows) {
      return new Response(JSON.stringify({ error: 'Unknown resource' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const tieOrder = offset === 0 ? 1 : -1;
    const ordered = rows.toSorted((a, b) =>
      a.updateDate === b.updateDate
        ? tieOrder * a.systemCode.localeCompare(b.systemCode)
        : a.updateDate < b.updateDate
          ? 1
          : -1,
    );
    const end = offset + limit;
    return jsonResponse({
      committees: ordered.slice(offset, end),
      pagination: {
        count: rows.length,
        ...(end < rows.length ? { next: `https://api.congress.gov${parsed.pathname}` } : {}),
      },
    });
  });
  return { fetch, requests };
}

const codesOf = (rows: readonly Record<string, unknown>[]) => rows.map((row) => row.systemCode);

/**
 * The cross-chamber shape the live roster had: rows around its 250th sharing one
 * update instant, so `/committee` lost `no94026591` and repeated `n79043123`.
 * Here each chamber list fits one page, and 247 rows are newer than the six tied
 * ones, which sit at cross-chamber ranks 247–252, across the page boundary.
 */
const HOUSE = [...dated('House', 'hx', 200, 300), ...tied('House', ['n50081225', 'n79043123'])];
const SENATE = [
  ...dated('Senate', 'sx', 47, 1000),
  ...tied('Senate', ['no2004044998', 'no94026591', 'no94032278', 'nr92040127']),
  ...dated('Senate', 'sy', 49, -1),
];
const JOINT = dated('Joint', 'jx', 10, -100);
const LISTS = {
  '/v3/committee': [...HOUSE, ...SENATE, ...JOINT],
  '/v3/committee/house': HOUSE,
  '/v3/committee/senate': SENATE,
  '/v3/committee/joint': JOINT,
};
const EVERY_CODE = codesOf(LISTS['/v3/committee']).toSorted();

describe('fetchAllCommittees', () => {
  let upstream: ReturnType<typeof committeeLists>;
  const serve = (lists: Record<string, Row[]>, fail?: Record<string, () => Response>) => {
    upstream = committeeLists(lists, fail);
    vi.stubGlobal('fetch', upstream.fetch);
  };

  beforeEach(() => {
    vi.mocked(getCongressApi).mockReturnValue(new CongressApiService());
    serve(LISTS);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the fixture loses rows the way the live cross-chamber list does', async () => {
    /** Independent of the roster: page /committee as the 0.10.0 roster did. */
    const pages = [];
    for (const offset of [0, 250]) {
      const response = await upstream.fetch(
        `https://api.congress.gov/v3/committee?offset=${offset}&limit=250`,
      );
      pages.push(...((await response.json()) as { committees: Row[] }).committees);
    }
    const codes = codesOf(pages);
    expect(new Set(codes).size).toBe(codes.length - 3);
    expect(codes).not.toContain('no94026591');
    expect(codes.filter((code) => code === 'n79043123')).toHaveLength(2);
  });

  it('reads every committee once across chambers, though /committee pages lose some', async () => {
    const roster = await fetchAllCommittees({}, createMockContext());

    expect(codesOf(roster.data).toSorted()).toEqual(EVERY_CODE);
    expect(roster.pagination).toEqual({ count: EVERY_CODE.length, nextOffset: null });
    /** One page per chamber list, read concurrently; the cross-chamber list is never read. */
    expect(upstream.requests.toSorted()).toEqual([
      '/v3/committee/house?offset=0',
      '/v3/committee/joint?offset=0',
      '/v3/committee/senate?offset=0',
    ]);
  });

  it('lists a committee the cross-chamber pages lose under the chamber its row names', async () => {
    await expect(listedChamber('no94026591', createMockContext())).resolves.toBe('senate');
    await expect(listedChamber('nr92040127', createMockContext())).resolves.toBe('senate');
    await expect(listedChamber('n79043123', createMockContext())).resolves.toBe('house');
  });

  it('orders the merged roster newest-updated first across chambers, as /committee does', async () => {
    const roster = await fetchAllCommittees({}, createMockContext());
    const dates = roster.data.map((row) => row.updateDate as string);

    expect(dates).toEqual(dates.toSorted().toReversed());
    /** The Senate's newest rows lead the House's, which a chamber-by-chamber concatenation would not. */
    expect(codesOf(roster.data).slice(0, 2)).toEqual(['sx000', 'sx001']);
    /** Rows tied on one instant keep chamber order, then each list's own. */
    expect(codesOf(roster.data.filter((row) => row.updateDate === TIED_AT))).toEqual([
      'n50081225',
      'n79043123',
      'no2004044998',
      'no94026591',
      'no94032278',
      'nr92040127',
    ]);
  });

  describe('a chamber list whose page boundary splits a tied group', () => {
    /** 300 Senate rows, the six at ranks 247–252 tied: page 250 repeats three of page 0's and drops three. */
    const SPLIT = [
      ...dated('Senate', 'sx', 247, 1000),
      ...tied('Senate', ['sa01', 'sa02', 'sa03', 'sa04', 'sa05', 'sa06']),
      ...dated('Senate', 'sy', 47, -1),
    ];

    it('re-reads the boundary with one page centred on it and returns every row once', async () => {
      serve({ '/v3/committee/senate': SPLIT });
      const roster = await fetchAllCommittees({ chamber: 'senate' }, createMockContext());

      expect(codesOf(roster.data).toSorted()).toEqual(codesOf(SPLIT).toSorted());
      expect(roster.pagination).toEqual({ count: 300, nextOffset: null });
      expect(upstream.requests).toEqual([
        '/v3/committee/senate?offset=0',
        '/v3/committee/senate?offset=250',
        '/v3/committee/senate?offset=125',
      ]);
      /** The rows the centred page restored sit in update order, not appended. */
      const dates = roster.data.map((row) => row.updateDate as string);
      expect(dates).toEqual(dates.toSorted().toReversed());
    });

    it('repairs the chamber inside the cross-chamber roster too', async () => {
      serve({
        '/v3/committee/house': HOUSE,
        '/v3/committee/senate': SPLIT,
        '/v3/committee/joint': JOINT,
      });
      const roster = await fetchAllCommittees({}, createMockContext());

      expect(codesOf(roster.data).toSorted()).toEqual(
        codesOf([...HOUSE, ...SPLIT, ...JOINT]).toSorted(),
      );
      await expect(listedChamber('sa06', createMockContext())).resolves.toBe('senate');
    });

    it('a boundary between rows of different instants costs no extra request', async () => {
      const clean = dated('House', 'hx', 455, 1000);
      serve({ '/v3/committee/house': clean });
      const roster = await fetchAllCommittees({ chamber: 'house' }, createMockContext());

      expect(roster.data).toHaveLength(455);
      expect(upstream.requests).toEqual([
        '/v3/committee/house?offset=0',
        '/v3/committee/house?offset=250',
      ]);
    });
  });

  it('reads a congress across chambers from its own list, one request when it fits a page', async () => {
    serve({ '/v3/committee/119': [...HOUSE.slice(0, 120), ...SENATE.slice(0, 90), ...JOINT] });
    const roster = await fetchAllCommittees({ congress: 119 }, createMockContext());

    expect(roster.data).toHaveLength(220);
    expect(upstream.requests).toEqual(['/v3/committee/119?offset=0']);
  });

  it('fails the roster with the classified error when one chamber list fails, with no partial roster', async () => {
    serve(LISTS, {
      '/v3/committee/senate': () =>
        new Response('Too Many Requests', {
          status: 429,
          headers: { 'content-type': 'text/plain' },
        }),
    });

    await expect(fetchAllCommittees({}, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: expect.objectContaining({ reason: 'rate_limited' }),
    });
    /** A 429 is never retried. */
    expect(upstream.requests.filter((key) => key.startsWith('/v3/committee/senate'))).toEqual([
      '/v3/committee/senate?offset=0',
    ]);
  });
});

/**
 * @fileoverview Tests for congress://committee/{committeeCode} resource.
 * @module tests/mcp-server/resources/definitions/committee.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../../../helpers/budget-fixtures.js';
import { committeeListRoutes, losingRow } from '../../../helpers/committee-lists.js';
import { resourcesReader } from '../../../helpers/resources-read.js';

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

import { committeeResource } from '@/mcp-server/resources/definitions/committee.resource.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

/** The real API client, for the cases where the requests a read spends are under test. */
const { CongressApiService } = await vi.importActual<
  typeof import('@/services/congress-api/congress-api-service.js')
>('@/services/congress-api/congress-api-service.js');

describe('committeeResource', () => {
  const mockApi = {
    getCommittee: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('infers house chamber from h-prefix code', async () => {
    const ctx = createMockContext();
    mockApi.getCommittee.mockResolvedValue({ committee: { name: 'Judiciary' } });
    const params = committeeResource.params!.parse({ committeeCode: 'hsju00' });
    await committeeResource.handler(params, ctx);
    expect(mockApi.getCommittee).toHaveBeenCalledWith('house', 'hsju00', ctx);
  });

  it('infers senate chamber from s-prefix code', async () => {
    const ctx = createMockContext();
    mockApi.getCommittee.mockResolvedValue({ committee: { name: 'Finance' } });
    const params = committeeResource.params!.parse({ committeeCode: 'ssfi00' });
    await committeeResource.handler(params, ctx);
    expect(mockApi.getCommittee).toHaveBeenCalledWith('senate', 'ssfi00', ctx);
  });

  it('infers joint chamber from j-prefix code', async () => {
    const ctx = createMockContext();
    mockApi.getCommittee.mockResolvedValue({ committee: { name: 'Joint Economic' } });
    const params = committeeResource.params!.parse({ committeeCode: 'jsec00' });
    await committeeResource.handler(params, ctx);
    expect(mockApi.getCommittee).toHaveBeenCalledWith('joint', 'jsec00', ctx);
  });

  it('returns committee data', async () => {
    const ctx = createMockContext();
    const committeeData = { name: 'Judiciary', chamber: 'House' };
    mockApi.getCommittee.mockResolvedValue({ committee: committeeData });
    const params = committeeResource.params!.parse({ committeeCode: 'hsju00' });
    const result = await committeeResource.handler(params, ctx);
    expect(result).toEqual(committeeData);
  });
});

/**
 * #113: only a not_found in the prefix's chamber sends the read to the roster,
 * and only a roster row in another chamber earns a second read.
 */
describe('committeeResource when the prefix chamber read fails', () => {
  const mockApi = { getCommittee: vi.fn(), listCommittees: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it.each([
    ['ServiceUnavailable', JsonRpcErrorCode.ServiceUnavailable],
    ['RateLimited', JsonRpcErrorCode.RateLimited],
    ['Timeout', JsonRpcErrorCode.Timeout],
  ])(
    'rethrows a %s from the prefix chamber as is, with no roster read and no second read',
    async (_label, code) => {
      const failure = new McpError(code, 'Congress.gov could not answer.');
      mockApi.getCommittee.mockRejectedValue(failure);
      /** The roster lists jsat00 in the Senate, so a roster read would send a second read there. */
      mockApi.listCommittees.mockResolvedValue({
        data: [{ systemCode: 'jsat00', chamber: 'Senate', name: 'Joint Atomic Energy Committee' }],
        pagination: { count: 1, nextOffset: null },
      });
      const params = committeeResource.params!.parse({ committeeCode: 'jsat00' });

      await expect(committeeResource.handler(params, createMockContext())).rejects.toBe(failure);
      expect(mockApi.listCommittees).not.toHaveBeenCalled();
      expect(mockApi.getCommittee).toHaveBeenCalledOnce();
    },
  );

  it("keeps the prefix chamber's not_found, with one read, for a code the roster lists in that chamber", async () => {
    const notFound = new McpError(JsonRpcErrorCode.NotFound, 'Committee hsgo00 not found.');
    mockApi.getCommittee.mockRejectedValue(notFound);
    mockApi.listCommittees.mockResolvedValue({
      data: [{ systemCode: 'hsgo00', chamber: 'House', name: 'Gone Committee' }],
      pagination: { count: 1, nextOffset: null },
    });
    const params = committeeResource.params!.parse({ committeeCode: 'hsgo00' });

    await expect(committeeResource.handler(params, createMockContext())).rejects.toBe(notFound);
    expect(mockApi.listCommittees).toHaveBeenCalled();
    expect(mockApi.getCommittee.mock.calls.map(([chamber, code]) => [chamber, code])).toEqual([
      ['house', 'hsgo00'],
    ]);
  });
});

/**
 * #113: every code in the committee roster reads. The prefix's chamber is read
 * first; only a not_found there, or a prefix that names no chamber, reads the
 * cross-chamber roster — the three chamber lists — and repeats the read in the
 * chamber the code's row lists. The real API client runs over a routed
 * api.congress.gov that counts requests.
 */
describe('committeeResource over the committee roster', () => {
  /** Codes as the live roster lists them, each on its chamber list's second page. */
  const LISTED = [
    { systemCode: 'hsju00', chamber: 'House', name: 'Judiciary Committee' },
    { systemCode: 'jsat00', chamber: 'Senate', name: 'Joint Atomic Energy Committee' },
    { systemCode: 'jtdr00', chamber: 'Senate', name: 'Senate Joint Deficit Reduction Committee' },
    {
      systemCode: 'jsec03',
      chamber: 'Senate',
      name: 'Economic Goals and Intergovernmental Policy Subcommittee',
    },
    { systemCode: 'n79043125', chamber: 'Senate', name: 'Indian Affairs Committee' },
    { systemCode: 'nr92040127', chamber: 'Senate', name: 'Pensions' },
    { systemCode: 'no2010049600', chamber: 'House', name: 'Ventilation and Acoustics Committee' },
    {
      systemCode: 'sp2k00',
      chamber: 'Senate',
      name: 'Year 2000 Technology Problem (Special) Committee',
    },
    { systemCode: 'no94026591', chamber: 'Senate', name: 'Printing' },
  ];
  const placeholders = (chamber: string, prefix: string, length: number) =>
    Array.from({ length }, (_, i) => ({
      systemCode: `${prefix}${String(i).padStart(3, '0')}`,
      chamber,
      name: `Placeholder Committee ${i}`,
    }));
  const CHAMBER_LISTS = {
    '/v3/committee/house': [
      ...placeholders('House', 'hxpl', 290),
      ...LISTED.filter((row) => row.chamber === 'House'),
    ],
    '/v3/committee/senate': [
      ...placeholders('Senate', 'sxpl', 260),
      ...LISTED.filter((row) => row.chamber === 'Senate'),
    ],
    '/v3/committee/joint': placeholders('Joint', 'jxpl', 10),
  };
  /** Every page of the three chamber lists: what the cross-chamber roster costs. */
  const ROSTER_HITS = Object.fromEntries(
    Object.entries(CHAMBER_LISTS).flatMap(([path, rows]) =>
      Object.keys(committeeListRoutes(path, rows)).map((key) => [key, 1]),
    ),
  );

  const routes: Record<string, unknown> = Object.assign(
    {},
    ...Object.entries(CHAMBER_LISTS).map(([path, rows]) => committeeListRoutes(path, rows)),
    /** `/committee` as it pages live, losing Printing; the roster never reads it. */
    committeeListRoutes(
      '/v3/committee',
      losingRow(Object.values(CHAMBER_LISTS).flat(), 'no94026591'),
    ),
  );
  /** Each listed code answers only in the chamber its row lists, as api.congress.gov does. */
  for (const row of LISTED) {
    routes[`/v3/committee/${row.chamber.toLowerCase()}/${row.systemCode}`] = {
      committee: {
        systemCode: row.systemCode,
        type: 'Standing',
        history: [{ officialName: row.name }],
      },
    };
  }

  /** api.congress.gov over `routes`, keyed by path plus any `offset`; anything else answers 404. */
  function congressGov() {
    const hits: Record<string, number> = {};
    const fetch = (url: string | URL): Promise<Response> => {
      const parsed = new URL(String(url));
      const offset = parsed.searchParams.get('offset');
      const key = offset === null ? parsed.pathname : `${parsed.pathname}?offset=${offset}`;
      hits[key] = (hits[key] ?? 0) + 1;
      const body = routes[key];
      return Promise.resolve(
        body === undefined
          ? new Response(JSON.stringify({ error: 'No Committee matches the given query.' }), {
              status: 404,
              headers: { 'content-type': 'application/json' },
            })
          : jsonResponse(body),
      );
    };
    return { fetch, hits };
  }

  async function read(committeeCode: string) {
    const upstream = congressGov();
    vi.stubGlobal('fetch', upstream.fetch);
    const params = committeeResource.params!.parse({ committeeCode });
    const result = committeeResource.handler(params, createMockContext());
    return { result, hits: upstream.hits };
  }

  beforeEach(() => {
    vi.mocked(getCongressApi).mockReturnValue(new CongressApiService());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['hsju00', 'house', 'Judiciary Committee'],
    ['sp2k00', 'senate', 'Year 2000 Technology Problem (Special) Committee'],
  ])(
    "%s, which its prefix's chamber holds, costs one request and no roster read",
    async (code, chamber, name) => {
      const { result, hits } = await read(code);

      await expect(result).resolves.toMatchObject({ name, chamber, systemCode: code });
      expect(hits).toEqual({ [`/v3/committee/${chamber}/${code}`]: 1 });
    },
  );

  it.each(['jsat00', 'jtdr00', 'jsec03'])(
    "%s is read in the Senate after its prefix's joint chamber answers 404",
    async (code) => {
      const { result, hits } = await read(code);

      await expect(result).resolves.toMatchObject({ chamber: 'senate', systemCode: code });
      expect(hits).toEqual({
        [`/v3/committee/joint/${code}`]: 1,
        ...ROSTER_HITS,
        [`/v3/committee/senate/${code}`]: 1,
      });
    },
  );

  it.each([
    ['n79043125', 'senate', 'Indian Affairs Committee'],
    ['nr92040127', 'senate', 'Pensions'],
    ['no2010049600', 'house', 'Ventilation and Acoustics Committee'],
  ])(
    '%s, whose prefix names no chamber, is read in the %s chamber its roster row lists',
    async (code, chamber, name) => {
      const { result, hits } = await read(code);

      await expect(result).resolves.toMatchObject({ name, chamber, systemCode: code });
      expect(hits).toEqual({ ...ROSTER_HITS, [`/v3/committee/${chamber}/${code}`]: 1 });
    },
  );

  it('no94026591, which the cross-chamber list pages lose, is read in the Senate its chamber list names', async () => {
    const { result, hits } = await read('no94026591');

    await expect(result).resolves.toMatchObject({
      name: 'Printing',
      chamber: 'senate',
      systemCode: 'no94026591',
    });
    expect(hits).toEqual({ ...ROSTER_HITS, '/v3/committee/senate/no94026591': 1 });
  });

  it.each([
    ['HSJU00', 'hsju00', 'house', { '/v3/committee/house/hsju00': 1 }],
    ['N79043125', 'n79043125', 'senate', { ...ROSTER_HITS, '/v3/committee/senate/n79043125': 1 }],
    /** A percent-encoded segment is decoded once before the pattern check. */
    ['%6E79043125', 'n79043125', 'senate', { ...ROSTER_HITS, '/v3/committee/senate/n79043125': 1 }],
    ['%48SJU00', 'hsju00', 'house', { '/v3/committee/house/hsju00': 1 }],
  ])('%s reads like %s', async (given, code, chamber, expectedHits) => {
    expect(committeeResource.params!.parse({ committeeCode: given })).toEqual({
      committeeCode: code,
    });
    const { result, hits } = await read(given);

    await expect(result).resolves.toMatchObject({ chamber, systemCode: code });
    expect(hits).toEqual(expectedHits);
  });

  it("a code the roster lacks keeps the not_found its prefix's chamber answered", async () => {
    const { result, hits } = await read('hsxx99');

    await expect(result).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('Committee hsxx99 not found in the house chamber.'),
      data: { chamber: 'house', committeeCode: 'hsxx99' },
    });
    expect(hits).toEqual({ '/v3/committee/house/hsxx99': 1, ...ROSTER_HITS });
  });

  it.each(['zz123456', 'constructor', 'n00000000'])(
    '%s, whose prefix names no chamber and which the roster lacks, is not_found after the roster alone',
    async (code) => {
      const { result, hits } = await read(code);

      await expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: `Committee ${code} is not in the committee roster. Call \`congressgov_committee_lookup\` with \`operation: 'list'\` and an optional \`filter\` to discover valid codes.`,
        data: { committeeCode: code },
      });
      expect(hits).toEqual(ROSTER_HITS);
    },
  );

  it('accepts every code shape the roster carries: lowercase letters and digits', () => {
    for (const code of [...LISTED.map((row) => row.systemCode), 'no2013136533', 'ssju01']) {
      expect(committeeResource.params!.safeParse({ committeeCode: code }).success).toBe(true);
    }
  });

  it.each(['hsju-00', 'hs ju00', 'hsju%2000', '%E0%A4%A', '__proto__', '../hsju00', ''])(
    'refuses %j, which holds a character other than letters and digits',
    (committeeCode) => {
      expect(committeeResource.params!.safeParse({ committeeCode }).success).toBe(false);
    },
  );
});

/**
 * The URI grammar as a client meets it: `resources/read` through the framework's
 * resource factory, where a `params` rejection answers -32007 (ValidationError)
 * before the handler runs.
 */
describe('congress://committee/{committeeCode} over resources/read', () => {
  const resourcesRead = resourcesReader([committeeResource]);
  const mockApi = { getCommittee: vi.fn(), listCommittees: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
    mockApi.getCommittee.mockResolvedValue({
      committee: {
        systemCode: 'hsju00',
        history: [{ officialName: 'Committee on the Judiciary' }],
      },
    });
  });

  it.each(['congress://committee/HSJU00', 'congress://committee/%68sju00'])(
    '%s reads hsju00 in the House',
    async (uri) => {
      const body = await resourcesRead(uri);

      expect(body.error).toBeUndefined();
      expect(mockApi.getCommittee).toHaveBeenCalledWith('house', 'hsju00', expect.anything());
      expect(JSON.parse(body.result?.contents[0]?.text ?? '{}')).toMatchObject({
        name: 'Committee on the Judiciary',
        chamber: 'house',
      });
    },
  );

  it.each([
    'congress://committee/hsju-00',
    'congress://committee/__proto__',
    'congress://committee/%E0%A4%A',
  ])('%s fails the param schema with -32007 before any request', async (uri) => {
    const body = await resourcesRead(uri);

    expect(body.error?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(mockApi.getCommittee).not.toHaveBeenCalled();
    expect(mockApi.listCommittees).not.toHaveBeenCalled();
  });
});

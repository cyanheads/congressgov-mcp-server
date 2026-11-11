/**
 * @fileoverview Tests for congressgov_committee_lookup tool.
 * @module tests/mcp-server/tools/definitions/committee-lookup.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_TIMEOUT_MS,
  contentText,
  expectBudgetTimeout,
  jsonResponse,
  scriptedCongressApi,
  track,
  useFakeClock,
} from '../../../helpers/budget-fixtures.js';
import { committeeListRoutes, losingRow } from '../../../helpers/committee-lists.js';

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

import { committeeLookupTool } from '@/mcp-server/tools/definitions/committee-lookup.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

/** The real API client, for the cases where the call budget across chained requests is under test. */
const { CongressApiService } = await vi.importActual<
  typeof import('@/services/congress-api/congress-api-service.js')
>('@/services/congress-api/congress-api-service.js');

const HOUSE_COMMITTEES = [
  { name: 'Transportation and Infrastructure Committee', systemCode: 'hspw00', chamber: 'house' },
  { name: 'Judiciary Committee', systemCode: 'hsju00', chamber: 'house' },
  { name: 'Armed Services Committee', systemCode: 'hsas00', chamber: 'house' },
  { name: 'Ways and Means Committee', systemCode: 'hswm00', chamber: 'house' },
  { name: 'Science, Space, and Technology Committee', systemCode: 'hssy00', chamber: 'house' },
  {
    name: 'Coast Guard and Maritime Transportation Subcommittee',
    systemCode: 'hspw07',
    chamber: 'house',
  },
  // Noise control: on a full-name bigram match this shares enough with "transportation"
  // to surface, but its best token ("population") stays below the fuzzy threshold — it
  // must NOT appear as an approximate match.
  { name: 'Population Committee', systemCode: 'hlze00', chamber: 'house' },
];

/** A `listCommittees` that serves a House list of 251 rows across two pages, `first` then `second`, and empty Senate and Joint lists. */
function houseListInTwoPages(first: unknown[], second: unknown[]) {
  return async (params: Record<string, unknown>) =>
    params.chamber !== 'house'
      ? { data: [], pagination: { count: 0, nextOffset: null } }
      : params.offset === 0
        ? { data: first, pagination: { count: 251, nextOffset: 250 } }
        : { data: second, pagination: { count: 251, nextOffset: null } };
}

describe('committeeLookupTool', () => {
  const mockApi = {
    listCommittees: vi.fn(),
    getCommittee: vi.fn(),
    getCommitteeSubResource: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('lists committees', async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    mockApi.listCommittees.mockResolvedValue({
      data: [{ name: 'Judiciary' }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = committeeLookupTool.input.parse({ operation: 'list' });
    const result = await committeeLookupTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
  });

  it('lists committees filtered by chamber and congress', async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    mockApi.listCommittees.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = committeeLookupTool.input.parse({
      operation: 'list',
      congress: 118,
      chamber: 'senate',
    });
    await committeeLookupTool.handler(input, ctx);
    expect(mockApi.listCommittees).toHaveBeenCalledWith(
      expect.objectContaining({ congress: 118, chamber: 'senate' }),
      ctx,
    );
  });

  it('gets a specific committee', async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    mockApi.getCommittee.mockResolvedValue({ committee: { name: 'Judiciary' } });
    const input = committeeLookupTool.input.parse({
      operation: 'get',
      chamber: 'house',
      committeeCode: 'hsju00',
    });
    const result = await committeeLookupTool.handler(input, ctx);
    expect(result.committee).toEqual({ name: 'Judiciary' });
    expect(mockApi.getCommittee).toHaveBeenCalledWith('house', 'hsju00', ctx);
  });

  it('throws when get is missing chamber or committeeCode', async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    const input = committeeLookupTool.input.parse({ operation: 'get' });
    await expect(committeeLookupTool.handler(input, ctx)).rejects.toThrow(/requires/);
  });

  // ── #39/#46: committeeCode schema guard + auto-resolve ───────────────────────

  it('rejects an empty committeeCode at schema parse time', () => {
    expect(() =>
      committeeLookupTool.input.parse({ operation: 'get', committeeCode: '' }),
    ).toThrow();
  });

  it('rejects a whitespace-only committeeCode at schema parse time', () => {
    expect(() =>
      committeeLookupTool.input.parse({ operation: 'get', committeeCode: '   ' }),
    ).toThrow();
  });

  it('accepts a single-word committee name at schema parse time', () => {
    expect(() =>
      committeeLookupTool.input.parse({ operation: 'get', committeeCode: 'Judiciary' }),
    ).not.toThrow();
  });

  it('accepts a code-shaped token with the wrong digit count at schema parse time', () => {
    // #39 rejected 'ssbk' here; #46 moves the rejection to the handler's resolver
    // so real single-word names ('Judiciary') are no longer collateral damage.
    expect(() =>
      committeeLookupTool.input.parse({ operation: 'get', committeeCode: 'ssbk' }),
    ).not.toThrow();
  });

  describe('committeeCode auto-resolve for name-like input', () => {
    const PARENT_COMMITTEES = [
      {
        name: 'Transportation and Infrastructure Committee',
        systemCode: 'hspw00',
        chamber: 'house',
      },
      { name: 'Judiciary Committee', systemCode: 'hsju00', chamber: 'house' },
      { name: 'Armed Services Committee', systemCode: 'hsas00', chamber: 'house' },
      { name: 'Senate Banking Committee', systemCode: 'ssbk00', chamber: 'senate' },
      { name: 'Senate Finance Committee', systemCode: 'ssfi00', chamber: 'senate' },
      {
        name: 'Senate Small Business and Entrepreneurship',
        systemCode: 'sssb00',
        chamber: 'senate',
      },
      // Subcommittee — excluded from parent-only filter (systemCode does not end '00')
      {
        name: 'Coast Guard and Maritime Transportation Subcommittee',
        systemCode: 'hspw07',
        chamber: 'house',
      },
    ];

    beforeEach(() => {
      mockApi.listCommittees.mockResolvedValue({
        data: PARENT_COMMITTEES,
        pagination: { count: PARENT_COMMITTEES.length, nextOffset: null },
      });
    });

    it('single-word name resolves to a code and proceeds with get', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      mockApi.getCommittee.mockResolvedValue({ committee: { name: 'Judiciary Committee' } });
      const input = committeeLookupTool.input.parse({
        operation: 'get',
        committeeCode: 'Judiciary',
      });
      const result = await committeeLookupTool.handler(input, ctx);
      expect(mockApi.getCommittee).toHaveBeenCalledWith('house', 'hsju00', ctx);
      expect(result.committee).toEqual({ name: 'Judiciary Committee' });
      expect(getEnrichment(ctx).notice).toContain('hsju00');
    });

    it('single-word name routes a sub-resource operation through resolution too', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      mockApi.getCommitteeSubResource.mockResolvedValue({
        data: [],
        pagination: { count: 0, nextOffset: null },
      });
      const input = committeeLookupTool.input.parse({
        operation: 'reports',
        committeeCode: 'Judiciary',
      });
      await committeeLookupTool.handler(input, ctx);
      expect(mockApi.getCommitteeSubResource).toHaveBeenCalledWith(
        expect.objectContaining({ committeeCode: 'hsju00', subResource: 'reports' }),
        ctx,
      );
    });

    it('code-shaped token with the wrong digit count resolves to zero candidates with an actionable notice', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      const input = committeeLookupTool.input.parse({
        operation: 'get',
        committeeCode: 'ssbk',
      });
      const result = await committeeLookupTool.handler(input, ctx);
      expect(result.data).toHaveLength(0);
      expect(mockApi.getCommittee).not.toHaveBeenCalled();
      // #39's guidance survives the move from schema to handler: the notice routes
      // the caller to a systemCode from 'list' and to list+filter for a name (#114
      // dropped the claim that every code is letters + a 2-digit suffix).
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toBe(
        "No committee code or name matched 'ssbk'. Pass a systemCode from operation:'list' (e.g. 'hsju00'), or use operation:'list' with filter to find a committee by name.",
      );
    });

    it('accepts an uppercase code shape and normalizes it to lowercase', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      mockApi.getCommittee.mockResolvedValue({ committee: { name: 'Judiciary Committee' } });
      const input = committeeLookupTool.input.parse({
        operation: 'get',
        committeeCode: 'HSJU00',
      });
      await committeeLookupTool.handler(input, ctx);
      expect(mockApi.getCommittee).toHaveBeenCalledWith('house', 'hsju00', ctx);
      expect(mockApi.listCommittees).not.toHaveBeenCalled();
    });

    it('a valid code shape is never routed through name resolution', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      mockApi.getCommittee.mockResolvedValue({ committee: { name: 'Senate Banking Committee' } });
      const input = committeeLookupTool.input.parse({
        operation: 'get',
        committeeCode: 'ssbk00',
      });
      await committeeLookupTool.handler(input, ctx);
      expect(mockApi.listCommittees).not.toHaveBeenCalled();
      expect(mockApi.getCommittee).toHaveBeenCalledWith('senate', 'ssbk00', ctx);
    });

    it('zero matches — returns empty candidates without calling getCommittee', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      const input = committeeLookupTool.input.parse({
        operation: 'get',
        committeeCode: 'house zzznomatch',
      });
      const result = await committeeLookupTool.handler(input, ctx);
      expect(result.data).toHaveLength(0);
      expect(mockApi.getCommittee).not.toHaveBeenCalled();
    });

    it('one match — resolves to code and proceeds with get', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      mockApi.getCommittee.mockResolvedValue({ committee: { name: 'Senate Banking Committee' } });
      const input = committeeLookupTool.input.parse({
        operation: 'get',
        committeeCode: 'senate banking',
      });
      const result = await committeeLookupTool.handler(input, ctx);
      expect(result.committee).toEqual({ name: 'Senate Banking Committee' });
      expect(mockApi.getCommittee).toHaveBeenCalledWith('senate', 'ssbk00', ctx);
    });

    it('multiple matches — returns candidates without calling getCommittee', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      // 'senate committee' matches both Senate Banking and Senate Small Business
      const input = committeeLookupTool.input.parse({
        operation: 'get',
        committeeCode: 'senate committee',
      });
      const result = await committeeLookupTool.handler(input, ctx);
      expect((result.data as unknown[]).length).toBeGreaterThan(1);
      expect(mockApi.getCommittee).not.toHaveBeenCalled();
    });

    it('candidate responses declare effectiveQuery — the enrichment block requires it', async () => {
      // The zero/multiple-candidate branch returns before any operation-specific
      // echo runs; without its own echo the response fails enrichment validation
      // over the wire, which a mocked context does not enforce.
      for (const committeeCode of ['house zzznomatch', 'ssbk', 'senate committee']) {
        const ctx = createMockContext({ errors: committeeLookupTool.errors });
        const input = committeeLookupTool.input.parse({ operation: 'get', committeeCode });
        await committeeLookupTool.handler(input, ctx);
        const effectiveQuery = getEnrichment(ctx).effectiveQuery;
        expect(effectiveQuery).toEqual(expect.any(String));
        expect(effectiveQuery as string).toContain(committeeCode);
      }
    });

    it('subcommittees excluded from auto-resolve candidates (parent-only filter)', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      // 'maritime transportation' would match the subcommittee hspw07 but not any parent
      mockApi.getCommittee.mockResolvedValue({
        committee: { name: 'Transportation and Infrastructure Committee' },
      });
      const input = committeeLookupTool.input.parse({
        operation: 'get',
        committeeCode: 'transportation infrastructure',
      });
      const result = await committeeLookupTool.handler(input, ctx);
      // hspw00 matches; hspw07 is excluded (not ending '00')
      expect(mockApi.getCommittee).toHaveBeenCalledWith('house', 'hspw00', ctx);
      expect(result.committee).toEqual({ name: 'Transportation and Infrastructure Committee' });
    });

    it('pages every chamber list to resolve a name past the first 250', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      // Resolution reads all three chamber lists. The match sits on the House
      // list's second page — the single-fetch bug would never have seen it.
      const page1 = Array.from({ length: 250 }, (_, i) => ({
        name: `Placeholder Committee ${i}`,
        systemCode: `xxpl${String(i).padStart(3, '0')}`,
        chamber: 'house',
      }));
      const page2 = [
        { name: 'Veterans Affairs Committee', systemCode: 'hsvr00', chamber: 'house' },
      ];
      mockApi.listCommittees.mockImplementation(houseListInTwoPages(page1, page2));
      mockApi.getCommittee.mockResolvedValue({
        committee: { name: 'Veterans Affairs Committee' },
      });
      const input = committeeLookupTool.input.parse({
        operation: 'get',
        committeeCode: 'veterans affairs',
      });
      const result = await committeeLookupTool.handler(input, ctx);
      expect(
        mockApi.listCommittees.mock.calls.map(([params]) => [params.chamber, params.offset]),
      ).toEqual([
        ['house', 0],
        ['senate', 0],
        ['joint', 0],
        ['house', 250],
      ]);
      expect(mockApi.getCommittee).toHaveBeenCalledWith('house', 'hsvr00', ctx);
      expect(result.committee).toEqual({ name: 'Veterans Affairs Committee' });
    });
  });

  it('throws when nominations requested for non-senate committee', async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    const input = committeeLookupTool.input.parse({
      operation: 'nominations',
      chamber: 'house',
      committeeCode: 'hsju00',
    });
    await expect(committeeLookupTool.handler(input, ctx)).rejects.toThrow(/Senate/);
  });

  // ── #97: inputs an operation doesn't use are refused or disclosed ──────────

  describe('inputs the operation does not use', () => {
    const billsPage = {
      data: [{ congress: 119, billType: 'SRES', billNumber: '950' }],
      pagination: { count: 21_065, nextOffset: 20 },
    };

    it("refuses a committee code on 'list' before any request", async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      const input = committeeLookupTool.input.parse({ operation: 'list', committeeCode: 'ssju00' });

      await expect(committeeLookupTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining("'get'"),
        data: { reason: 'incompatible_identity', field: 'committeeCode', operation: 'list' },
      });
      expect(mockApi.listCommittees).not.toHaveBeenCalled();
    });

    it("points a committee name on 'list' at filter", async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      const input = committeeLookupTool.input.parse({
        operation: 'list',
        committeeCode: 'Judiciary',
      });

      await expect(committeeLookupTool.handler(input, ctx)).rejects.toMatchObject({
        message: expect.stringContaining("filter: 'Judiciary'"),
        data: { reason: 'incompatible_identity', field: 'committeeCode', operation: 'list' },
      });
      expect(mockApi.listCommittees).not.toHaveBeenCalled();
    });

    it('serves committee bills and says the congress filter spans every congress', async () => {
      mockApi.getCommitteeSubResource.mockResolvedValue(structuredClone(billsPage));

      const result = await runToolContract(committeeLookupTool, {
        operation: 'bills',
        committeeCode: 'ssju00',
        congress: 118,
        order: 'oldest',
      });

      expect(result.isError).toBeFalsy();
      expect(mockApi.getCommitteeSubResource).toHaveBeenCalledWith(
        {
          chamber: 'senate',
          committeeCode: 'ssju00',
          subResource: 'bills',
          limit: 20,
          offset: 0,
        },
        expect.anything(),
      );
      const notice =
        "'bills' does not use congress, so it was ignored. Results span every congress.";
      expect(result.structuredContent).toMatchObject({ ...billsPage, notice });
      const content = (result.content as Array<{ type: string; text?: string }>)
        .map((block) => block.text ?? '')
        .join('\n');
      expect(content).toContain('950');
      expect(content).toContain(notice);
    });

    it("names congress and filter on 'get', without the every-congress sentence", async () => {
      mockApi.getCommittee.mockResolvedValue({ committee: { name: 'Judiciary' } });
      const ctx = createMockContext({ errors: committeeLookupTool.errors });

      await committeeLookupTool.handler(
        committeeLookupTool.input.parse({
          operation: 'get',
          committeeCode: 'ssju00',
          congress: 118,
          filter: 'judiciary',
        }),
        ctx,
      );

      expect(getEnrichment(ctx).notice).toBe(
        "'get' does not use congress or filter, so they were ignored.",
      );
    });

    it('treats a blank filter as unset', async () => {
      mockApi.getCommittee.mockResolvedValue({ committee: { name: 'Judiciary' } });
      const ctx = createMockContext({ errors: committeeLookupTool.errors });

      await committeeLookupTool.handler(
        committeeLookupTool.input.parse({
          operation: 'get',
          committeeCode: 'ssju00',
          filter: '  ',
        }),
        ctx,
      );

      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('composes with name resolution and the empty-result notice', async () => {
      mockApi.listCommittees.mockResolvedValue({
        data: [{ name: 'Judiciary Committee', systemCode: 'hsju00', chamber: 'house' }],
        pagination: { count: 1, nextOffset: null },
      });
      mockApi.getCommitteeSubResource.mockResolvedValue({
        data: [],
        pagination: { count: 0, nextOffset: null },
      });
      const ctx = createMockContext({ errors: committeeLookupTool.errors });

      await committeeLookupTool.handler(
        committeeLookupTool.input.parse({
          operation: 'reports',
          committeeCode: 'Judiciary',
          congress: 118,
        }),
        ctx,
      );

      expect(getEnrichment(ctx).notice).toBe(
        "'reports' does not use congress, so it was ignored. Results span every congress. Resolved 'Judiciary' → hsju00 (Judiciary Committee). No reports found for committee hsju00.",
      );
    });

    it('stays silent when no list-only filter is supplied', async () => {
      mockApi.getCommitteeSubResource.mockResolvedValue(structuredClone(billsPage));
      const ctx = createMockContext({ errors: committeeLookupTool.errors });

      await committeeLookupTool.handler(
        committeeLookupTool.input.parse({
          operation: 'bills',
          committeeCode: 'ssju00',
          order: 'oldest',
        }),
        ctx,
      );

      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it("applies congress and filter on 'list' without a notice", async () => {
      mockApi.listCommittees.mockResolvedValue({
        data: HOUSE_COMMITTEES,
        pagination: { count: HOUSE_COMMITTEES.length, nextOffset: null },
      });
      const ctx = createMockContext({ errors: committeeLookupTool.errors });

      await committeeLookupTool.handler(
        committeeLookupTool.input.parse({ operation: 'list', congress: 118, filter: 'judiciary' }),
        ctx,
      );

      expect(mockApi.listCommittees).toHaveBeenCalledWith(
        expect.objectContaining({ congress: 118 }),
        ctx,
      );
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it.each(['..', '-', ' . '])(
      'rejects committeeCode %j, which has no letter or digit, before any request',
      async (committeeCode) => {
        const result = await runToolContract(committeeLookupTool, {
          operation: 'get',
          committeeCode,
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams },
        });
        expect(mockApi.listCommittees).not.toHaveBeenCalled();
        expect(mockApi.getCommittee).not.toHaveBeenCalled();
      },
    );

    it('declares the refusal and marks the list-only filters', () => {
      expect(committeeLookupTool.errors?.map((contract) => contract.reason)).toContain(
        'incompatible_identity',
      );
      const shape = committeeLookupTool.input.shape;
      expect(shape.congress.description).toContain("'list' only");
      expect(shape.filter.description).toContain("'list' only");
    });
  });

  // ── #112: chamber in the capitalized form committee rows carry ─────────────

  describe('chamber in any letter case', () => {
    it("reads 'Senate' on 'get' as senate", async () => {
      mockApi.getCommittee.mockResolvedValue({ committee: { name: 'Judiciary Committee' } });
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      const input = committeeLookupTool.input.parse({
        operation: 'get',
        committeeCode: 'ssju00',
        chamber: 'Senate',
      });

      expect(input.chamber).toBe('senate');
      const result = await committeeLookupTool.handler(input, ctx);
      expect(mockApi.getCommittee).toHaveBeenCalledWith('senate', 'ssju00', ctx);
      expect(result.committee).toEqual({ name: 'Judiciary Committee' });
    });

    it("reads 'HOUSE' on 'list' as house", async () => {
      mockApi.listCommittees.mockResolvedValue({
        data: [HOUSE_COMMITTEES[1]],
        pagination: { count: 1, nextOffset: null },
      });
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      const result = await committeeLookupTool.handler(
        committeeLookupTool.input.parse({ operation: 'list', chamber: 'HOUSE' }),
        ctx,
      );

      expect(mockApi.listCommittees).toHaveBeenCalledWith(
        { congress: undefined, chamber: 'house', limit: 20, offset: 0 },
        ctx,
      );
      expect(result.data).toEqual([HOUSE_COMMITTEES[1]]);
      expect(getEnrichment(ctx).effectiveQuery).toBe('committees (chamber=house)');
    });

    it("resolves a name among the 'Joint' chamber's committees as joint", async () => {
      mockApi.listCommittees.mockResolvedValue({
        data: [{ name: 'Joint Committee on Taxation', systemCode: 'jstx00', chamber: 'Joint' }],
        pagination: { count: 1, nextOffset: null },
      });
      mockApi.getCommittee.mockResolvedValue({
        committee: { name: 'Joint Committee on Taxation' },
      });
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      await committeeLookupTool.handler(
        committeeLookupTool.input.parse({
          operation: 'get',
          committeeCode: 'taxation',
          chamber: 'Joint',
        }),
        ctx,
      );

      expect(mockApi.listCommittees).toHaveBeenCalledWith(
        { congress: undefined, chamber: 'joint', limit: 250, offset: 0 },
        ctx,
      );
      expect(mockApi.getCommittee).toHaveBeenCalledWith('joint', 'jstx00', ctx);
      expect(getEnrichment(ctx).notice).toBe(
        "Resolved 'taxation' → jstx00 (Joint Committee on Taxation).",
      );
    });

    it('leaves chamber optional', () => {
      expect(committeeLookupTool.input.parse({ operation: 'list' }).chamber).toBeUndefined();
    });

    it.each(['senat', 'Senat', 'both'])(
      'still rejects %j, which names no chamber, before any request',
      async (chamber) => {
        expect(
          committeeLookupTool.input.safeParse({
            operation: 'get',
            committeeCode: 'ssju00',
            chamber,
          }).success,
        ).toBe(false);
        const result = await runToolContract(committeeLookupTool, {
          operation: 'get',
          committeeCode: 'ssju00',
          chamber,
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.InvalidParams,
            message: expect.stringContaining('chamber'),
          },
        });
        expect(mockApi.getCommittee).not.toHaveBeenCalled();
      },
    );

    it('advertises the lowercase chamber values, optional, with no default', () => {
      const json = z.toJSONSchema(committeeLookupTool.input, { io: 'input' }) as {
        properties: Record<string, Record<string, unknown>>;
        required?: string[];
      };
      expect(json.properties.chamber).toEqual({
        description:
          "Chamber filter for 'list'. For 'get' and sub-resources, the committee's chamber, inferred when omitted; set it to resolve a committee name given as committeeCode among that chamber's committees only.",
        type: 'string',
        enum: ['house', 'senate', 'joint'],
      });
      expect(json.required).toEqual(['operation']);
    });
  });

  // ── #38: filter param on list ─────────────────────────────────────────────

  describe('filter on list', () => {
    beforeEach(() => {
      mockApi.listCommittees.mockResolvedValue({
        data: HOUSE_COMMITTEES,
        pagination: { count: HOUSE_COMMITTEES.length, nextOffset: null },
      });
    });

    it('pages through the full committee set (250 per page) until nextOffset is null', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      mockApi.listCommittees
        .mockResolvedValueOnce({
          data: HOUSE_COMMITTEES,
          pagination: { count: 260, nextOffset: 250 },
        })
        .mockResolvedValueOnce({
          data: [{ name: 'Rules Committee', systemCode: 'hsru00', chamber: 'house' }],
          pagination: { count: 260, nextOffset: null },
        });
      const input = committeeLookupTool.input.parse({
        operation: 'list',
        chamber: 'house',
        filter: 'transportation',
      });
      await committeeLookupTool.handler(input, ctx);
      expect(mockApi.listCommittees).toHaveBeenCalledTimes(2);
      expect(mockApi.listCommittees).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ limit: 250, offset: 0 }),
        ctx,
      );
      expect(mockApi.listCommittees).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ limit: 250, offset: 250 }),
        ctx,
      );
    });

    it('surfaces a filter match sitting beyond the first 250 committees', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      // Page 1: 250 rows, none containing 'coinage'. Page 2 carries the match the
      // single-fetch bug hid (issue #41's hsba02, position ~403 of 455).
      const page1 = Array.from({ length: 250 }, (_, i) => ({
        name: `Placeholder Committee ${i}`,
        systemCode: `hsp${String(i).padStart(3, '0')}`,
        chamber: 'house',
      }));
      const page2 = [
        {
          name: 'Consumer Affairs and Coinage Subcommittee',
          systemCode: 'hsba02',
          chamber: 'house',
        },
        { name: 'Housing Subcommittee', systemCode: 'hsba03', chamber: 'house' },
      ];
      mockApi.listCommittees
        .mockResolvedValueOnce({ data: page1, pagination: { count: 252, nextOffset: 250 } })
        .mockResolvedValueOnce({ data: page2, pagination: { count: 252, nextOffset: null } });
      const input = committeeLookupTool.input.parse({
        operation: 'list',
        chamber: 'house',
        filter: 'coinage',
      });
      const result = await committeeLookupTool.handler(input, ctx);
      const codes = (result.data as Array<Record<string, unknown>>).map((r) => r.systemCode);
      expect(codes).toContain('hsba02');
      expect(mockApi.listCommittees).toHaveBeenCalledTimes(2);
    });

    it('exact token match — transportation returns Transportation and Infrastructure + subcommittee', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      const input = committeeLookupTool.input.parse({
        operation: 'list',
        chamber: 'house',
        filter: 'transportation',
      });
      const result = await committeeLookupTool.handler(input, ctx);
      expect(result.data).toHaveLength(2);
      const codes = (result.data as Array<Record<string, unknown>>).map((r) => r.systemCode);
      expect(codes).toContain('hspw00');
      expect(codes).toContain('hspw07');
    });

    it('partial multi-token match — "science technology" matches Science, Space, and Technology', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      const input = committeeLookupTool.input.parse({
        operation: 'list',
        chamber: 'house',
        filter: 'science technology',
      });
      const result = await committeeLookupTool.handler(input, ctx);
      const codes = (result.data as Array<Record<string, unknown>>).map((r) => r.systemCode);
      expect(codes).toContain('hssy00');
      // Should not pull in armed services etc.
      expect(codes).not.toContain('hsas00');
    });

    it('fuzzy fallback — typo "trasnportation" returns approximate match', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      const input = committeeLookupTool.input.parse({
        operation: 'list',
        chamber: 'house',
        filter: 'trasnportation',
      });
      const result = await committeeLookupTool.handler(input, ctx);
      expect(result.data!.length).toBeGreaterThan(0);
      const rows = result.data as Array<Record<string, unknown>>;
      // All fuzzy results should be labeled approximate
      expect(rows.every((r) => r.approximate === true)).toBe(true);
      const codes = rows.map((r) => r.systemCode);
      // Transportation committee should surface via fuzzy
      expect(codes).toContain('hspw00');
      // Noise must NOT surface: best-token scoring keeps unrelated long names out,
      // and the result is capped to the top few.
      expect(codes).not.toContain('hlze00'); // Population Committee
      expect(codes).not.toContain('hsju00'); // Judiciary
      expect(codes.length).toBeLessThanOrEqual(5);
    });

    it.each(['zzzz-no-such-committee-zzzz', 'armed zzznomatch'])(
      'requires every fuzzy token to match: %s',
      async (filter) => {
        const ctx = createMockContext({ errors: committeeLookupTool.errors });
        const result = await committeeLookupTool.handler(
          committeeLookupTool.input.parse({ operation: 'list', filter }),
          ctx,
        );
        expect(result.data).toEqual([]);
        expect(getEnrichment(ctx).notice).toContain('No committees matched');
        const text = committeeLookupTool.format!(result)
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        expect(text).not.toContain('Armed Services');
      },
    );

    it('keeps multi-token typo matches and excludes incidental name tokens', async () => {
      mockApi.listCommittees.mockResolvedValue({
        data: [...HOUSE_COMMITTEES, { name: 'Public Lands Committee', systemCode: 'hspl00' }],
        pagination: { count: 8, nextOffset: null },
      });
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      const result = await committeeLookupTool.handler(
        committeeLookupTool.input.parse({ operation: 'list', filter: 'armed servcies' }),
        ctx,
      );
      expect(result.data).toEqual([{ ...HOUSE_COMMITTEES[2], approximate: true }]);
      expect(committeeLookupTool.format!(result)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('Armed Services') }),
        ]),
      );
    });

    it('ranks equal fuzzy matches independently of upstream row order before paging', async () => {
      const committees = Array.from({ length: 7 }, (_, index) => ({
        name: `Armed Services ${String.fromCharCode(65 + index)}`,
        systemCode: `hs${index}00`,
      }));
      for (const data of [committees.toReversed(), committees]) {
        mockApi.listCommittees.mockResolvedValue({
          data,
          pagination: { count: 7, nextOffset: null },
        });
        const ctx = createMockContext({ errors: committeeLookupTool.errors });
        const result = await committeeLookupTool.handler(
          committeeLookupTool.input.parse({
            operation: 'list',
            filter: 'armed servcies',
            limit: 2,
            offset: 2,
          }),
          ctx,
        );
        expect(result.data).toEqual(
          committees.slice(2, 4).map((row) => ({ ...row, approximate: true })),
        );
        expect(result.pagination).toEqual({ count: 5, nextOffset: 4 });
        const pastEnd = await committeeLookupTool.handler(
          committeeLookupTool.input.parse({
            operation: 'list',
            filter: 'armed servcies',
            limit: 2,
            offset: 5,
          }),
          createMockContext({ errors: committeeLookupTool.errors }),
        );
        expect(pastEnd.data).toEqual([]);
        expect(pastEnd.pagination).toEqual({ count: 5, nextOffset: null });
      }
    });

    it('matches multi-token typos after the first roster page', async () => {
      mockApi.listCommittees.mockImplementation(
        houseListInTwoPages([{ name: 'Public Lands Committee' }], [HOUSE_COMMITTEES[2]]),
      );
      const result = await committeeLookupTool.handler(
        committeeLookupTool.input.parse({ operation: 'list', filter: 'armed servcies' }),
        createMockContext({ errors: committeeLookupTool.errors }),
      );
      expect(result.data).toEqual([{ ...HOUSE_COMMITTEES[2], approximate: true }]);
      expect(mockApi.listCommittees).toHaveBeenCalledWith(
        expect.objectContaining({ chamber: 'house', offset: 250 }),
        expect.anything(),
      );
    });

    it('resolves a multi-token parent typo and excludes matching subcommittees', async () => {
      mockApi.listCommittees.mockResolvedValue({
        data: [HOUSE_COMMITTEES[2], { name: 'Armed Services Subcommittee', systemCode: 'hsas01' }],
        pagination: { count: 2, nextOffset: null },
      });
      mockApi.getCommittee.mockResolvedValue({ committee: HOUSE_COMMITTEES[2] });
      const result = await committeeLookupTool.handler(
        committeeLookupTool.input.parse({ operation: 'get', committeeCode: 'armed servcies' }),
        createMockContext({ errors: committeeLookupTool.errors }),
      );
      expect(result.committee).toEqual(HOUSE_COMMITTEES[2]);
      expect(mockApi.getCommittee).toHaveBeenCalledWith('house', 'hsas00', expect.anything());
    });

    it('blank and whitespace filters retain ordinary upstream paging', async () => {
      for (const filter of ['', '   ']) {
        const result = await committeeLookupTool.handler(
          committeeLookupTool.input.parse({ operation: 'list', filter, limit: 2, offset: 9 }),
          createMockContext({ errors: committeeLookupTool.errors }),
        );
        expect(result.data).toEqual(HOUSE_COMMITTEES);
        expect(mockApi.listCommittees).toHaveBeenLastCalledWith(
          expect.objectContaining({ limit: 2, offset: 9 }),
          expect.anything(),
        );
      }
    });

    it('no-match returns empty data and a notice', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      const input = committeeLookupTool.input.parse({
        operation: 'list',
        chamber: 'house',
        filter: 'zzznomatch',
      });
      const result = await committeeLookupTool.handler(input, ctx);
      expect(result.data).toHaveLength(0);
      // The handler populates ctx.enrich.notice for no-match
      // (enrichment is carried in structuredContent — we verify the handler doesn't throw)
    });

    // ── #44: the filtered match set is paginated after matching ───────────────

    describe('filtered pagination', () => {
      /** All 7 fixture names contain 'committee' (including the subcommittee),
       * so the match set is the full fixture list in fixture order. */
      const ALL_CODES = ['hspw00', 'hsju00', 'hsas00', 'hswm00', 'hssy00', 'hspw07', 'hlze00'];

      const listFiltered = async (extra: Record<string, unknown>) => {
        const ctx = createMockContext({ errors: committeeLookupTool.errors });
        const input = committeeLookupTool.input.parse({
          operation: 'list',
          chamber: 'house',
          filter: 'committee',
          ...extra,
        });
        const result = await committeeLookupTool.handler(input, ctx);
        return { ctx, result };
      };

      it('first page — slices to limit and points nextOffset at the next window', async () => {
        const { result, ctx } = await listFiltered({ limit: 2 });
        expect((result.data as Array<Record<string, unknown>>).map((r) => r.systemCode)).toEqual(
          ALL_CODES.slice(0, 2),
        );
        expect(result.pagination).toEqual({ count: ALL_CODES.length, nextOffset: 2 });
        // count reports the FULL filtered match total, not the page length
        expect(getEnrichment(ctx).totalCount).toBe(ALL_CODES.length);
      });

      it('second page — offset re-slices into the same match set', async () => {
        const { result } = await listFiltered({ limit: 2, offset: 2 });
        expect((result.data as Array<Record<string, unknown>>).map((r) => r.systemCode)).toEqual(
          ALL_CODES.slice(2, 4),
        );
        expect(result.pagination).toEqual({ count: ALL_CODES.length, nextOffset: 4 });
      });

      it('third page — deeper re-slice keeps the same total', async () => {
        const { result } = await listFiltered({ limit: 2, offset: 4 });
        expect((result.data as Array<Record<string, unknown>>).map((r) => r.systemCode)).toEqual(
          ALL_CODES.slice(4, 6),
        );
        expect(result.pagination).toEqual({ count: ALL_CODES.length, nextOffset: 6 });
      });

      it('final partial page — nextOffset goes null when the window reaches the end', async () => {
        const { result } = await listFiltered({ limit: 2, offset: 6 });
        expect((result.data as Array<Record<string, unknown>>).map((r) => r.systemCode)).toEqual([
          'hlze00',
        ]);
        expect(result.pagination).toEqual({ count: ALL_CODES.length, nextOffset: null });
      });

      it('offset past the end — empty page keeps the full count and stays out of no-match guidance', async () => {
        const { result, ctx } = await listFiltered({ limit: 2, offset: 20 });
        expect(result.data).toEqual([]);
        expect(result.pagination).toEqual({ count: ALL_CODES.length, nextOffset: null });
        // Matches exist — this is an exhausted page, not a no-match result.
        expect(getEnrichment(ctx).notice).toBeUndefined();
        const text = committeeLookupTool.format!(result)
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('\n');
        expect(text).toMatch(/past the end/);
      });

      it('default limit wider than the match set returns every match with nextOffset null', async () => {
        const { result } = await listFiltered({});
        expect(result.data).toHaveLength(ALL_CODES.length);
        expect(result.pagination).toEqual({ count: ALL_CODES.length, nextOffset: null });
      });

      it('empty match set keeps count 0 and the no-match notice', async () => {
        const ctx = createMockContext({ errors: committeeLookupTool.errors });
        const input = committeeLookupTool.input.parse({
          operation: 'list',
          chamber: 'house',
          filter: 'zzznomatch',
          limit: 2,
          offset: 4,
        });
        const result = await committeeLookupTool.handler(input, ctx);
        expect(result.data).toEqual([]);
        expect(result.pagination).toEqual({ count: 0, nextOffset: null });
        expect(getEnrichment(ctx).notice).toMatch(/No committees matched/);
      });

      it('pagination is applied to the full multi-page match set (#41 fetch-all intact)', async () => {
        const ctx = createMockContext({ errors: committeeLookupTool.errors });
        const page1 = Array.from({ length: 250 }, (_, i) => ({
          name: `Coinage Committee ${i}`,
          systemCode: `hsp${String(i).padStart(3, '0')}`,
          chamber: 'house',
        }));
        const page2 = [
          {
            name: 'Consumer Affairs and Coinage Subcommittee',
            systemCode: 'hsba02',
            chamber: 'house',
          },
        ];
        mockApi.listCommittees
          .mockResolvedValueOnce({ data: page1, pagination: { count: 251, nextOffset: 250 } })
          .mockResolvedValueOnce({ data: page2, pagination: { count: 251, nextOffset: null } });
        const input = committeeLookupTool.input.parse({
          operation: 'list',
          chamber: 'house',
          filter: 'coinage',
          limit: 3,
          offset: 249,
        });
        const result = await committeeLookupTool.handler(input, ctx);
        expect(mockApi.listCommittees).toHaveBeenCalledTimes(2);
        expect((result.data as Array<Record<string, unknown>>).map((r) => r.systemCode)).toEqual([
          'hsp249',
          'hsba02',
        ]);
        expect(result.pagination).toEqual({ count: 251, nextOffset: null });
      });

      it('format() renders the filtered total and next offset in content[]', async () => {
        const { result } = await listFiltered({ limit: 2 });
        const text = committeeLookupTool.format!(result)
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('\n');
        expect(text).toContain(`${ALL_CODES.length} results`);
        expect(text).toContain('next offset: 2');
        expect(text).toContain('hspw00');
        expect(text).not.toContain('hsas00');
      });
    });

    it('primary match beats fuzzy — exact hits are not labeled approximate', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      const input = committeeLookupTool.input.parse({
        operation: 'list',
        chamber: 'house',
        filter: 'judiciary',
      });
      const result = await committeeLookupTool.handler(input, ctx);
      expect(result.data!.length).toBeGreaterThan(0);
      const rows = result.data as Array<Record<string, unknown>>;
      expect(rows.every((r) => !r.approximate)).toBe(true);
      expect(rows.map((r) => r.systemCode)).toContain('hsju00');
    });
  });

  it("fetches committee bills sub-resource (order='oldest' passes through in one call)", async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    mockApi.getCommitteeSubResource.mockResolvedValue({
      data: [{ number: '1' }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      chamber: 'house',
      committeeCode: 'hsju00',
      order: 'oldest',
    });
    await committeeLookupTool.handler(input, ctx);
    expect(mockApi.getCommitteeSubResource).toHaveBeenCalledTimes(1);
    expect(mockApi.getCommitteeSubResource).toHaveBeenCalledWith(
      expect.objectContaining({ subResource: 'bills', limit: 20, offset: 0 }),
      ctx,
    );
  });

  it("order='recent' probes count then fetches tail and reverses", async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    mockApi.getCommitteeSubResource
      .mockResolvedValueOnce({
        data: [{ number: 'first' }],
        pagination: { count: 100, nextOffset: 1 },
      })
      .mockResolvedValueOnce({
        data: [{ number: 'old' }, { number: 'mid' }, { number: 'new' }],
        pagination: { count: 100, nextOffset: null },
      });
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      chamber: 'house',
      committeeCode: 'hsju00',
      limit: 3,
    });
    const result = await committeeLookupTool.handler(input, ctx);

    expect(mockApi.getCommitteeSubResource).toHaveBeenCalledTimes(2);
    expect(mockApi.getCommitteeSubResource).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ subResource: 'bills', limit: 1, offset: 0 }),
      ctx,
    );
    expect(mockApi.getCommitteeSubResource).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ subResource: 'bills', limit: 3, offset: 97 }),
      ctx,
    );
    expect(result.data).toEqual([{ number: 'new' }, { number: 'mid' }, { number: 'old' }]);
    expect(result.pagination).toEqual({ count: 100, nextOffset: 3 });
  });

  it("order='recent' paginates backwards — offset=3 returns the next-older page", async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    mockApi.getCommitteeSubResource
      .mockResolvedValueOnce({
        data: [{ number: 'first' }],
        pagination: { count: 100, nextOffset: 1 },
      })
      .mockResolvedValueOnce({
        data: [{ number: 'a' }, { number: 'b' }, { number: 'c' }],
        pagination: { count: 100, nextOffset: null },
      });
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      chamber: 'house',
      committeeCode: 'hsju00',
      limit: 3,
      offset: 3,
    });
    const result = await committeeLookupTool.handler(input, ctx);

    expect(mockApi.getCommitteeSubResource).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ limit: 3, offset: 94 }),
      ctx,
    );
    expect(result.pagination).toEqual({ count: 100, nextOffset: 6 });
  });

  it("order='recent' clamps to available items near the beginning of history", async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    mockApi.getCommitteeSubResource
      .mockResolvedValueOnce({
        data: [{ number: 'first' }],
        pagination: { count: 5, nextOffset: 1 },
      })
      .mockResolvedValueOnce({
        data: [{ number: '1' }, { number: '2' }, { number: '3' }, { number: '4' }, { number: '5' }],
        pagination: { count: 5, nextOffset: null },
      });
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      chamber: 'house',
      committeeCode: 'hsju00',
      limit: 20,
    });
    const result = await committeeLookupTool.handler(input, ctx);

    expect(mockApi.getCommitteeSubResource).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ limit: 5, offset: 0 }),
      ctx,
    );
    expect(result.data).toHaveLength(5);
    expect(result.pagination).toEqual({ count: 5, nextOffset: null });
  });

  it("order='recent' returns empty when count is zero without a second fetch", async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    mockApi.getCommitteeSubResource.mockResolvedValueOnce({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      chamber: 'house',
      committeeCode: 'hsju00',
    });
    const result = await committeeLookupTool.handler(input, ctx);

    expect(mockApi.getCommitteeSubResource).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual([]);
    expect(result.pagination).toEqual({ count: 0, nextOffset: null });
  });

  it("order='recent' returns empty when offset runs past the end", async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    mockApi.getCommitteeSubResource.mockResolvedValueOnce({
      data: [{ number: 'first' }],
      pagination: { count: 10, nextOffset: 1 },
    });
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      chamber: 'house',
      committeeCode: 'hsju00',
      offset: 10,
    });
    const result = await committeeLookupTool.handler(input, ctx);

    expect(mockApi.getCommitteeSubResource).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual([]);
    expect(result.pagination).toEqual({ count: 10, nextOffset: null });
  });

  /**
   * Filtering and name resolution page the whole roster before matching — the
   * three chamber lists, read together, two pages deep (455 House, 327 Senate,
   * 36 Joint rows) — and a resolved name then makes one or two more requests.
   * Every one of them spends the call's one budget.
   */
  describe('call budget across the chained committee requests', () => {
    const LISTS = { house: 455, senate: 327, joint: 36 };

    /**
     * Every chamber list's pages, each answering after `stalls` full 10 s
     * attempts, or never when `stalls` is null. Judiciary sits on the House
     * list's first page.
     */
    function rosterPages(stalls: (key: string) => number | null) {
      return Object.fromEntries(
        Object.entries(LISTS).flatMap(([chamber, count]) =>
          Array.from({ length: Math.ceil(count / 250) }, (_, page) => {
            const key = `/v3/committee/${chamber}?offset=${page * 250}`;
            const stall = stalls(key);
            const body = {
              committees:
                key === '/v3/committee/house?offset=0'
                  ? [{ name: 'Judiciary Committee', systemCode: 'hsju00', chamber: 'House' }]
                  : [],
              pagination: {
                count,
                ...((page + 1) * 250 < count
                  ? { next: `https://api.congress.gov/v3/committee/${chamber}` }
                  : {}),
              },
            };
            return [key, stall === null ? { stalls: 0 } : { stalls: stall, body }];
          }),
        ),
      );
    }

    async function settleInsideBudget(
      upstream: ReturnType<typeof scriptedCongressApi>,
      input: Parameters<typeof runToolContract<typeof committeeLookupTool>>[1],
    ) {
      vi.stubGlobal('fetch', upstream.fetch);
      const start = Date.now();
      const call = track(runToolContract(committeeLookupTool, input));
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);
      expectBudgetTimeout(call, start);
    }

    beforeEach(() => {
      useFakeClock();
      vi.mocked(getCongressApi).mockReturnValue(new CongressApiService());
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it("'list' with a filter ends at the budget while the roster is still paging", async () => {
      /** The House list's first page answers on its third attempt; its second never answers. */
      const upstream = scriptedCongressApi(
        rosterPages((key) =>
          key === '/v3/committee/house?offset=0'
            ? 2
            : key === '/v3/committee/house?offset=250'
              ? null
              : 0,
        ),
      );
      await settleInsideBudget(upstream, { operation: 'list', filter: 'judiciary' });
      /**
       * The other lists answer at once. House page two starts after ~22 s and gets
       * two full attempts and a third clamped to what was left.
       */
      expect(upstream.hits).toEqual({
        '/v3/committee/house?offset=0': 3,
        '/v3/committee/house?offset=250': 3,
        '/v3/committee/senate?offset=0': 1,
        '/v3/committee/senate?offset=250': 1,
        '/v3/committee/joint?offset=0': 1,
      });
    });

    it("'get' by committee name ends at the budget in the request after the roster", async () => {
      const upstream = scriptedCongressApi({
        ...rosterPages(() => 1),
        '/v3/committee/house/hsju00': { stalls: 0 },
      });
      await settleInsideBudget(upstream, { operation: 'get', committeeCode: 'Judiciary' });
      /**
       * The lists page side by side, two ~11 s pages deep, so the name resolves at
       * ~22 s; the detail request gets two full attempts and a clamped third.
       */
      expect(upstream.hits).toEqual({
        '/v3/committee/house?offset=0': 2,
        '/v3/committee/house?offset=250': 2,
        '/v3/committee/senate?offset=0': 2,
        '/v3/committee/senate?offset=250': 2,
        '/v3/committee/joint?offset=0': 2,
        '/v3/committee/house/hsju00': 3,
      });
    });

    it("'bills' in recent order by committee name ends at the budget in the count probe", async () => {
      const upstream = scriptedCongressApi({
        ...rosterPages(() => 1),
        '/v3/committee/house/hsju00/bills?offset=0': { stalls: 0 },
      });
      await settleInsideBudget(upstream, { operation: 'bills', committeeCode: 'Judiciary' });
      expect(upstream.hits).toEqual({
        '/v3/committee/house?offset=0': 2,
        '/v3/committee/house?offset=250': 2,
        '/v3/committee/senate?offset=0': 2,
        '/v3/committee/senate?offset=250': 2,
        '/v3/committee/joint?offset=0': 2,
        '/v3/committee/house/hsju00/bills?offset=0': 3,
      });
    });
  });

  /**
   * #108: a committee name given as committeeCode resolves among the committees
   * of `chamber` when one is set, paging the same `/committee/{chamber}` roster
   * `list` with `filter` pages, and across every chamber — the three chamber
   * lists, read together — when it is not. The real API client runs over a
   * routed api.congress.gov, so each case pins the roster pages a call spends.
   * Roster sizes are the live ones (455 House, 327 Senate, 36 Joint), each named
   * committee on its roster's last page.
   */
  describe('name resolution scoped by chamber', () => {
    /**
     * Names as the live roster carries them. Oversight, Environment and Public Works,
     * and the two joint select committees are the lone fuzzy matches a name from
     * another chamber finds within one chamber ('forestry' meets 'reform').
     */
    const NAMED = {
      House: [
        { name: 'Judiciary Committee', systemCode: 'hsju00', chamber: 'House' },
        { name: 'Ways and Means Committee', systemCode: 'hswm00', chamber: 'House' },
        /** A historical House committee whose code carries no chamber prefix. */
        {
          name: 'Ventilation and Acoustics Committee',
          systemCode: 'no2010049600',
          chamber: 'House',
        },
        {
          name: 'Oversight and Government Reform Committee',
          systemCode: 'hsgo00',
          chamber: 'House',
        },
        { name: 'Education and Workforce Committee', systemCode: 'hsed00', chamber: 'House' },
      ],
      Senate: [
        { name: 'Judiciary Committee', systemCode: 'ssju00', chamber: 'Senate' },
        /** A historical Senate committee whose code carries the joint prefix. */
        { name: 'Joint Atomic Energy Committee', systemCode: 'jsat00', chamber: 'Senate' },
        { name: 'Environment and Public Works Committee', systemCode: 'ssev00', chamber: 'Senate' },
        {
          name: 'Agriculture, Nutrition, and Forestry Committee',
          systemCode: 'ssaf00',
          chamber: 'Senate',
        },
        { name: 'Foreign Relations Committee', systemCode: 'ssfr00', chamber: 'Senate' },
        /** Historical Senate committees whose codes are not letters + a 2-digit suffix. */
        { name: 'Indian Affairs Committee', systemCode: 'n79043125', chamber: 'Senate' },
        {
          name: 'Year 2000 Technology Problem (Special) Committee',
          systemCode: 'sp2k00',
          chamber: 'Senate',
        },
        /** The committee the live cross-chamber list's pages lose. */
        { name: 'Printing Committee', systemCode: 'no94026591', chamber: 'Senate' },
      ],
      Joint: [
        { name: 'Joint Committee on Taxation', systemCode: 'jstx00', chamber: 'Joint' },
        { name: 'Joint Economic Committee', systemCode: 'jsec00', chamber: 'Joint' },
        { name: 'Joint Economic Committee', systemCode: 'jjec00', chamber: 'Joint' },
        {
          name: 'Joint Select Committee on Budget and Appropriations Process Reform',
          systemCode: 'jsba00',
          chamber: 'Joint',
        },
        {
          name: 'Joint Select Committee on Solvency of Multiemployer Pension Plans',
          systemCode: 'jspp00',
          chamber: 'Joint',
        },
      ],
    };
    const SIZES = { House: 455, Senate: 327, Joint: 36 };

    function roster(chamber: keyof typeof SIZES) {
      const filler = Array.from({ length: SIZES[chamber] - NAMED[chamber].length }, (_, i) => ({
        name: `Placeholder Committee ${i}`,
        systemCode: `${chamber[0]?.toLowerCase()}xpl${i}`,
        chamber,
      }));
      return [...filler, ...NAMED[chamber]];
    }

    const ROSTERS = {
      '/v3/committee/house': roster('House'),
      '/v3/committee/senate': roster('Senate'),
      '/v3/committee/joint': roster('Joint'),
    };

    /**
     * Every chamber list's pages, 250 rows each, as api.congress.gov pages
     * `/committee/{chamber}`; and `/committee` as it pages live, losing
     * `no94026591` — served, though the roster never reads it.
     */
    const ROSTER_ROUTES: Record<string, unknown> = Object.assign(
      {},
      ...Object.entries(ROSTERS).map(([path, rows]) => committeeListRoutes(path, rows)),
      committeeListRoutes('/v3/committee', losingRow(Object.values(ROSTERS).flat(), 'no94026591')),
    );

    /** The page keys a scope's whole roster costs: `/v3/committee/senate?offset=0`, `…?offset=250`. */
    function rosterHits(path: keyof typeof ROSTERS) {
      const hits: Record<string, number> = {};
      for (let offset = 0; offset < ROSTERS[path].length; offset += 250) {
        hits[`${path}?offset=${offset}`] = 1;
      }
      return hits;
    }

    /** The cross-chamber roster: every page of the three chamber lists. */
    const CROSS_CHAMBER_HITS = {
      ...rosterHits('/v3/committee/house'),
      ...rosterHits('/v3/committee/senate'),
      ...rosterHits('/v3/committee/joint'),
    };

    const detail = (systemCode: string, name: string) => ({
      committee: { systemCode, name, type: 'Standing' },
    });

    /**
     * api.congress.gov over fixed routes, keyed by path plus any `offset` query,
     * counting each request in `hits`. An unrouted path answers 404, as
     * api.congress.gov does for a committee code its chamber does not hold.
     */
    function congressGov(routes: Record<string, unknown>) {
      const hits: Record<string, number> = {};
      const fetch = (url: string | URL): Promise<Response> => {
        const parsed = new URL(String(url));
        const offset = parsed.searchParams.get('offset');
        const key = offset === null ? parsed.pathname : `${parsed.pathname}?offset=${offset}`;
        hits[key] = (hits[key] ?? 0) + 1;
        const body = routes[key];
        return Promise.resolve(
          body === undefined
            ? new Response(JSON.stringify({ error: { message: 'Not found' } }), {
                status: 404,
                headers: { 'content-type': 'application/json' },
              })
            : jsonResponse(body),
        );
      };
      return { fetch, hits };
    }

    async function call(
      input: Parameters<typeof runToolContract<typeof committeeLookupTool>>[1],
      routes: Record<string, unknown> = {},
    ) {
      const upstream = congressGov({ ...ROSTER_ROUTES, ...routes });
      vi.stubGlobal('fetch', upstream.fetch);
      const result = await runToolContract(committeeLookupTool, input);
      return { result, hits: upstream.hits, text: contentText(result) };
    }

    beforeEach(() => {
      vi.mocked(getCongressApi).mockReturnValue(new CongressApiService());
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('without chamber, a name both chambers use returns both committees from the cross-chamber roster', async () => {
      const { result, hits, text } = await call({ operation: 'get', committeeCode: 'judiciary' });

      expect(hits).toEqual(CROSS_CHAMBER_HITS);
      expect(Object.keys(hits)).toHaveLength(5);
      const notice =
        "'judiciary' matched 2 committees. Use the systemCode from one of these results, or narrow your name.";
      expect(result.structuredContent).toMatchObject({
        data: [
          expect.objectContaining({ systemCode: 'hsju00' }),
          expect.objectContaining({ systemCode: 'ssju00' }),
        ],
        pagination: { count: 2, nextOffset: null },
        notice,
        effectiveQuery: 'committee name resolution (name=judiciary)',
      });
      expect(text).toContain('hsju00');
      expect(text).toContain('ssju00');
      expect(text).toContain(notice);
    });

    it('without chamber, a name one committee uses resolves from the cross-chamber roster', async () => {
      const { result, hits, text } = await call(
        { operation: 'get', committeeCode: 'taxation' },
        { '/v3/committee/joint/jstx00': detail('jstx00', 'Joint Committee on Taxation') },
      );

      expect(hits).toEqual({ ...CROSS_CHAMBER_HITS, '/v3/committee/joint/jstx00': 1 });
      const notice = "Resolved 'taxation' → jstx00 (Joint Committee on Taxation).";
      expect(result.structuredContent).toMatchObject({
        committee: { systemCode: 'jstx00' },
        notice,
      });
      expect(text).toContain('# Joint Committee on Taxation');
      expect(text).toContain(notice);
    });

    it.each([
      ['senate', 'judiciary', 'ssju00', 'Judiciary Committee'],
      ['house', 'judiciary', 'hsju00', 'Judiciary Committee'],
      ['joint', 'taxation', 'jstx00', 'Joint Committee on Taxation'],
    ] as const)(
      "with chamber '%s', '%s' resolves to %s from that chamber's roster alone",
      async (chamber, name, systemCode, committeeName) => {
        const route = `/v3/committee/${chamber}/${systemCode}`;
        const { result, hits, text } = await call(
          { operation: 'get', committeeCode: name, chamber },
          { [route]: detail(systemCode, committeeName) },
        );

        /** Two Senate or House roster pages, or one Joint page, then the detail. */
        expect(hits).toEqual({ ...rosterHits(`/v3/committee/${chamber}`), [route]: 1 });
        const notice = `Resolved '${name}' → ${systemCode} (${committeeName}).`;
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ committee: { systemCode }, notice });
        expect(text).toContain(`# ${committeeName}`);
        expect(text).toContain(notice);
      },
    );

    it.each([
      [
        'reports',
        'oldest',
        '/v3/committee/senate/ssju00/reports?offset=0',
        { reports: [{ citation: 'S. Rept. 119-12' }], pagination: { count: 1 } },
        'S. Rept. 119-12',
        1,
      ],
      [
        'nominations',
        'oldest',
        '/v3/committee/senate/ssju00/nominations?offset=0',
        { nominations: [{ citation: 'PN512-119' }], pagination: { count: 1 } },
        'PN512-119',
        1,
      ],
      [
        'bills',
        'oldest',
        '/v3/committee/senate/ssju00/bills?offset=0',
        {
          'committee-bills': { bills: [{ congress: 119, billType: 'S', billNumber: '1047' }] },
          pagination: { count: 1 },
        },
        '1047',
        1,
      ],
      /** Recent order probes the count, then reads the tail — the same first page here. */
      [
        'bills',
        'recent',
        '/v3/committee/senate/ssju00/bills?offset=0',
        {
          'committee-bills': { bills: [{ congress: 119, billType: 'S', billNumber: '1047' }] },
          pagination: { count: 1 },
        },
        '1047',
        2,
      ],
    ] as const)(
      "'%s' (%s order) resolves a name within chamber 'senate' before reading the sub-resource",
      async (operation, order, route, body, rendered, routeHits) => {
        const { result, hits, text } = await call(
          { operation, committeeCode: 'judiciary', chamber: 'senate', order },
          { [route]: body },
        );

        expect(hits).toEqual({ ...rosterHits('/v3/committee/senate'), [route]: routeHits });
        const notice = "Resolved 'judiciary' → ssju00 (Judiciary Committee).";
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          pagination: { count: 1, nextOffset: null },
          notice,
          effectiveQuery: expect.stringContaining('ssju00'),
        });
        expect(JSON.stringify(result.structuredContent)).toContain(rendered);
        expect(text).toContain(rendered);
        expect(text).toContain(notice);
      },
    );

    it('a name only the other chamber uses comes back empty with a pointer to drop chamber, before any detail request', async () => {
      const { result, hits, text } = await call({
        operation: 'get',
        committeeCode: 'ways and means',
        chamber: 'senate',
      });

      expect(hits).toEqual(rosterHits('/v3/committee/senate'));
      const notice =
        "No committee code or name matched 'ways and means' in the senate chamber. Remove chamber to search every chamber. Pass a systemCode from operation:'list' (e.g. 'hsju00'), or use operation:'list' with filter to find a committee by name.";
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        data: [],
        pagination: { count: 0, nextOffset: null },
        notice,
        effectiveQuery: 'committee name resolution (name=ways and means, chamber=senate)',
      });
      expect(text).toContain(notice);
    });

    /**
     * A name no committee in `chamber` carries can still clear the fuzzy floor
     * against one unrelated committee there. That lone approximate match is offered
     * as a candidate, never read: its detail and sub-resources are not requested.
     */
    describe.each([
      [
        'forestry',
        'house',
        {
          name: 'Oversight and Government Reform Committee',
          systemCode: 'hsgo00',
          chamber: 'House',
        },
      ],
      [
        'workforce',
        'senate',
        { name: 'Environment and Public Works Committee', systemCode: 'ssev00', chamber: 'Senate' },
      ],
      [
        'foreign relations',
        'joint',
        {
          name: 'Joint Select Committee on Budget and Appropriations Process Reform',
          systemCode: 'jsba00',
          chamber: 'Joint',
        },
      ],
      [
        'means',
        'joint',
        {
          name: 'Joint Select Committee on Solvency of Multiemployer Pension Plans',
          systemCode: 'jspp00',
          chamber: 'Joint',
        },
      ],
      /** A typo of the chamber's own committee takes the same route: the caller confirms it. */
      [
        'judiciray',
        'senate',
        { name: 'Judiciary Committee', systemCode: 'ssju00', chamber: 'Senate' },
      ],
    ] as const)("'%s' with chamber '%s' matches only approximately", (name, chamber, row) => {
      it.each(['get', 'reports'] as const)(
        "'%s' returns the approximate match as a candidate, with no request past the roster",
        async (operation) => {
          const { result, hits, text } = await call({ operation, committeeCode: name, chamber });

          expect(hits).toEqual(rosterHits(`/v3/committee/${chamber}`));
          const notice = `No committee name matched '${name}' in the ${chamber} chamber; the committee listed is an approximate match. Use its systemCode if it is the one you meant, or remove chamber to search every chamber.`;
          expect(result.isError).toBeFalsy();
          expect(result.structuredContent).toMatchObject({
            pagination: { count: 1, nextOffset: null },
            notice,
            effectiveQuery: `committee name resolution (name=${name}, chamber=${chamber})`,
          });
          expect((result.structuredContent as { data: unknown }).data).toEqual([
            { ...row, approximate: true },
          ]);
          expect(text).toContain(`### 1. ${row.name} _(approximate match)_`);
          expect(text).toContain(row.systemCode);
          expect(text).toContain(notice);
        },
      );
    });

    it.each([
      ['forestry', 'senate', 'ssaf00', 'Agriculture, Nutrition, and Forestry Committee'],
      ['workforce', 'house', 'hsed00', 'Education and Workforce Committee'],
      ['foreign relations', 'senate', 'ssfr00', 'Foreign Relations Committee'],
      ['means', 'house', 'hswm00', 'Ways and Means Committee'],
    ] as const)(
      "without chamber, '%s' resolves exactly from the cross-chamber roster, read in the %s chamber",
      async (name, chamber, systemCode, committeeName) => {
        const route = `/v3/committee/${chamber}/${systemCode}`;
        const { result, hits, text } = await call(
          { operation: 'get', committeeCode: name },
          { [route]: detail(systemCode, committeeName) },
        );

        expect(hits).toEqual({ ...CROSS_CHAMBER_HITS, [route]: 1 });
        const notice = `Resolved '${name}' → ${systemCode} (${committeeName}).`;
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ committee: { systemCode }, notice });
        expect(text).toContain(`# ${committeeName}`);
        expect(text).toContain(notice);
      },
    );

    it('without chamber, a lone approximate match resolves and the notice says it was approximate', async () => {
      const { result, hits, text } = await call(
        { operation: 'get', committeeCode: 'taxaton' },
        { '/v3/committee/joint/jstx00': detail('jstx00', 'Joint Committee on Taxation') },
      );

      expect(hits).toEqual({ ...CROSS_CHAMBER_HITS, '/v3/committee/joint/jstx00': 1 });
      const notice =
        "Resolved 'taxaton' → jstx00 (Joint Committee on Taxation) (approximate match).";
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        committee: { systemCode: 'jstx00' },
        notice,
      });
      expect(text).toContain('# Joint Committee on Taxation');
      expect(text).toContain(notice);
    });

    it("several committees sharing a name within the chamber come back as that chamber's candidates", async () => {
      const { result, hits, text } = await call({
        operation: 'get',
        committeeCode: 'economic',
        chamber: 'joint',
      });

      expect(hits).toEqual(rosterHits('/v3/committee/joint'));
      const notice =
        "'economic' matched 2 committees in the joint chamber. Use the systemCode from one of these results, or narrow your name.";
      expect(result.structuredContent).toMatchObject({
        data: [
          expect.objectContaining({ systemCode: 'jsec00' }),
          expect.objectContaining({ systemCode: 'jjec00' }),
        ],
        pagination: { count: 2, nextOffset: null },
        notice,
        effectiveQuery: 'committee name resolution (name=economic, chamber=joint)',
      });
      expect(text).toContain('jsec00');
      expect(text).toContain('jjec00');
      expect(text).toContain(notice);
    });

    it("'nominations' for a name resolved within the House is refused as Senate-only, with no request past the roster", async () => {
      const { result, hits, text } = await call({
        operation: 'nominations',
        committeeCode: 'judiciary',
        chamber: 'house',
      });

      expect(hits).toEqual(rosterHits('/v3/committee/house'));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ValidationError, data: { chamber: 'house' } },
      });
      expect(text).toContain('Nominations are only referred to Senate committees');
    });

    it.each([
      ['atomic energy', 'senate', 'jsat00', 'Joint Atomic Energy Committee'],
      ['ventilation', 'house', 'no2010049600', 'Ventilation and Acoustics Committee'],
    ] as const)(
      "a name resolved without chamber ('%s') is read in the chamber its roster row names, not the one its code prefix suggests",
      async (name, chamber, systemCode, committeeName) => {
        const route = `/v3/committee/${chamber}/${systemCode}`;
        const { result, hits, text } = await call(
          { operation: 'get', committeeCode: name },
          { [route]: detail(systemCode, committeeName) },
        );

        expect(hits).toEqual({ ...CROSS_CHAMBER_HITS, [route]: 1 });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ committee: { systemCode } });
        expect(text).toContain(`# ${committeeName}`);
      },
    );

    /**
     * #111: a code given directly, with no `chamber`, is read in the chamber its
     * prefix names. `jsat00` is a Senate committee despite its `j` prefix, and
     * api.congress.gov answers 404 for it under `/committee/joint`; only then is
     * the code's chamber read from the cross-chamber roster.
     */
    describe('a direct code whose prefix names a chamber that does not hold it', () => {
      const SENATE_READ_NOTICE =
        'Read jsat00 in the senate chamber, where the committee roster lists it; its code prefix names the joint chamber.';

      it("'get' is read in the chamber the roster lists, after the prefix's chamber answers 404", async () => {
        const { result, hits, text } = await call(
          { operation: 'get', committeeCode: 'jsat00' },
          { '/v3/committee/senate/jsat00': detail('jsat00', 'Joint Atomic Energy Committee') },
        );

        expect(hits).toEqual({
          '/v3/committee/joint/jsat00': 1,
          ...CROSS_CHAMBER_HITS,
          '/v3/committee/senate/jsat00': 1,
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          committee: { systemCode: 'jsat00' },
          notice: SENATE_READ_NOTICE,
        });
        expect(text).toContain('# Joint Atomic Energy Committee');
        expect(text).toContain(SENATE_READ_NOTICE);
      });

      it.each([
        ['oldest', 1, 1],
        /** Recent order probes the count, then reads the tail — the same first page here. */
        ['recent', 1, 2],
      ] as const)(
        "'bills' (%s order) is read in the chamber the roster lists",
        async (order, jointHits, senateHits) => {
          const { result, hits, text } = await call(
            { operation: 'bills', committeeCode: 'JSAT00', order },
            {
              '/v3/committee/senate/jsat00/bills?offset=0': {
                'committee-bills': { bills: [{ congress: 95, billType: 'S', billNumber: '63' }] },
                pagination: { count: 1 },
              },
            },
          );

          expect(hits).toEqual({
            '/v3/committee/joint/jsat00/bills?offset=0': jointHits,
            ...CROSS_CHAMBER_HITS,
            '/v3/committee/senate/jsat00/bills?offset=0': senateHits,
          });
          expect(result.isError).toBeFalsy();
          expect(result.structuredContent).toMatchObject({
            data: [expect.objectContaining({ billNumber: '63' })],
            pagination: { count: 1, nextOffset: null },
            notice: SENATE_READ_NOTICE,
          });
          expect(text).toContain('63');
          expect(text).toContain(SENATE_READ_NOTICE);
        },
      );

      it("'nominations' checks the roster before refusing a code its prefix calls non-Senate", async () => {
        const route = '/v3/committee/senate/jsat00/nominations?offset=0';
        const { result, hits, text } = await call(
          { operation: 'nominations', committeeCode: 'jsat00' },
          { [route]: { nominations: [{ citation: 'PN100-95' }], pagination: { count: 1 } } },
        );

        expect(hits).toEqual({ ...CROSS_CHAMBER_HITS, [route]: 1 });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          pagination: { count: 1, nextOffset: null },
          notice: SENATE_READ_NOTICE,
        });
        expect(text).toContain('PN100-95');
        expect(text).toContain(SENATE_READ_NOTICE);
      });

      it("'nominations' still refuses a House code the roster lists under the House", async () => {
        const { result, hits, text } = await call({
          operation: 'nominations',
          committeeCode: 'hsju00',
        });

        expect(hits).toEqual(CROSS_CHAMBER_HITS);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: { field: 'chamber', chamber: 'house' },
          },
        });
        expect(text).toContain('Nominations are only referred to Senate committees');
      });

      it.each([
        ['get', '/v3/committee/senate/ssbk00', detail('ssbk00', 'Banking Committee')],
        [
          'bills',
          '/v3/committee/senate/ssbk00/bills?offset=0',
          {
            'committee-bills': { bills: [{ congress: 119, billType: 'S', billNumber: '9' }] },
            pagination: { count: 1 },
          },
        ],
      ] as const)(
        "'%s' on a code its prefix's chamber holds makes one request and no roster read",
        async (operation, route, body) => {
          const { result, hits } = await call(
            { operation, committeeCode: 'ssbk00', order: 'oldest' },
            { [route]: body },
          );

          expect(hits).toEqual({ [route]: 1 });
          expect(result.isError).toBeFalsy();
          expect(result.structuredContent).not.toHaveProperty('notice');
        },
      );

      it('a code the roster lacks keeps the not_found its prefix chamber answered', async () => {
        const { result, hits, text } = await call({ operation: 'get', committeeCode: 'hsxx99' });

        expect(hits).toEqual({ '/v3/committee/house/hsxx99': 1, ...CROSS_CHAMBER_HITS });
        const message =
          "Committee hsxx99 not found in the house chamber. Most committee codes are a chamber prefix, letters, and two digits (`hsju00`); some historical ones are not (`n79043125`, `sp2k00`). Call `congressgov_committee_lookup` with `operation: 'list'` and an optional `filter` to discover valid codes.";
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.NotFound,
            message,
            data: { reason: 'not_found', chamber: 'house', committeeCode: 'hsxx99' },
          },
        });
        expect(text).toContain('Committee hsxx99 not found in the house chamber.');
      });

      it('an explicit chamber is read as given, with no roster read', async () => {
        const { result, hits } = await call({
          operation: 'get',
          committeeCode: 'jsat00',
          chamber: 'joint',
        });

        expect(hits).toEqual({ '/v3/committee/joint/jsat00': 1 });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.NotFound,
            message: expect.stringContaining('Committee jsat00 not found in the joint chamber.'),
            data: { reason: 'not_found', chamber: 'joint', committeeCode: 'jsat00' },
          },
        });
      });
    });

    /**
     * #114: a roster code outside the letters + 2-digit shape (`n79043125`,
     * `no2010049600`, `sp2k00`) is matched against the roster the name branch
     * already pages, before any name, and read in the chamber its row lists. The
     * match costs no request beyond that roster.
     */
    describe('a roster code outside the letters + 2-digit shape', () => {
      it.each([
        ['n79043125', 'senate', 'n79043125', 'Indian Affairs Committee'],
        ['N79043125', 'senate', 'n79043125', 'Indian Affairs Committee'],
        ['no2010049600', 'house', 'no2010049600', 'Ventilation and Acoustics Committee'],
        ['sp2k00', 'senate', 'sp2k00', 'Year 2000 Technology Problem (Special) Committee'],
      ] as const)(
        "'get' on %j reads it in the %s chamber its roster row lists",
        async (committeeCode, chamber, systemCode, committeeName) => {
          const route = `/v3/committee/${chamber}/${systemCode}`;
          const { result, hits, text } = await call(
            { operation: 'get', committeeCode },
            { [route]: detail(systemCode, committeeName) },
          );

          expect(hits).toEqual({ ...CROSS_CHAMBER_HITS, [route]: 1 });
          expect(result.isError).toBeFalsy();
          expect(result.structuredContent).toMatchObject({
            committee: { systemCode },
            effectiveQuery: `committee ${systemCode}`,
          });
          expect(result.structuredContent).not.toHaveProperty('notice');
          expect(text).toContain(`# ${committeeName}`);
        },
      );

      it("'get' without chamber reads no94026591, which the cross-chamber list pages lose, in the Senate", async () => {
        const route = '/v3/committee/senate/no94026591';
        const { result, hits, text } = await call(
          { operation: 'get', committeeCode: 'no94026591' },
          { [route]: detail('no94026591', 'Printing Committee') },
        );

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          committee: { systemCode: 'no94026591' },
          effectiveQuery: 'committee no94026591',
        });
        expect(text).toContain('# Printing Committee');
        expect(hits).toEqual({ ...CROSS_CHAMBER_HITS, [route]: 1 });
      });

      it.each([
        ['bills', 'oldest', 'bills', 1],
        /** Recent order probes the count, then reads the tail — the same first page here. */
        ['bills', 'recent', 'bills', 2],
        ['reports', 'oldest', 'reports', 1],
      ] as const)(
        "'%s' (%s order) on n79043125 requests the Senate sub-resource",
        async (operation, order, subResource, routeHits) => {
          const route = `/v3/committee/senate/n79043125/${subResource}?offset=0`;
          const body =
            subResource === 'bills'
              ? {
                  'committee-bills': { bills: [{ congress: 66, type: 'S', number: '17' }] },
                  pagination: { count: 1 },
                }
              : { reports: [{ citation: 'S. Rept. 66-1' }], pagination: { count: 1 } };
          const { result, hits, text } = await call(
            { operation, committeeCode: 'n79043125', order },
            { [route]: body },
          );

          expect(hits).toEqual({ ...CROSS_CHAMBER_HITS, [route]: routeHits });
          expect(result.isError).toBeFalsy();
          expect(result.structuredContent).toMatchObject({
            pagination: { count: 1, nextOffset: null },
          });
          const rendered = subResource === 'bills' ? '17' : 'S. Rept. 66-1';
          expect(JSON.stringify(result.structuredContent)).toContain(rendered);
          expect(text).toContain(rendered);
        },
      );

      it("'nominations' on a House-listed code is refused as Senate-only, with no request past the roster", async () => {
        const { result, hits, text } = await call({
          operation: 'nominations',
          committeeCode: 'no2010049600',
        });

        expect(hits).toEqual(CROSS_CHAMBER_HITS);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: { field: 'chamber', chamber: 'house' },
          },
        });
        expect(text).toContain('Nominations are only referred to Senate committees');
      });

      it("reads with chamber equal to the row's chamber, from that chamber's roster", async () => {
        const route = '/v3/committee/senate/n79043125';
        const { result, hits } = await call(
          { operation: 'get', committeeCode: 'n79043125', chamber: 'senate' },
          { [route]: detail('n79043125', 'Indian Affairs Committee') },
        );

        expect(hits).toEqual({ ...rosterHits('/v3/committee/senate'), [route]: 1 });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ committee: { systemCode: 'n79043125' } });
      });

      it('with another chamber it gets the zero-candidate reply and the drop-chamber notice', async () => {
        const { result, hits, text } = await call({
          operation: 'get',
          committeeCode: 'n79043125',
          chamber: 'house',
        });

        expect(hits).toEqual(rosterHits('/v3/committee/house'));
        const notice =
          "No committee code or name matched 'n79043125' in the house chamber. Remove chamber to search every chamber. Pass a systemCode from operation:'list' (e.g. 'hsju00'), or use operation:'list' with filter to find a committee by name.";
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          data: [],
          pagination: { count: 0, nextOffset: null },
          notice,
          effectiveQuery: 'committee name resolution (name=n79043125, chamber=house)',
        });
        expect(text).toContain(notice);
      });

      it.each(['__proto__', 'constructor'])(
        '%j matches no roster code and no name, with no request past the roster',
        async (committeeCode) => {
          const { result, hits } = await call({ operation: 'get', committeeCode });

          expect(hits).toEqual(CROSS_CHAMBER_HITS);
          expect(result.isError).toBeFalsy();
          expect(result.structuredContent).toMatchObject({
            data: [],
            pagination: { count: 0, nextOffset: null },
          });
        },
      );

      it('no description or notice says every code is letters + a 2-digit suffix', async () => {
        const { result } = await call({ operation: 'get', committeeCode: 'ssbk' });

        expect((result.structuredContent as { notice: string }).notice).not.toMatch(/2-digit/);
        expect(committeeLookupTool.description).not.toMatch(/2-digit/);
        expect(committeeLookupTool.input.shape.committeeCode.description).not.toMatch(/2-digit/);
      });
    });
  });

  /**
   * #119: fromDateTime/toDateTime filter a committee's bills and reports by update
   * date. The real API client runs over a routed api.congress.gov that records
   * every request URL, so each case pins the query a call sends.
   */
  describe('update-date window on bills and reports', () => {
    const FROM = '2025-03-01T00:00:00Z';
    const TO = '2025-03-31T23:59:59Z';
    const BILLS = '/v3/committee/senate/ssju00/bills';
    const REPORTS = '/v3/committee/house/hsju00/reports';

    /** `total` committee bills, numbered by position, served a page per request. */
    const billsOf = (total: number) => (url: URL) => {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const bills = Array.from(
        { length: Math.max(0, Math.min(limit, total - offset)) },
        (_, i) => ({
          congress: 119,
          type: 'S',
          number: String(offset + i + 1),
          updateDate: '2025-03-10T11:56:24Z',
        }),
      );
      const next =
        offset + limit < total ? { next: `https://api.congress.gov${url.pathname}` } : {};
      return { 'committee-bills': { bills }, pagination: { count: total, ...next } };
    };

    /** api.congress.gov over routes keyed by pathname, recording every request URL. */
    function recordingCongressGov(routes: Record<string, unknown | ((url: URL) => unknown)>) {
      const urls: URL[] = [];
      const fetch = (url: string | URL): Promise<Response> => {
        const parsed = new URL(String(url));
        urls.push(parsed);
        const route = routes[parsed.pathname];
        return Promise.resolve(
          route === undefined
            ? new Response(JSON.stringify({ error: { message: 'Not found' } }), {
                status: 404,
                headers: { 'content-type': 'application/json' },
              })
            : jsonResponse(typeof route === 'function' ? route(parsed) : route),
        );
      };
      return { fetch, urls };
    }

    async function call(
      input: Parameters<typeof runToolContract<typeof committeeLookupTool>>[1],
      routes: Record<string, unknown | ((url: URL) => unknown)> = {},
    ) {
      const upstream = recordingCongressGov(routes);
      vi.stubGlobal('fetch', upstream.fetch);
      const result = await runToolContract(committeeLookupTool, input);
      return { result, urls: upstream.urls, text: contentText(result) };
    }

    /** The paging and window parameters one request sent. */
    const sent = (url: URL) => ({
      path: url.pathname,
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset'),
      fromDateTime: url.searchParams.get('fromDateTime'),
      toDateTime: url.searchParams.get('toDateTime'),
    });

    beforeEach(() => {
      vi.mocked(getCongressApi).mockReturnValue(new CongressApiService());
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("'bills' in recent order sends the window on the count probe and the tail read, and reverses the window's last rows", async () => {
      const { result, urls, text } = await call(
        {
          operation: 'bills',
          committeeCode: 'ssju00',
          fromDateTime: FROM,
          toDateTime: TO,
          limit: 3,
        },
        { [BILLS]: billsOf(51) },
      );

      expect(urls.map(sent)).toEqual([
        { path: BILLS, limit: '1', offset: '0', fromDateTime: FROM, toDateTime: TO },
        { path: BILLS, limit: '3', offset: '48', fromDateTime: FROM, toDateTime: TO },
      ]);
      expect(result.isError).toBeFalsy();
      const effectiveQuery = `bills for committee ssju00 (order=recent, fromDateTime=${FROM}, toDateTime=${TO})`;
      expect(result.structuredContent).toMatchObject({
        data: [{ number: '51' }, { number: '50' }, { number: '49' }],
        pagination: { count: 51, nextOffset: 3 },
        effectiveQuery,
        totalCount: 51,
      });
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(text).toContain('51');
      expect(text).toContain(effectiveQuery);
    });

    it("'bills' in oldest order sends the window on its one request", async () => {
      const { result, urls } = await call(
        {
          operation: 'bills',
          committeeCode: 'ssju00',
          order: 'oldest',
          fromDateTime: FROM,
          toDateTime: TO,
        },
        { [BILLS]: billsOf(51) },
      );

      expect(urls.map(sent)).toEqual([
        { path: BILLS, limit: '20', offset: '0', fromDateTime: FROM, toDateTime: TO },
      ]);
      expect(result.structuredContent).toMatchObject({
        pagination: { count: 51, nextOffset: 20 },
        effectiveQuery: `bills for committee ssju00 (fromDateTime=${FROM}, toDateTime=${TO})`,
      });
      expect((result.structuredContent as { data: unknown[] }).data).toHaveLength(20);
    });

    it("'reports' sends the window, and the echo names only the bound supplied", async () => {
      const { result, urls, text } = await call(
        { operation: 'reports', committeeCode: 'hsju00', fromDateTime: '2025-01-01T00:00:00Z' },
        {
          [REPORTS]: {
            reports: [{ citation: 'H. Rept. 119-200', updateDate: '2025-07-16 15:36:13+00:00' }],
            pagination: { count: 18 },
          },
        },
      );

      expect(urls.map(sent)).toEqual([
        {
          path: REPORTS,
          limit: '20',
          offset: '0',
          fromDateTime: '2025-01-01T00:00:00Z',
          toDateTime: null,
        },
      ]);
      expect(result.structuredContent).toMatchObject({
        pagination: { count: 18 },
        effectiveQuery: 'reports for committee hsju00 (fromDateTime=2025-01-01T00:00:00Z)',
      });
      expect(text).toContain('H. Rept. 119-200');
    });

    it('without a window, bills and reports send no window parameter and echo as before', async () => {
      const bills = await call(
        { operation: 'bills', committeeCode: 'ssju00', limit: 3 },
        { [BILLS]: billsOf(51) },
      );
      const reports = await call(
        { operation: 'reports', committeeCode: 'hsju00' },
        { [REPORTS]: { reports: [{ citation: 'H. Rept. 113-675' }], pagination: { count: 1 } } },
      );

      expect(bills.urls.map(sent)).toEqual([
        { path: BILLS, limit: '1', offset: '0', fromDateTime: null, toDateTime: null },
        { path: BILLS, limit: '3', offset: '48', fromDateTime: null, toDateTime: null },
      ]);
      expect(reports.urls.map(sent)).toEqual([
        { path: REPORTS, limit: '20', offset: '0', fromDateTime: null, toDateTime: null },
      ]);
      expect(bills.result.structuredContent).toMatchObject({
        effectiveQuery: 'bills for committee ssju00 (order=recent)',
      });
      expect(reports.result.structuredContent).toMatchObject({
        effectiveQuery: 'reports for committee hsju00',
      });
    });

    it.each([
      ['bills', 'recent', BILLS, billsOf(0), 1, 'bills', 'ssju00'],
      ['bills', 'oldest', BILLS, billsOf(0), 1, 'bills', 'ssju00'],
      [
        'reports',
        'oldest',
        REPORTS,
        { reports: [], pagination: { count: 0 } },
        1,
        'reports',
        'hsju00',
      ],
    ] as const)(
      "an empty '%s' window (%s order) says the window matched nothing",
      async (operation, order, path, body, requests, noun, committeeCode) => {
        const { result, urls, text } = await call(
          { operation, committeeCode, order, fromDateTime: '2099-01-01T00:00:00Z' },
          { [path]: body },
        );

        expect(urls).toHaveLength(requests);
        const notice = `No ${noun} found for committee ${committeeCode} with an update inside the fromDateTime/toDateTime window. Widen or remove the window.`;
        expect(result.structuredContent).toMatchObject({
          data: [],
          pagination: { count: 0, nextOffset: null },
          notice,
        });
        expect(text).toContain(notice);
      },
    );

    const listRoute = {
      '/v3/committee': {
        committees: [{ name: 'Judiciary Committee', systemCode: 'ssju00', chamber: 'Senate' }],
        pagination: { count: 1 },
      },
    };

    it.each([
      [
        { operation: 'list', fromDateTime: FROM },
        listRoute,
        '/v3/committee',
        "'list' does not use fromDateTime, so it was ignored.",
      ],
      [
        {
          operation: 'get',
          committeeCode: 'ssju00',
          filter: 'judiciary',
          fromDateTime: FROM,
          toDateTime: TO,
        },
        {
          '/v3/committee/senate/ssju00': { committee: { systemCode: 'ssju00', name: 'Judiciary' } },
        },
        '/v3/committee/senate/ssju00',
        "'get' does not use filter, fromDateTime, or toDateTime, so they were ignored.",
      ],
      [
        { operation: 'nominations', committeeCode: 'ssju00', congress: 119, toDateTime: TO },
        {
          '/v3/committee/senate/ssju00/nominations': {
            nominations: [{ citation: 'PN1478' }],
            pagination: { count: 5591 },
          },
        },
        '/v3/committee/senate/ssju00/nominations',
        "'nominations' does not use congress or toDateTime, so they were ignored. Results span every congress.",
      ],
    ] as const)(
      '%o is served unfiltered, naming the window as ignored',
      async (input, routes, path, notice) => {
        const { result, urls, text } = await call(input, routes);

        expect(urls.map((url) => url.pathname)).toEqual([path]);
        expect(urls[0]?.searchParams.has('fromDateTime')).toBe(false);
        expect(urls[0]?.searchParams.has('toDateTime')).toBe(false);
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ notice });
        expect(text).toContain(notice);
      },
    );

    it('the ignored-window notice composes with the empty-result notice on list', async () => {
      const { result } = await call(
        { operation: 'list', chamber: 'joint', fromDateTime: FROM, toDateTime: TO },
        { '/v3/committee/joint': { committees: [], pagination: { count: 0 } } },
      );

      expect(result.structuredContent).toMatchObject({
        data: [],
        notice:
          "'list' does not use fromDateTime or toDateTime, so they were ignored. No committees found. Try removing the chamber filter or check the congress number.",
      });
    });

    /** Each refusal comes before name resolution's roster read and every other request. */
    describe.each([
      ['list', { operation: 'list', filter: 'judiciary' }],
      ['get', { operation: 'get', committeeCode: 'judiciary' }],
      ['bills', { operation: 'bills', committeeCode: 'judiciary' }],
      ['reports', { operation: 'reports', committeeCode: 'judiciary' }],
      ['nominations', { operation: 'nominations', committeeCode: 'judiciary' }],
    ] as const)("'%s' validates the window before any request", (_operation, base) => {
      it.each([
        [{ fromDateTime: '2025-03-01' }, /'fromDateTime' must be an ISO 8601 date-time/],
        [{ toDateTime: '2025-02-30T00:00:00Z' }, /'toDateTime' must be an ISO 8601 date-time/],
        [{ fromDateTime: TO, toDateTime: FROM }, /must be earlier than or equal to 'toDateTime'/],
      ] as const)('rejects %o', async (window, message) => {
        const { result, urls } = await call({ ...base, ...window });

        expect(urls).toEqual([]);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            message: expect.stringMatching(message),
          },
        });
      });
    });

    it('describes the window as an update-date filter and the order without promising update-date order', () => {
      const shape = committeeLookupTool.input.shape;
      expect(shape.fromDateTime.description).toContain('update');
      expect(shape.fromDateTime.description).toContain("'bills' and 'reports'");
      expect(shape.toDateTime.description).toContain("'bills' and 'reports'");
      expect(shape.order.description).not.toMatch(/update-date (first|order)/);
      expect(committeeLookupTool.description).not.toMatch(/update-date (first|order)/);
      expect(committeeLookupTool.description).toContain(
        '{congress, type, number, actionDate, relationshipType, updateDate, url}',
      );
    });
  });
});

/**
 * @fileoverview Tests for congressgov_committee_lookup tool.
 * @module tests/mcp-server/tools/definitions/committee-lookup.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { committeeLookupTool } from '@/mcp-server/tools/definitions/committee-lookup.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

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
      // #39's guidance survives the move from schema to handler: the notice names
      // the code shape and routes the caller to list+filter.
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('ssbk');
      expect(notice).toMatch(/2-digit suffix/);
      expect(notice).toMatch(/list/);
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

    it('pages the full multi-chamber set to resolve a name past the first 250', async () => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      // Resolution fetches across all chambers (818 total). The match sits on the
      // second page — the single-fetch bug would never have seen it.
      const page1 = Array.from({ length: 250 }, (_, i) => ({
        name: `Placeholder Committee ${i}`,
        systemCode: `xxpl${String(i).padStart(3, '0')}`,
        chamber: 'house',
      }));
      const page2 = [
        { name: 'Veterans Affairs Committee', systemCode: 'hsvr00', chamber: 'house' },
      ];
      mockApi.listCommittees
        .mockResolvedValueOnce({ data: page1, pagination: { count: 251, nextOffset: 250 } })
        .mockResolvedValueOnce({ data: page2, pagination: { count: 251, nextOffset: null } });
      mockApi.getCommittee.mockResolvedValue({
        committee: { name: 'Veterans Affairs Committee' },
      });
      const input = committeeLookupTool.input.parse({
        operation: 'get',
        committeeCode: 'veterans affairs',
      });
      const result = await committeeLookupTool.handler(input, ctx);
      expect(mockApi.listCommittees).toHaveBeenCalledTimes(2);
      expect(mockApi.listCommittees).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ limit: 250, offset: 250 }),
        ctx,
      );
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
});

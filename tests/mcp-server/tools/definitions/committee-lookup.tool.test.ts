/**
 * @fileoverview Tests for congressgov_committee_lookup tool.
 * @module tests/mcp-server/tools/definitions/committee-lookup.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
    const ctx = createMockContext();
    mockApi.listCommittees.mockResolvedValue({
      data: [{ name: 'Judiciary' }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = committeeLookupTool.input.parse({ operation: 'list' });
    const result = await committeeLookupTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
  });

  it('lists committees filtered by chamber and congress', async () => {
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = committeeLookupTool.input.parse({ operation: 'get' });
    await expect(committeeLookupTool.handler(input, ctx)).rejects.toThrow(/requires/);
  });

  // ── #39: committeeCode auto-resolve + schema pattern guard ───────────────────

  it('rejects malformed non-whitespace codes at schema parse time', () => {
    // ssbk (no digit suffix) fails the pattern /^([a-z]{2,6}\d{2}|.*\s.*)$/
    expect(() =>
      committeeLookupTool.input.parse({
        operation: 'get',
        committeeCode: 'ssbk',
      }),
    ).toThrow();
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

    it('zero matches — returns empty candidates without calling getCommittee', async () => {
      const ctx = createMockContext();
      const input = committeeLookupTool.input.parse({
        operation: 'get',
        committeeCode: 'house zzznomatch',
      });
      const result = await committeeLookupTool.handler(input, ctx);
      expect(result.data).toHaveLength(0);
      expect(mockApi.getCommittee).not.toHaveBeenCalled();
    });

    it('one match — resolves to code and proceeds with get', async () => {
      const ctx = createMockContext();
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
      const ctx = createMockContext();
      // 'senate committee' matches both Senate Banking and Senate Small Business
      const input = committeeLookupTool.input.parse({
        operation: 'get',
        committeeCode: 'senate committee',
      });
      const result = await committeeLookupTool.handler(input, ctx);
      expect((result.data as unknown[]).length).toBeGreaterThan(1);
      expect(mockApi.getCommittee).not.toHaveBeenCalled();
    });

    it('subcommittees excluded from auto-resolve candidates (parent-only filter)', async () => {
      const ctx = createMockContext();
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
  });

  it('throws when nominations requested for non-senate committee', async () => {
    const ctx = createMockContext();
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

    it('fetches with limit=250 when filter is set', async () => {
      const ctx = createMockContext();
      const input = committeeLookupTool.input.parse({
        operation: 'list',
        chamber: 'house',
        filter: 'transportation',
      });
      await committeeLookupTool.handler(input, ctx);
      expect(mockApi.listCommittees).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 250 }),
        ctx,
      );
    });

    it('exact token match — transportation returns Transportation and Infrastructure + subcommittee', async () => {
      const ctx = createMockContext();
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
      const ctx = createMockContext();
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
      const ctx = createMockContext();
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
      const ctx = createMockContext();
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

    it('primary match beats fuzzy — exact hits are not labeled approximate', async () => {
      const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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

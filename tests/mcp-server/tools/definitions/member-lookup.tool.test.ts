/**
 * @fileoverview Tests for congressgov_member_lookup tool.
 * @module tests/mcp-server/tools/definitions/member-lookup.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { memberLookupTool } from '@/mcp-server/tools/definitions/member-lookup.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

describe('memberLookupTool', () => {
  const mockApi = {
    listMembers: vi.fn(),
    getMember: vi.fn(),
    getMemberLegislation: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('lists members', async () => {
    const ctx = createMockContext({ errors: memberLookupTool.errors });
    mockApi.listMembers.mockResolvedValue({
      data: [{ name: 'Smith' }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = memberLookupTool.input.parse({ operation: 'list' });
    const result = await memberLookupTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
  });

  it('lists members filtered by state', async () => {
    const ctx = createMockContext({ errors: memberLookupTool.errors });
    mockApi.listMembers.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = memberLookupTool.input.parse({
      operation: 'list',
      stateCode: 'CA',
    });
    await memberLookupTool.handler(input, ctx);
    expect(mockApi.listMembers).toHaveBeenCalledWith(
      expect.objectContaining({ stateCode: 'CA' }),
      ctx,
    );
  });

  it('throws when district is provided without stateCode', async () => {
    const ctx = createMockContext({ errors: memberLookupTool.errors });
    const input = memberLookupTool.input.parse({ operation: 'list', district: 5 });
    await expect(memberLookupTool.handler(input, ctx)).rejects.toThrow(/stateCode/);
  });

  it('lists members by congress combined with state and district', async () => {
    const ctx = createMockContext({ errors: memberLookupTool.errors });
    mockApi.listMembers.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = memberLookupTool.input.parse({
      operation: 'list',
      congress: 118,
      stateCode: 'CA',
      district: 12,
    });
    await memberLookupTool.handler(input, ctx);
    expect(mockApi.listMembers).toHaveBeenCalledWith(
      expect.objectContaining({ congress: 118, stateCode: 'CA', district: 12 }),
      ctx,
    );
  });

  it('gets a member by bioguideId', async () => {
    const ctx = createMockContext({ errors: memberLookupTool.errors });
    mockApi.getMember.mockResolvedValue({ member: { name: 'Pelosi' } });
    const input = memberLookupTool.input.parse({
      operation: 'get',
      bioguideId: 'P000197',
    });
    const result = await memberLookupTool.handler(input, ctx);
    expect(result.member).toEqual({ name: 'Pelosi' });
    expect(mockApi.getMember).toHaveBeenCalledWith('P000197', ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toContain('P000197');
    expect(enrichment.totalCount).toBe(1);
  });

  it('throws when get/sponsored/cosponsored is missing bioguideId', async () => {
    const ctx = createMockContext({ errors: memberLookupTool.errors });
    const input = memberLookupTool.input.parse({ operation: 'get' });
    await expect(memberLookupTool.handler(input, ctx)).rejects.toThrow(/bioguideId/);
  });

  it('fetches sponsored legislation', async () => {
    const ctx = createMockContext({ errors: memberLookupTool.errors });
    mockApi.getMemberLegislation.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = memberLookupTool.input.parse({
      operation: 'sponsored',
      bioguideId: 'P000197',
    });
    await memberLookupTool.handler(input, ctx);
    expect(mockApi.getMemberLegislation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sponsored-legislation' }),
      ctx,
    );
  });

  it('fetches cosponsored legislation', async () => {
    const ctx = createMockContext({ errors: memberLookupTool.errors });
    mockApi.getMemberLegislation.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = memberLookupTool.input.parse({
      operation: 'cosponsored',
      bioguideId: 'P000197',
    });
    await memberLookupTool.handler(input, ctx);
    expect(mockApi.getMemberLegislation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cosponsored-legislation' }),
      ctx,
    );
  });

  // ── #97: inputs an operation doesn't use are refused or disclosed ──

  describe('inputs the operation does not use', () => {
    const legislationPage = {
      data: [{ congress: 119, type: 'HR', number: '10875' }],
      pagination: { count: 204, nextOffset: 20 },
    };

    it("refuses bioguideId on 'list' before any request", async () => {
      const ctx = createMockContext({ errors: memberLookupTool.errors });
      const input = memberLookupTool.input.parse({ operation: 'list', bioguideId: 'J000298' });

      await expect(memberLookupTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining("'get'"),
        data: { reason: 'incompatible_identity', field: 'bioguideId', operation: 'list' },
      });
      expect(mockApi.listMembers).not.toHaveBeenCalled();
    });

    it('serves sponsored legislation and says the congress filter spans every congress', async () => {
      mockApi.getMemberLegislation.mockResolvedValue(structuredClone(legislationPage));

      const result = await runToolContract(memberLookupTool, {
        operation: 'sponsored',
        bioguideId: 'J000298',
        congress: 118,
      });

      expect(result.isError).toBeFalsy();
      expect(mockApi.getMemberLegislation).toHaveBeenCalledWith(
        { bioguideId: 'J000298', type: 'sponsored-legislation', limit: 20, offset: 0 },
        expect.anything(),
      );
      const notice =
        "'sponsored' does not use congress, so it was ignored. Results span every congress.";
      expect(result.structuredContent).toMatchObject({ ...legislationPage, notice });
      const content = (result.content as Array<{ type: string; text?: string }>)
        .map((block) => block.text ?? '')
        .join('\n');
      expect(content).toContain('10875');
      expect(content).toContain(notice);
    });

    it("names every ignored filter on 'get', without the every-congress sentence", async () => {
      mockApi.getMember.mockResolvedValue({ member: { name: 'Pelosi' } });
      const ctx = createMockContext({ errors: memberLookupTool.errors });

      await memberLookupTool.handler(
        memberLookupTool.input.parse({
          operation: 'get',
          bioguideId: 'P000197',
          stateCode: 'CA',
          district: 11,
          currentMember: false,
        }),
        ctx,
      );

      expect(getEnrichment(ctx).notice).toBe(
        "'get' does not use stateCode, district, or currentMember, so they were ignored.",
      );
    });

    it('composes with the empty-result notice', async () => {
      mockApi.getMemberLegislation.mockResolvedValue({
        data: [],
        pagination: { count: 0, nextOffset: null },
      });
      const ctx = createMockContext({ errors: memberLookupTool.errors });

      await memberLookupTool.handler(
        memberLookupTool.input.parse({
          operation: 'cosponsored',
          bioguideId: 'P000197',
          stateCode: 'CA',
          congress: 118,
        }),
        ctx,
      );

      expect(getEnrichment(ctx).notice).toBe(
        "'cosponsored' does not use congress or stateCode, so they were ignored. Results span every congress. No cosponsored legislation found for member P000197.",
      );
    });

    it('keeps the notice to the ignored filter on a page past the end', async () => {
      mockApi.getMemberLegislation.mockResolvedValue({
        data: [],
        pagination: { count: 204, nextOffset: null },
      });
      const ctx = createMockContext({ errors: memberLookupTool.errors });

      await memberLookupTool.handler(
        memberLookupTool.input.parse({
          operation: 'sponsored',
          bioguideId: 'J000298',
          congress: 118,
          offset: 500,
        }),
        ctx,
      );

      expect(getEnrichment(ctx).notice).toBe(
        "'sponsored' does not use congress, so it was ignored. Results span every congress.",
      );
    });

    it('stays silent when no list-only filter is supplied', async () => {
      mockApi.getMemberLegislation.mockResolvedValue(structuredClone(legislationPage));
      const ctx = createMockContext({ errors: memberLookupTool.errors });

      await memberLookupTool.handler(
        memberLookupTool.input.parse({ operation: 'sponsored', bioguideId: 'J000298', limit: 5 }),
        ctx,
      );

      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it("applies the filters on 'list' without a notice", async () => {
      mockApi.listMembers.mockResolvedValue({
        data: [{ name: 'Smith' }],
        pagination: { count: 1, nextOffset: null },
      });
      const ctx = createMockContext({ errors: memberLookupTool.errors });

      await memberLookupTool.handler(
        memberLookupTool.input.parse({
          operation: 'list',
          congress: 118,
          stateCode: 'CA',
          district: 12,
          currentMember: true,
        }),
        ctx,
      );

      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('declares the refusal and marks the list-only filters', () => {
      expect(memberLookupTool.errors?.map((contract) => contract.reason)).toContain(
        'incompatible_identity',
      );
      const shape = memberLookupTool.input.shape;
      for (const field of ['congress', 'stateCode', 'district', 'currentMember'] as const) {
        expect(shape[field].description, field).toContain("'list' only");
      }
    });
  });
});

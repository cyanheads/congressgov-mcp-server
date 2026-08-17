/**
 * @fileoverview Tests for congressgov_enacted_laws tool.
 * @module tests/mcp-server/tools/definitions/enacted-laws.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { enactedLawsTool } from '@/mcp-server/tools/definitions/enacted-laws.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

describe('enactedLawsTool', () => {
  const mockApi = {
    listLaws: vi.fn(),
    getLaw: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('lists laws by congress', async () => {
    const ctx = createMockContext({ errors: enactedLawsTool.errors });
    mockApi.listLaws.mockResolvedValue({
      data: [{ lawNumber: 1 }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = enactedLawsTool.input.parse({ operation: 'list', congress: 118 });
    const result = await enactedLawsTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
    expect(mockApi.listLaws).toHaveBeenCalledWith(expect.objectContaining({ congress: 118 }), ctx);
  });

  it('lists laws filtered by type', async () => {
    const ctx = createMockContext({ errors: enactedLawsTool.errors });
    mockApi.listLaws.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = enactedLawsTool.input.parse({
      operation: 'list',
      congress: 118,
      lawType: 'pub',
    });
    await enactedLawsTool.handler(input, ctx);
    expect(mockApi.listLaws).toHaveBeenCalledWith(expect.objectContaining({ lawType: 'pub' }), ctx);
  });

  it('gets a specific law', async () => {
    const ctx = createMockContext({ errors: enactedLawsTool.errors });
    mockApi.getLaw.mockResolvedValue({ law: { title: 'Public Law 118-1' } });
    const input = enactedLawsTool.input.parse({
      operation: 'get',
      congress: 118,
      lawType: 'pub',
      lawNumber: 1,
    });
    const result = await enactedLawsTool.handler(input, ctx);
    expect(result.law).toEqual({ title: 'Public Law 118-1' });
    expect(mockApi.getLaw).toHaveBeenCalledWith(
      expect.objectContaining({ congress: 118, lawType: 'pub', lawNumber: 1 }),
      ctx,
    );
  });

  it('throws when get is missing lawType or lawNumber', async () => {
    const ctx = createMockContext({ errors: enactedLawsTool.errors });
    const input = enactedLawsTool.input.parse({ operation: 'get', congress: 118 });
    await expect(enactedLawsTool.handler(input, ctx)).rejects.toThrow(/requires/);
  });

  // ── #54: the citation is the only law identifier list output exposes ──

  describe('list → get chaining on the law citation', () => {
    const getLaw = (lawNumber: unknown) =>
      enactedLawsTool.input.parse({
        operation: 'get',
        congress: 118,
        lawType: 'pub',
        lawNumber,
      });

    it('accepts the citation a list row carries and normalizes it to the law number', async () => {
      const ctx = createMockContext({ errors: enactedLawsTool.errors });
      mockApi.getLaw.mockResolvedValue({
        law: { title: 'Sample Act', laws: [{ number: '118-90' }] },
      });

      const result = await enactedLawsTool.handler(getLaw('118-90'), ctx);

      expect(mockApi.getLaw).toHaveBeenCalledWith(
        { congress: 118, lawType: 'pub', lawNumber: 90 },
        ctx,
      );
      expect(result.law).toMatchObject({ title: 'Sample Act' });
      expect(getEnrichment(ctx).effectiveQuery).toBe('Public Law 118-90');
    });

    it('accepts the bare number and its digit-string form', async () => {
      const ctx = createMockContext({ errors: enactedLawsTool.errors });
      mockApi.getLaw.mockResolvedValue({ law: {} });

      await enactedLawsTool.handler(getLaw(90), ctx);
      await enactedLawsTool.handler(getLaw('90'), ctx);
      await enactedLawsTool.handler(getLaw('0090'), ctx);

      for (const call of mockApi.getLaw.mock.calls) {
        expect(call[0]).toMatchObject({ lawNumber: 90 });
      }
    });

    it('rejects a citation whose congress contradicts the congress input', async () => {
      const ctx = createMockContext({ errors: enactedLawsTool.errors });
      await expect(enactedLawsTool.handler(getLaw('119-90'), ctx)).rejects.toThrow(
        /119.*congress=118/s,
      );
      expect(mockApi.getLaw).not.toHaveBeenCalled();
    });

    it.each([
      ['a prefix with no law number', '118-'],
      ['a bare hyphen prefix', '-90'],
      ['a zero law number', '118-0'],
      ['a three-part citation', '118-90-1'],
      ['an en-dash citation', '118–90'],
      ['non-numeric text', 'Public Law 118-90'],
      ['a padded citation', ' 118-90 '],
      ['zero', 0],
    ])('rejects %s at schema parse time', (_label, value) => {
      expect(() => getLaw(value)).toThrow();
    });

    it('documents where the value comes from in the advertised schema', () => {
      const json = z.toJSONSchema(enactedLawsTool.input, { io: 'input' }) as {
        properties: Record<string, { description?: string; anyOf?: Array<{ type: string }> }>;
      };
      const lawNumber = json.properties.lawNumber;
      expect(lawNumber?.description).toContain('laws[].number');
      expect(lawNumber?.description).toContain('118-90');
      /** Serializable union — no transform, no coercion (#43's precedent). */
      expect(lawNumber?.anyOf?.map((variant) => variant.type)).toEqual(['integer', 'string']);
    });
  });
});

/**
 * @fileoverview Tests for congress://bill/{congress}/{billType}/{billNumber} resource.
 * @module tests/mcp-server/resources/definitions/bill.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resourcesReader } from '../../../helpers/resources-read.js';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { billResource } from '@/mcp-server/resources/definitions/bill.resource.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

describe('billResource', () => {
  const mockApi = {
    getBill: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('returns bill detail for valid params', async () => {
    const ctx = createMockContext();
    const billData = { title: 'Test Act', sponsor: 'Smith' };
    mockApi.getBill.mockResolvedValue({ bill: billData });
    const params = billResource.params!.parse({
      congress: '118',
      billType: 'hr',
      billNumber: '3076',
    });
    const result = await billResource.handler(params, ctx);
    expect(result).toEqual(billData);
    expect(mockApi.getBill).toHaveBeenCalledWith(
      {
        congress: 118,
        billType: 'hr',
        billNumber: 3076,
      },
      ctx,
    );
  });

  it('converts string params to numbers for API call', async () => {
    const ctx = createMockContext();
    mockApi.getBill.mockResolvedValue({ bill: {} });
    const params = billResource.params!.parse({
      congress: '119',
      billType: 's',
      billNumber: '1',
    });
    await billResource.handler(params, ctx);
    expect(mockApi.getBill).toHaveBeenCalledWith(
      {
        congress: 119,
        billType: 's',
        billNumber: 1,
      },
      ctx,
    );
  });
});

/**
 * #122: bill rows carry `type` upper-cased (`HR`, `HJRES`), so a URI built from a
 * row reads like the lower-case code the template names.
 */
describe('congress://bill/{congress}/{billType}/{billNumber} over resources/read', () => {
  const resourcesRead = resourcesReader([billResource]);
  const mockApi = { getBill: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
    mockApi.getBill.mockResolvedValue({ bill: { title: 'Test Act' } });
  });

  it.each([
    ['congress://bill/118/hr/3076', 'hr', 3076],
    ['congress://bill/118/HR/3076', 'hr', 3076],
    ['congress://bill/118/Hr/3076', 'hr', 3076],
    ['congress://bill/118/HJRES/12', 'hjres', 12],
  ])('%s reads the %s bill', async (uri, billType, billNumber) => {
    const body = await resourcesRead(uri);

    expect(body.error).toBeUndefined();
    expect(mockApi.getBill).toHaveBeenCalledWith(
      { congress: 118, billType, billNumber },
      expect.anything(),
    );
    expect(JSON.parse(body.result?.contents[0]?.text ?? '{}')).toEqual({ title: 'Test Act' });
  });

  it.each(['congress://bill/118/XYZ/3076', 'congress://bill/118/hrx/3076'])(
    '%s fails the param schema with -32007 before any request',
    async (uri) => {
      const body = await resourcesRead(uri);

      expect(body.error?.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(JSON.stringify(body.error?.data)).toContain('billType');
      expect(mockApi.getBill).not.toHaveBeenCalled();
    },
  );
});

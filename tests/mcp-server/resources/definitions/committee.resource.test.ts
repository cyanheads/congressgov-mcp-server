/**
 * @fileoverview Tests for congress://committee/{committeeCode} resource.
 * @module tests/mcp-server/resources/definitions/committee.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { committeeResource } from '@/mcp-server/resources/definitions/committee.resource.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

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

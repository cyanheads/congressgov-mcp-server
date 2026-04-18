/**
 * @fileoverview Tests for congress://member/{bioguideId} resource.
 * @module tests/mcp-server/resources/definitions/member.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { memberResource } from '@/mcp-server/resources/definitions/member.resource.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

describe('memberResource', () => {
  const mockApi = {
    getMember: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('returns member profile for valid bioguideId', async () => {
    const ctx = createMockContext();
    const memberData = { name: 'Nancy Pelosi', state: 'CA', party: 'Democrat' };
    mockApi.getMember.mockResolvedValue({ member: memberData });
    const params = memberResource.params!.parse({ bioguideId: 'P000197' });
    const result = await memberResource.handler(params, ctx);
    expect(result).toEqual(memberData);
    expect(mockApi.getMember).toHaveBeenCalledWith('P000197', ctx);
  });
});

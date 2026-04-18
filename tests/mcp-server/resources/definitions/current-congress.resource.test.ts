/**
 * @fileoverview Tests for congress://current resource.
 * @module tests/mcp-server/resources/definitions/current-congress.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { currentCongressResource } from '@/mcp-server/resources/definitions/current-congress.resource.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

describe('currentCongressResource', () => {
  const mockApi = {
    getCurrentCongress: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('returns current congress data', async () => {
    const ctx = createMockContext();
    const congressData = {
      congress: 119,
      name: '119th Congress',
      startYear: 2025,
      endYear: 2027,
      sessions: [{ number: 1, chamber: 'Senate', type: 'R', startDate: '2025-01-03' }],
    };
    mockApi.getCurrentCongress.mockResolvedValue(congressData);
    const result = await currentCongressResource.handler({}, ctx);
    expect(result).toEqual(congressData);
    expect(result.congress).toBe(119);
    expect(mockApi.getCurrentCongress).toHaveBeenCalledWith(ctx);
  });
});

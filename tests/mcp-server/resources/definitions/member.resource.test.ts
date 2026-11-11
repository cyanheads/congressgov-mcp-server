/**
 * @fileoverview Tests for congress://member/{bioguideId} resource.
 * @module tests/mcp-server/resources/definitions/member.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resourcesReader } from '../../../helpers/resources-read.js';

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

/** #122: `congressgov_member_lookup` takes a bioguide ID in any letter case, and so does the resource. */
describe('congress://member/{bioguideId} over resources/read', () => {
  const resourcesRead = resourcesReader([memberResource]);
  const mockApi = { getMember: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
    mockApi.getMember.mockResolvedValue({ member: { directOrderName: 'Nancy Pelosi' } });
  });

  it.each(['congress://member/P000197', 'congress://member/p000197'])(
    '%s reads member P000197',
    async (uri) => {
      const body = await resourcesRead(uri);

      expect(body.error).toBeUndefined();
      expect(mockApi.getMember).toHaveBeenCalledWith('P000197', expect.anything());
      expect(JSON.parse(body.result?.contents[0]?.text ?? '{}')).toEqual({
        directOrderName: 'Nancy Pelosi',
      });
    },
  );

  it.each(['congress://member/P00019', 'congress://member/pelosi', 'congress://member/1000197'])(
    '%s fails the param schema with -32007 before any request',
    async (uri) => {
      const body = await resourcesRead(uri);

      expect(body.error?.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(JSON.stringify(body.error?.data)).toContain('bioguideId');
      expect(mockApi.getMember).not.toHaveBeenCalled();
    },
  );
});

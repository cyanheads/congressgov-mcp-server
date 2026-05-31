/**
 * @fileoverview Tests for CongressApiService internal normalizers and utility functions.
 * Pure-logic tests for normalizeCrsReport, normalizeCommitteeReportSubresource,
 * flattenArticleSections, toIsoZ, ordinal, and getVoteMembers pagination.
 * @module tests/services/congress-api/normalizers.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    apiKey: 'test-api-key',
    baseUrl: 'https://api.congress.gov/v3',
  }),
}));

import { CongressApiService } from '@/services/congress-api/congress-api-service.js';

function okJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify(data),
  };
}

function errorResponse(status: number, body: string, statusText = 'Error') {
  return { ok: false, status, statusText, headers: new Headers(), text: async () => body };
}

describe('CongressApiService — normalizeCrsReport', () => {
  let service: CongressApiService;
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    service = new CongressApiService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prepends https:// to schemeless www. report URLs', async () => {
    mockFetch.mockResolvedValue(
      okJson({
        CRSReports: [{ reportNumber: 'R40097', url: 'www.congress.gov/crs/R40097' }],
        pagination: { count: 1 },
      }),
    );
    const result = await service.listCrsReports({}, createMockContext());
    expect(result.data[0]).toMatchObject({ url: 'https://www.congress.gov/crs/R40097' });
  });

  it('leaves already-schemed URLs alone', async () => {
    mockFetch.mockResolvedValue(
      okJson({
        CRSReports: [{ reportNumber: 'R40097', url: 'https://www.congress.gov/crs/R40097' }],
        pagination: { count: 1 },
      }),
    );
    const result = await service.listCrsReports({}, createMockContext());
    expect(result.data[0]).toMatchObject({ url: 'https://www.congress.gov/crs/R40097' });
  });

  it('deduplicates relatedMaterials by URL (removes dupe entries)', async () => {
    mockFetch.mockResolvedValue(
      okJson({
        CRSReport: {
          reportNumber: 'R40097',
          relatedMaterials: [
            { URL: 'https://example.com/a', type: 'Link' },
            { URL: 'https://example.com/a', type: 'Link' },
            { URL: 'https://example.com/b', type: 'Link' },
          ],
        },
      }),
    );
    const result = await service.getCrsReport({ reportNumber: 'R40097' }, createMockContext());
    const materials = result.report.relatedMaterials as unknown[];
    expect(materials).toHaveLength(2);
  });

  it('normalizes uppercase URL key to lowercase url in relatedMaterials', async () => {
    mockFetch.mockResolvedValue(
      okJson({
        CRSReport: {
          reportNumber: 'IF12345',
          relatedMaterials: [{ URL: 'https://example.com/doc', type: 'PDF' }],
        },
      }),
    );
    const result = await service.getCrsReport({ reportNumber: 'IF12345' }, createMockContext());
    const material = (result.report.relatedMaterials as Record<string, unknown>[])[0];
    expect(material).toHaveProperty('url');
    expect(material).not.toHaveProperty('URL');
  });

  it('handles report with no relatedMaterials without throwing', async () => {
    mockFetch.mockResolvedValue(okJson({ CRSReport: { reportNumber: 'R12345' } }));
    await expect(
      service.getCrsReport({ reportNumber: 'R12345' }, createMockContext()),
    ).resolves.toMatchObject({ report: { reportNumber: 'R12345' } });
  });
});

describe('CongressApiService — normalizeCommitteeReportSubresource (space-date normalization)', () => {
  let service: CongressApiService;
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    service = new CongressApiService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rewrites space-separated date+time+offset to ISO Z form in reports sub-resource', async () => {
    mockFetch.mockResolvedValue(
      okJson({
        reports: [{ citation: 'H. Rept. 118-1', updateDate: '2024-03-15 14:22:00+00:00' }],
        pagination: { count: 1 },
      }),
    );
    const result = await service.getCommitteeSubResource(
      { chamber: 'house', committeeCode: 'hsju00', subResource: 'reports' },
      createMockContext(),
    );
    expect(result.data[0]).toMatchObject({ updateDate: '2024-03-15T14:22:00Z' });
  });

  it('leaves already-ISO-Z updateDate unchanged', async () => {
    mockFetch.mockResolvedValue(
      okJson({
        reports: [{ citation: 'H. Rept. 118-2', updateDate: '2024-03-15T14:22:00Z' }],
        pagination: { count: 1 },
      }),
    );
    const result = await service.getCommitteeSubResource(
      { chamber: 'house', committeeCode: 'hsju00', subResource: 'reports' },
      createMockContext(),
    );
    expect(result.data[0]).toMatchObject({ updateDate: '2024-03-15T14:22:00Z' });
  });

  it('does not apply date normalization to non-reports sub-resources', async () => {
    mockFetch.mockResolvedValue(
      okJson({
        committees: [{ name: 'Subcommittee A', updateDate: '2024-03-15 14:22:00+00:00' }],
        pagination: { count: 1 },
      }),
    );
    const result = await service.getCommitteeSubResource(
      { chamber: 'house', committeeCode: 'hsju00', subResource: 'committees' },
      createMockContext(),
    );
    // Not normalized — non-reports sub-resources skip date normalization
    expect(result.data[0]).toMatchObject({ updateDate: '2024-03-15 14:22:00+00:00' });
  });
});

describe('CongressApiService — flattenArticleSections (getDailyArticles)', () => {
  let service: CongressApiService;
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    service = new CongressApiService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('flattens sectionArticles into a flat data array with sectionName injected', async () => {
    mockFetch.mockResolvedValue(
      okJson({
        articles: [
          {
            name: 'Senate',
            sectionArticles: [
              { title: 'Speech A', startPage: 'S100' },
              { title: 'Speech B', startPage: 'S101' },
            ],
          },
          {
            name: 'House',
            sectionArticles: [{ title: 'Floor Vote', startPage: 'H200' }],
          },
        ],
        pagination: { count: 3 },
      }),
    );
    const result = await service.getDailyArticles(
      { volumeNumber: 172, issueNumber: 68 },
      createMockContext(),
    );
    expect(result.data).toHaveLength(3);
    expect(result.data[0]).toMatchObject({ sectionName: 'Senate', title: 'Speech A' });
    expect(result.data[1]).toMatchObject({ sectionName: 'Senate', title: 'Speech B' });
    expect(result.data[2]).toMatchObject({ sectionName: 'House', title: 'Floor Vote' });
  });

  it('passes through non-sectioned items unchanged', async () => {
    mockFetch.mockResolvedValue(
      okJson({
        articles: [{ title: 'Flat Article', startPage: 'S50' }],
        pagination: { count: 1 },
      }),
    );
    const result = await service.getDailyArticles(
      { volumeNumber: 172, issueNumber: 68 },
      createMockContext(),
    );
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ title: 'Flat Article' });
  });

  it('returns empty data when articles array is empty', async () => {
    mockFetch.mockResolvedValue(okJson({ articles: [], pagination: { count: 0 } }));
    const result = await service.getDailyArticles(
      { volumeNumber: 172, issueNumber: 68 },
      createMockContext(),
    );
    expect(result.data).toEqual([]);
  });
});

describe('CongressApiService — getVoteMembers client-side pagination', () => {
  let service: CongressApiService;
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    service = new CongressApiService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('slices the member list to the requested page', async () => {
    const allMembers = Array.from({ length: 10 }, (_, i) => ({
      bioguideID: `M00000${i}`,
      position: i % 2 === 0 ? 'Yea' : 'Nay',
    }));
    mockFetch.mockResolvedValue(
      okJson({
        houseRollCallVoteMemberVotes: { results: allMembers },
      }),
    );
    const result = await service.getVoteMembers(
      { congress: 119, session: 1, voteNumber: 10, limit: 3, offset: 2 },
      createMockContext(),
    );
    expect(result.data).toHaveLength(3);
    expect(result.pagination.count).toBe(10);
    expect(result.pagination.nextOffset).toBe(5);
    /** Roster lives in data[]; the sibling vote record no longer nests it (issue #36). */
    expect(result.vote).not.toHaveProperty('results');
  });

  it('normalizes bioguideID to bioguideId in member results', async () => {
    mockFetch.mockResolvedValue(
      okJson({
        houseRollCallVoteMemberVotes: {
          results: [{ bioguideID: 'P000197', position: 'Yea' }],
        },
      }),
    );
    const result = await service.getVoteMembers(
      { congress: 119, session: 1, voteNumber: 10 },
      createMockContext(),
    );
    const member = result.data[0] as Record<string, unknown>;
    expect(member).toHaveProperty('bioguideId', 'P000197');
    expect(member).not.toHaveProperty('bioguideID');
  });

  it('returns null nextOffset when last page is reached', async () => {
    const allMembers = Array.from({ length: 5 }, (_, i) => ({
      bioguideID: `M00000${i}`,
      position: 'Yea',
    }));
    mockFetch.mockResolvedValue(okJson({ houseRollCallVoteMemberVotes: { results: allMembers } }));
    const result = await service.getVoteMembers(
      { congress: 119, session: 1, voteNumber: 10, limit: 10, offset: 0 },
      createMockContext(),
    );
    expect(result.pagination.nextOffset).toBeNull();
  });
});

describe('CongressApiService — getCongress', () => {
  let service: CongressApiService;
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    service = new CongressApiService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches congress detail by number and builds correct path', async () => {
    mockFetch.mockResolvedValue(
      okJson({ congress: { congress: 118, name: '118th Congress', startYear: 2023 } }),
    );
    const result = await service.getCongress(118, createMockContext());
    expect(result).toMatchObject({ congress: 118, name: '118th Congress' });
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/v3/congress/118');
  });
});

describe('CongressApiService — error edge cases', () => {
  let service: CongressApiService;
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    service = new CongressApiService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws service-unavailable on empty response body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
    });
    await expect(service.getCurrentCongress(createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('throws service-unavailable when response body is HTML instead of JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '<!DOCTYPE html><html><body>Error</body></html>',
    });
    await expect(service.getCurrentCongress(createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('throws service-unavailable on invalid JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '{invalid json}',
    });
    await expect(service.getCurrentCongress(createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('throws not-found on 404 for getLaw', async () => {
    mockFetch.mockResolvedValue(errorResponse(404, 'Not Found', 'Not Found'));
    await expect(
      service.getLaw({ congress: 118, lawType: 'pub', lawNumber: 9999 }, createMockContext()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it('classifies member 500/DoesNotExist as not found', async () => {
    mockFetch.mockResolvedValue(
      errorResponse(500, JSON.stringify({ error: 'Member not found at that Id' })),
    );
    await expect(service.getMember('X999999', createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });
});

describe('CongressApiService — security: API key never appears in output', () => {
  let service: CongressApiService;
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    service = new CongressApiService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never includes the api_key query param in the request URL', async () => {
    mockFetch.mockResolvedValue(okJson({ congress: { congress: 119 } }));
    await service.getCurrentCongress(createMockContext());
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get('api_key')).toBeNull();
  });

  it('sends X-Api-Key header instead of query param', async () => {
    mockFetch.mockResolvedValue(okJson({ bills: [], pagination: {} }));
    await service.listBills({ congress: 118 }, createMockContext());
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('test-api-key');
  });

  it('does not leak the api key in error messages returned to the caller', async () => {
    mockFetch.mockResolvedValue(errorResponse(429, 'Too Many Requests', 'Too Many Requests'));
    try {
      await service.getCurrentCongress(createMockContext());
      expect.fail('should have thrown');
    } catch (error) {
      const msg = String((error as Error).message ?? '');
      expect(msg).not.toContain('test-api-key');
    }
  });
});

describe('CongressApiService — listLaws path construction', () => {
  let service: CongressApiService;
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    service = new CongressApiService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds /law/{congress} without lawType', async () => {
    mockFetch.mockResolvedValue(okJson({ bills: [], pagination: {} }));
    await service.listLaws({ congress: 118 }, createMockContext());
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/v3/law/118');
  });

  it('builds /law/{congress}/{lawType} with lawType', async () => {
    mockFetch.mockResolvedValue(okJson({ bills: [], pagination: {} }));
    await service.listLaws({ congress: 118, lawType: 'pub' }, createMockContext());
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/v3/law/118/pub');
  });
});

describe('CongressApiService — listCommittees path construction', () => {
  let service: CongressApiService;
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    service = new CongressApiService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds /committee without filters', async () => {
    mockFetch.mockResolvedValue(okJson({ committees: [], pagination: {} }));
    await service.listCommittees({}, createMockContext());
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/v3/committee');
  });

  it('builds /committee/{congress} with congress only', async () => {
    mockFetch.mockResolvedValue(okJson({ committees: [], pagination: {} }));
    await service.listCommittees({ congress: 118 }, createMockContext());
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/v3/committee/118');
  });

  it('builds /committee/{chamber} with chamber only', async () => {
    mockFetch.mockResolvedValue(okJson({ committees: [], pagination: {} }));
    await service.listCommittees({ chamber: 'senate' }, createMockContext());
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/v3/committee/senate');
  });

  it('builds /committee/{congress}/{chamber} with both', async () => {
    mockFetch.mockResolvedValue(okJson({ committees: [], pagination: {} }));
    await service.listCommittees({ congress: 118, chamber: 'house' }, createMockContext());
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/v3/committee/118/house');
  });
});

describe('CongressApiService — listSummaries path construction', () => {
  let service: CongressApiService;
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    service = new CongressApiService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds /summaries without congress', async () => {
    mockFetch.mockResolvedValue(okJson({ summaries: [], pagination: {} }));
    await service.listSummaries({}, createMockContext());
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/v3/summaries');
  });

  it('builds /summaries/{congress} with congress only', async () => {
    mockFetch.mockResolvedValue(okJson({ summaries: [], pagination: {} }));
    await service.listSummaries({ congress: 118 }, createMockContext());
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/v3/summaries/118');
  });

  it('builds /summaries/{congress}/{billType} with both', async () => {
    mockFetch.mockResolvedValue(okJson({ summaries: [], pagination: {} }));
    await service.listSummaries({ congress: 118, billType: 'hr' }, createMockContext());
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/v3/summaries/118/hr');
  });
});

describe('CongressApiService — getCommitteeReport empty report handling', () => {
  let service: CongressApiService;
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    service = new CongressApiService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws not-found when committeeReports array is empty', async () => {
    mockFetch.mockResolvedValue(okJson({ committeeReports: [], pagination: {} }));
    await expect(
      service.getCommitteeReport(
        { congress: 118, reportType: 'hrpt', reportNumber: 9999 },
        createMockContext(),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });
});

/**
 * @fileoverview Tests for CongressApiService — URL construction, rate limiting, error handling.
 * @module tests/services/congress-api/congress-api-service.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    apiKey: 'test-api-key',
    baseUrl: 'https://api.congress.gov/v3',
  }),
}));

import { formatBills } from '@/mcp-server/tools/format-helpers.js';
import {
  CongressApiService,
  getCongressApi,
  initCongressApi,
} from '@/services/congress-api/congress-api-service.js';

function okJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify(data),
  };
}

function errorResponse(status: number, body: string, statusText = 'Error') {
  return {
    ok: false,
    status,
    statusText,
    headers: new Headers(),
    text: async () => body,
  };
}

describe('CongressApiService', () => {
  let service: CongressApiService;
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okJson({}));
    vi.stubGlobal('fetch', mockFetch);
    service = new CongressApiService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('URL construction', () => {
    it('sends api key via X-Api-Key header and format=json in query', async () => {
      mockFetch.mockResolvedValue(okJson({ congress: {} }));
      await service.getCurrentCongress(createMockContext());
      const url = new URL(mockFetch.mock.calls[0]![0]);
      const init = mockFetch.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['X-Api-Key']).toBe('test-api-key');
      expect(url.searchParams.get('api_key')).toBeNull();
      expect(url.searchParams.get('format')).toBe('json');
    });

    it('builds correct path for listBills', async () => {
      mockFetch.mockResolvedValue(okJson({ bills: [] }));
      await service.listBills({ congress: 118 }, createMockContext());
      const url = new URL(mockFetch.mock.calls[0]![0]);
      expect(url.pathname).toBe('/v3/bill/118');
    });

    it('builds correct path for listBills with billType', async () => {
      mockFetch.mockResolvedValue(okJson({ bills: [] }));
      await service.listBills({ congress: 118, billType: 'hr' }, createMockContext());
      const url = new URL(mockFetch.mock.calls[0]![0]);
      expect(url.pathname).toBe('/v3/bill/118/hr');
    });

    it('includes pagination params in query string', async () => {
      mockFetch.mockResolvedValue(okJson({ bills: [] }));
      await service.listBills({ congress: 118, limit: 50, offset: 100 }, createMockContext());
      const url = new URL(mockFetch.mock.calls[0]![0]);
      expect(url.searchParams.get('limit')).toBe('50');
      expect(url.searchParams.get('offset')).toBe('100');
    });
  });

  describe('error handling', () => {
    it('throws rate-limited error on 429', async () => {
      mockFetch.mockResolvedValue(errorResponse(429, 'Too Many Requests', 'Too Many Requests'));
      await expect(service.getCurrentCongress(createMockContext())).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
      });
    });

    it('throws service-unavailable error on 5xx after retries', async () => {
      mockFetch.mockResolvedValue(errorResponse(503, '', 'Service Unavailable'));
      await expect(service.getCurrentCongress(createMockContext())).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
      });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('classifies 404 responses as not found', async () => {
      mockFetch.mockResolvedValue(errorResponse(404, 'Resource not found', 'Not Found'));
      await expect(service.getCurrentCongress(createMockContext())).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
      });
    });

    it('classifies an upstream 400 as invalid_request and never echoes the URL (#34)', async () => {
      mockFetch.mockResolvedValue(errorResponse(400, 'Bad Request', 'Bad Request'));
      const error = (await service
        .listBills({ congress: 118 }, createMockContext())
        .catch((e: unknown) => e)) as McpError;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_request');
      expect((error.data?.recovery as { hint: string } | undefined)?.hint).toMatch(/ISO 8601/);
      expect(error.message).not.toContain('api.congress.gov');
      expect(error.message).not.toContain('Fetch failed');
    });

    it('classifies an upstream 403 as invalid_request without leaking the path (#34)', async () => {
      mockFetch.mockResolvedValue(errorResponse(403, 'Forbidden', 'Forbidden'));
      const error = (await service
        .getMember("P000197' OR '1'='1", createMockContext())
        .catch((e: unknown) => e)) as McpError;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_request');
      expect(error.message).not.toContain('api.congress.gov');
    });

    it('attaches a machine-readable reason and recovery hint on 404 (#32)', async () => {
      mockFetch.mockResolvedValue(errorResponse(404, 'Not Found', 'Not Found'));
      const error = (await service
        .getCurrentCongress(createMockContext())
        .catch((e: unknown) => e)) as McpError;
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('not_found');
      expect((error.data?.recovery as { hint: string } | undefined)?.hint).toBeTruthy();
      expect(error.message).not.toContain('api.congress.gov');
    });

    it('attaches the rate_limited reason on 429 (#32)', async () => {
      mockFetch.mockResolvedValue(errorResponse(429, 'Too Many Requests', 'Too Many Requests'));
      const error = (await service
        .getCurrentCongress(createMockContext())
        .catch((e: unknown) => e)) as McpError;
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data?.reason).toBe('rate_limited');
    });

    it('wraps network failures as service unavailable and retries them', async () => {
      mockFetch.mockRejectedValue(new Error('socket hang up'));
      await expect(service.getCurrentCongress(createMockContext())).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
      });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('classifies structured CRS 500 responses as not found', async () => {
      mockFetch.mockResolvedValue(
        errorResponse(500, JSON.stringify({ error: 'No data found for report R99999' })),
      );
      await expect(
        service.getCrsReport({ reportNumber: 'R99999' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
      });
    });

    it('does not misclassify CRS outages as not found', async () => {
      mockFetch.mockResolvedValue(
        errorResponse(500, '<!DOCTYPE html><html><body>Unavailable</body></html>'),
      );
      await expect(
        service.getCrsReport({ reportNumber: 'R99999' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InternalError,
      });
    });

    it('classifies committee sub-resource 500 with DoesNotExist body as not found', async () => {
      mockFetch.mockResolvedValue(
        errorResponse(
          500,
          JSON.stringify({
            error:
              "Committee matching query does not exist.\n    query was: (), {\n 'ext_system_cd': 'hstn00'} (DoesNotExist)",
          }),
        ),
      );
      await expect(
        service.getCommitteeSubResource(
          { chamber: 'house', committeeCode: 'hstn00', subResource: 'reports' },
          createMockContext(),
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
      });
    });

    it('ignores signal-like objects that are not native AbortSignal instances', async () => {
      mockFetch.mockResolvedValue(okJson({ congress: {} }));
      const ctx = {
        ...createMockContext(),
        signal: Object.create(AbortSignal.prototype),
      };

      await expect(service.getCurrentCongress(ctx as any)).resolves.toEqual({});
    });
  });

  describe('rate limiting', () => {
    it('rejects when local rate limit is reached', () => {
      (service as any).requestCount = 5000;
      (service as any).windowStart = Date.now();
      expect(() => (service as any).checkRateLimit()).toThrow(/rate limit/i);
    });

    it('resets counter after window expires', () => {
      (service as any).requestCount = 5000;
      (service as any).windowStart = Date.now() - 61 * 60 * 1000;
      expect(() => (service as any).checkRateLimit()).not.toThrow();
      expect((service as any).requestCount).toBe(0);
    });
  });

  describe('list response normalization', () => {
    it('extracts array from list key', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          bills: [{ number: 1 }, { number: 2 }],
          request: { format: 'json' },
          pagination: { count: 2 },
        }),
      );
      const result = await service.listBills({ congress: 118 }, createMockContext());
      expect(result.data).toHaveLength(2);
      expect(result.pagination.count).toBe(2);
    });

    it('returns empty array when list key is missing', async () => {
      mockFetch.mockResolvedValue(okJson({}));
      const result = await service.listBills({ congress: 118 }, createMockContext());
      expect(result.data).toEqual([]);
    });

    it('filters non-record list items so data is uniformly ApiRecord[]', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          bills: ['raw-token', { number: 2 }],
          pagination: { count: 2 },
        }),
      );
      const result = await service.listBills({ congress: 118 }, createMockContext());
      expect(result.data).toEqual([{ number: 2 }]);
    });

    it('unwraps the nested array of an object-shaped list container (committee-bills)', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          'committee-bills': {
            bills: [{ number: '1234' }, { number: '5678' }],
            count: 2,
            url: 'https://api.congress.gov/v3/committee/house/hspw00/bills',
          },
          pagination: { count: 2 },
        }),
      );
      const result = await service.getCommitteeSubResource(
        { chamber: 'house', committeeCode: 'hspw00', subResource: 'bills' },
        createMockContext(),
      );
      /** The container's `count`/`url` siblings are metadata, not rows — only the array becomes data. */
      expect(result.data).toEqual([{ number: '1234' }, { number: '5678' }]);
    });
  });

  // ── #47: the subjects container pairs an array with a sibling policyArea ──

  describe('bill subjects extraction', () => {
    const subjectsParams = {
      congress: 119,
      billType: 'hr',
      billNumber: 5334,
      subResource: 'subjects',
    } as const;

    const POLICY_AREA = { name: 'International Affairs', updateDate: '2026-08-11T13:47:33Z' };
    const TAX = { name: 'Income tax deductions', updateDate: '2026-04-28T13:58:38Z' };
    const PRESCHOOL = { name: 'Preschool education', updateDate: '2026-04-28T13:58:53Z' };
    const TEACHING = { name: 'Teaching, teachers, curricula', updateDate: '2026-04-28T13:58:46Z' };

    it('returns the policy area ahead of the legislative subjects, each tagged', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          pagination: { count: 4, next: 'https://api.congress.gov/v3/...offset=2' },
          subjects: { legislativeSubjects: [TAX], policyArea: POLICY_AREA },
        }),
      );
      const result = await service.getBillSubResource(
        { ...subjectsParams, limit: 2, offset: 0 },
        createMockContext(),
      );
      expect(result.data).toEqual([
        { subjectType: 'policyArea', ...POLICY_AREA },
        { subjectType: 'legislativeSubject', ...TAX },
      ]);
      expect(result.pagination).toEqual({ count: 4, nextOffset: 2 });
    });

    it('renders the policy area into content[] alongside the legislative subjects', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          pagination: { count: 4, next: 'https://api.congress.gov/v3/...offset=2' },
          subjects: { legislativeSubjects: [TAX], policyArea: POLICY_AREA },
        }),
      );
      const result = await service.getBillSubResource(
        { ...subjectsParams, limit: 2, offset: 0 },
        createMockContext(),
      );
      const content = formatBills(result)
        .map((block) => block.text)
        .join('\n');
      expect(content).toContain('International Affairs');
      expect(content).toContain('policyArea');
      expect(content).toContain('Income tax deductions');
      expect(content).toContain('legislativeSubject');
    });

    it('walks every page for exactly the advertised total', async () => {
      const ctx = createMockContext();
      mockFetch.mockResolvedValueOnce(
        okJson({
          pagination: { count: 4, next: 'https://api.congress.gov/v3/...offset=2' },
          subjects: { legislativeSubjects: [TAX], policyArea: POLICY_AREA },
        }),
      );
      const first = await service.getBillSubResource(
        { ...subjectsParams, limit: 2, offset: 0 },
        ctx,
      );

      /** Upstream omits policyArea past its slot — it is counted once, on page one. */
      mockFetch.mockResolvedValueOnce(
        okJson({
          pagination: { count: 4, prev: 'https://api.congress.gov/v3/...offset=0' },
          subjects: { legislativeSubjects: [PRESCHOOL, TEACHING] },
        }),
      );
      const second = await service.getBillSubResource(
        { ...subjectsParams, limit: 2, offset: 2 },
        ctx,
      );

      expect(second.data).toEqual([
        { subjectType: 'legislativeSubject', ...PRESCHOOL },
        { subjectType: 'legislativeSubject', ...TEACHING },
      ]);
      expect(second.pagination.nextOffset).toBeNull();
      expect(first.data.length + second.data.length).toBe(first.pagination.count);
    });

    it('returns the policy area alone when it is the whole page', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          pagination: { count: 4, next: 'https://api.congress.gov/v3/...offset=1' },
          subjects: { legislativeSubjects: [], policyArea: POLICY_AREA },
        }),
      );
      const result = await service.getBillSubResource(
        { ...subjectsParams, limit: 1, offset: 0 },
        createMockContext(),
      );
      expect(result.data).toEqual([{ subjectType: 'policyArea', ...POLICY_AREA }]);
    });

    it('honors the requested page size when the container overflows it', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          pagination: { count: 4, next: 'https://api.congress.gov/v3/...offset=2' },
          subjects: { legislativeSubjects: [TAX, PRESCHOOL], policyArea: POLICY_AREA },
        }),
      );
      const result = await service.getBillSubResource(
        { ...subjectsParams, limit: 2, offset: 0 },
        createMockContext(),
      );
      expect(result.data).toEqual([
        { subjectType: 'policyArea', ...POLICY_AREA },
        { subjectType: 'legislativeSubject', ...TAX },
      ]);
    });

    it('returns no rows for a bill with no subjects at all', async () => {
      mockFetch.mockResolvedValue(okJson({ pagination: { count: 0 }, subjects: {} }));
      const result = await service.getBillSubResource(
        { ...subjectsParams, limit: 20, offset: 0 },
        createMockContext(),
      );
      expect(result.data).toEqual([]);
      expect(result.pagination).toEqual({ count: 0, nextOffset: null });
    });

    it('returns no rows for an offset past the end while keeping the upstream total', async () => {
      mockFetch.mockResolvedValue(
        okJson({ pagination: { count: 4 }, subjects: { legislativeSubjects: [] } }),
      );
      const result = await service.getBillSubResource(
        { ...subjectsParams, limit: 20, offset: 500 },
        createMockContext(),
      );
      expect(result.data).toEqual([]);
      expect(result.pagination.count).toBe(4);
      const content = formatBills(result)
        .map((block) => block.text)
        .join('\n');
      expect(content).toContain('past the end of 4 total items');
    });

    it('drops non-record entries from legislativeSubjects', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          pagination: { count: 2 },
          subjects: { legislativeSubjects: ['raw-token', TAX] },
        }),
      );
      const result = await service.getBillSubResource(
        { ...subjectsParams, limit: 20, offset: 0 },
        createMockContext(),
      );
      expect(result.data).toEqual([{ subjectType: 'legislativeSubject', ...TAX }]);
    });

    it('ignores a non-record policyArea', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          pagination: { count: 1 },
          subjects: { legislativeSubjects: [TAX], policyArea: 'International Affairs' },
        }),
      );
      const result = await service.getBillSubResource(
        { ...subjectsParams, limit: 20, offset: 0 },
        createMockContext(),
      );
      expect(result.data).toEqual([{ subjectType: 'legislativeSubject', ...TAX }]);
    });
  });

  describe('law endpoints', () => {
    it('populates the law field from the upstream bill key', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          bill: { number: 4, title: 'NOTAM Improvement Act of 2023', type: 'HR' },
          request: { format: 'json' },
        }),
      );
      const result = await service.getLaw(
        { congress: 118, lawType: 'pub', lawNumber: 4 },
        createMockContext(),
      );
      expect(result.law).toMatchObject({
        number: 4,
        title: 'NOTAM Improvement Act of 2023',
      });
    });
  });

  describe('singleton', () => {
    it('initializes without error', () => {
      expect(() => initCongressApi()).not.toThrow();
    });

    it('returns the initialized service', () => {
      initCongressApi();
      expect(() => getCongressApi()).not.toThrow();
    });
  });

  describe('member endpoints', () => {
    it('builds correct path for listMembers with state and district', async () => {
      mockFetch.mockResolvedValue(okJson({ members: [] }));
      await service.listMembers({ stateCode: 'CA', district: 12 }, createMockContext());
      const url = new URL(mockFetch.mock.calls[0]![0]);
      expect(url.pathname).toBe('/v3/member/CA/12');
    });

    it('builds correct path for listMembers by congress', async () => {
      mockFetch.mockResolvedValue(okJson({ members: [] }));
      await service.listMembers({ congress: 118 }, createMockContext());
      const url = new URL(mockFetch.mock.calls[0]![0]);
      expect(url.pathname).toBe('/v3/member/congress/118');
    });

    it('builds combined path for listMembers with congress and state', async () => {
      mockFetch.mockResolvedValue(okJson({ members: [] }));
      await service.listMembers({ congress: 118, stateCode: 'CA' }, createMockContext());
      const url = new URL(mockFetch.mock.calls[0]![0]);
      expect(url.pathname).toBe('/v3/member/congress/118/CA');
    });

    it('builds combined path for listMembers with congress, state, and district', async () => {
      mockFetch.mockResolvedValue(okJson({ members: [] }));
      await service.listMembers(
        { congress: 118, stateCode: 'CA', district: 12 },
        createMockContext(),
      );
      const url = new URL(mockFetch.mock.calls[0]![0]);
      expect(url.pathname).toBe('/v3/member/congress/118/CA/12');
    });
  });
});

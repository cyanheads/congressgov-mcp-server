/**
 * @fileoverview Tests for CongressApiService — URL construction, rate limiting, error handling.
 * @module tests/services/congress-api/congress-api-service.test
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

import {
  CongressApiService,
  getCongressApi,
  initCongressApi,
} from '@/services/congress-api/congress-api-service.js';

function okJson(data: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data) };
}

function errorResponse(status: number, body: string, statusText = 'Error') {
  return {
    ok: false,
    status,
    statusText,
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
    it('appends api_key and format=json to requests', async () => {
      mockFetch.mockResolvedValue(okJson({ congress: {} }));
      await service.getCurrentCongress(createMockContext());
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get('api_key')).toBe('test-api-key');
      expect(url.searchParams.get('format')).toBe('json');
    });

    it('builds correct path for listBills', async () => {
      mockFetch.mockResolvedValue(okJson({ bills: [] }));
      await service.listBills({ congress: 118 }, createMockContext());
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe('/v3/bill/118');
    });

    it('builds correct path for listBills with billType', async () => {
      mockFetch.mockResolvedValue(okJson({ bills: [] }));
      await service.listBills({ congress: 118, billType: 'hr' }, createMockContext());
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe('/v3/bill/118/hr');
    });

    it('includes pagination params in query string', async () => {
      mockFetch.mockResolvedValue(okJson({ bills: [] }));
      await service.listBills({ congress: 118, limit: 50, offset: 100 }, createMockContext());
      const url = new URL(mockFetch.mock.calls[0][0]);
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
        code: JsonRpcErrorCode.ServiceUnavailable,
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
      expect(result.rawResponse).toMatchObject({
        bills: [{ number: 1 }, { number: 2 }],
        request: { format: 'json' },
      });
    });

    it('returns empty array when list key is missing', async () => {
      mockFetch.mockResolvedValue(okJson({}));
      const result = await service.listBills({ congress: 118 }, createMockContext());
      expect(result.data).toEqual([]);
    });

    it('preserves mixed list item types instead of silently filtering them out', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          bills: ['raw-token', { number: 2 }],
          pagination: { count: 2 },
        }),
      );
      const result = await service.listBills({ congress: 118 }, createMockContext());
      expect(result.data).toEqual(['raw-token', { number: 2 }]);
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
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe('/v3/member/CA/12');
    });

    it('builds correct path for listMembers by congress', async () => {
      mockFetch.mockResolvedValue(okJson({ members: [] }));
      await service.listMembers({ congress: 118 }, createMockContext());
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe('/v3/member/congress/118');
    });

    it('rejects ambiguous congress and location filters instead of silently dropping one', async () => {
      try {
        service.listMembers({ congress: 118, stateCode: 'CA' }, createMockContext());
        expect.unreachable('Expected listMembers to throw');
      } catch (error) {
        expect(error).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      }
    });
  });
});

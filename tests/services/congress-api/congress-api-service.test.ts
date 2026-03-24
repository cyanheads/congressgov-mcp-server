/**
 * @fileoverview Tests for CongressApiService — URL construction, rate limiting, error handling.
 * @module tests/services/congress-api/congress-api-service.test
 */

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
  return { ok: true, status: 200, json: async () => data };
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
      await service.getCurrentCongress();
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get('api_key')).toBe('test-api-key');
      expect(url.searchParams.get('format')).toBe('json');
    });

    it('builds correct path for listBills', async () => {
      mockFetch.mockResolvedValue(okJson({ bills: [] }));
      await service.listBills({ congress: 118 });
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe('/v3/bill/118');
    });

    it('builds correct path for listBills with billType', async () => {
      mockFetch.mockResolvedValue(okJson({ bills: [] }));
      await service.listBills({ congress: 118, billType: 'hr' });
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe('/v3/bill/118/hr');
    });

    it('includes pagination params in query string', async () => {
      mockFetch.mockResolvedValue(okJson({ bills: [] }));
      await service.listBills({ congress: 118, limit: 50, offset: 100 });
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get('limit')).toBe('50');
      expect(url.searchParams.get('offset')).toBe('100');
    });
  });

  describe('error handling', () => {
    it('throws rate-limited error on 429', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 429 });
      await expect(service.getCurrentCongress()).rejects.toThrow(/rate limit/i);
    });

    it('throws service-unavailable error on 5xx', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      await expect(service.getCurrentCongress()).rejects.toThrow(/HTTP 503/);
    });

    it('throws on non-ok response with body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'Resource not found',
      });
      await expect(service.getCurrentCongress()).rejects.toThrow(/404/);
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
          pagination: { count: 2 },
        }),
      );
      const result = await service.listBills({ congress: 118 });
      expect(result.data).toHaveLength(2);
      expect(result.pagination.count).toBe(2);
    });

    it('returns empty array when list key is missing', async () => {
      mockFetch.mockResolvedValue(okJson({}));
      const result = await service.listBills({ congress: 118 });
      expect(result.data).toEqual([]);
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
      await service.listMembers({ stateCode: 'CA', district: 12 });
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe('/v3/member/CA/12');
    });

    it('builds correct path for listMembers by congress', async () => {
      mockFetch.mockResolvedValue(okJson({ members: [] }));
      await service.listMembers({ congress: 118 });
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe('/v3/member/congress/118');
    });
  });
});

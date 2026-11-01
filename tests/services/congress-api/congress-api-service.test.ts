/**
 * @fileoverview Tests for CongressApiService — URL construction, rate limiting, error handling.
 * @module tests/services/congress-api/congress-api-service.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    apiKey: 'test-api-key',
    baseUrl: 'https://api.congress.gov/v3',
  }),
}));

import { getServerConfig } from '@/config/server-config.js';
import { billLookupTool } from '@/mcp-server/tools/definitions/bill-lookup.tool.js';
import { formatBills } from '@/mcp-server/tools/format-helpers.js';
import { congressErrorContracts } from '@/mcp-server/tools/tool-helpers.js';
import {
  CongressApiService,
  getCongressApi,
  initCongressApi,
} from '@/services/congress-api/congress-api-service.js';
import { createCongressBillIngester } from '@/services/congress-mirror/ingest.js';
import {
  CALL_BUDGET_MS,
  CLIENT_TIMEOUT_MS,
  contentText,
  expectBudgetTimeout,
  jsonResponse,
  retryAfterResponse,
  stalledHeadersFetch,
  track,
  useFakeClock,
} from '../../helpers/budget-fixtures.js';

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
    vi.mocked(getServerConfig).mockReturnValue({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.congress.gov/v3',
    } as ReturnType<typeof getServerConfig>);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okJson({}));
    vi.stubGlobal('fetch', mockFetch);
    service = new CongressApiService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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
    it('runs the real fetch deadline and retries through both tool error surfaces (#78)', async () => {
      vi.useFakeTimers();
      initCongressApi();
      mockFetch.mockImplementation(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const pending = runToolContract(billLookupTool, { operation: 'list', congress: 118 });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.Timeout,
          data: { reason: 'upstream_timeout', retryable: true },
        },
      });
      const rendered = result.content
        .map((block) => ('text' in block ? block.text : ''))
        .join('\n');
      expect(rendered).toContain('10000-millisecond deadline');
      expect(rendered).toContain('Recovery:');
      expect(rendered).not.toContain('api.congress.gov');
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('renders a dynamic upstream quota error and recovery on both surfaces (#71)', async () => {
      initCongressApi();
      mockFetch.mockResolvedValue({
        ...errorResponse(429, 'Too Many Requests'),
        headers: new Headers({
          'retry-after': '42',
          'x-ratelimit-limit': '20000',
          'x-ratelimit-remaining': '0',
        }),
      });
      const result = await runToolContract(billLookupTool, { operation: 'list', congress: 118 });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.RateLimited,
          data: { reason: 'rate_limited', retryAfter: '42' },
        },
      });
      const rendered = result.content
        .map((block) => ('text' in block ? block.text : ''))
        .join('\n');
      expect(rendered).toContain('shared');
      expect(rendered).toContain('Retry-After');
      expect(rendered).not.toContain('5,000');
    });
    it('preserves in-flight caller cancellation without retrying', async () => {
      const controller = new AbortController();
      mockFetch.mockImplementation(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
            queueMicrotask(() => controller.abort());
          }),
      );
      await expect(
        service.getCurrentCongress({ ...createMockContext(), signal: controller.signal }),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('does not retry an upstream 501 declared non-retryable', async () => {
      mockFetch.mockResolvedValue(errorResponse(501, 'Not Implemented'));
      await expect(service.getCurrentCongress(createMockContext())).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_error', retryable: false },
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

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
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    describe('api.data.gov key rejection (#84)', () => {
      /** The gateway's error envelope, as api.congress.gov returns it for a rejected key. */
      const gatewayBody = (code: string, message = 'An invalid api_key was supplied.') =>
        JSON.stringify({ error: { code, message } });

      it.each([
        [403, 'API_KEY_MISSING'],
        [403, 'API_KEY_INVALID'],
        [403, 'API_KEY_DISABLED'],
        [403, 'API_KEY_UNAUTHORIZED'],
        [403, 'API_KEY_UNVERIFIED'],
        [401, 'API_KEY_INVALID'],
      ])(
        'classifies HTTP %i with gateway code %s as api_key_rejected on one attempt',
        async (status, code) => {
          mockFetch.mockResolvedValue(errorResponse(status, gatewayBody(code), 'Forbidden'));
          const error = (await service
            .getCurrentCongress(createMockContext())
            .catch((e: unknown) => e)) as McpError;
          expect(error.code).toBe(JsonRpcErrorCode.ConfigurationError);
          expect(error.data).toMatchObject({
            reason: 'api_key_rejected',
            upstreamCode: code,
            retryable: false,
            status,
          });
          expect(error.message).toContain(code);
          expect(error.message).not.toContain('api.congress.gov');
          expect((error.data?.recovery as { hint: string } | undefined)?.hint).toContain(
            'CONGRESS_API_KEY',
          );
          expect(mockFetch).toHaveBeenCalledTimes(1);
        },
      );

      it('keeps a 403 whose gateway code is not a key rejection as invalid_request', async () => {
        mockFetch.mockResolvedValue(
          errorResponse(
            403,
            gatewayBody('HTTPS_REQUIRED', 'Requests must be made over HTTPS.'),
            'Forbidden',
          ),
        );
        const error = (await service
          .getCurrentCongress(createMockContext())
          .catch((e: unknown) => e)) as McpError;
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.data?.reason).toBe('invalid_request');
        expect(error.data?.upstreamCode).toBeUndefined();
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it('declares api_key_rejected on the shared contract as a non-retryable service configuration error', () => {
        expect(
          congressErrorContracts.find((entry) => entry.reason === 'api_key_rejected'),
        ).toMatchObject({
          code: JsonRpcErrorCode.ConfigurationError,
          thrownBy: 'service',
          retryable: false,
        });
      });

      it('keeps a 400 UserInputException body as invalid_request', async () => {
        mockFetch.mockResolvedValue(
          errorResponse(
            400,
            JSON.stringify({
              error:
                "time data '2025-13-45T00:00:00Z' does not match format '%Y-%m-%dT%H:%M:%SZ' (UserInputException)",
              request: { contentType: 'application/json', format: 'json' },
            }),
            'Bad Request',
          ),
        );
        const error = (await service
          .listBills({ congress: 118, fromDateTime: '2025-13-45T00:00:00Z' }, createMockContext())
          .catch((e: unknown) => e)) as McpError;
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.data?.reason).toBe('invalid_request');
        expect(error.data?.upstreamCode).toBeUndefined();
      });

      it('keeps a 429 OVER_RATE_LIMIT body as rate_limited', async () => {
        mockFetch.mockResolvedValue(
          errorResponse(
            429,
            gatewayBody('OVER_RATE_LIMIT', 'You have exceeded your rate limit.'),
            'Too Many Requests',
          ),
        );
        const error = (await service
          .getCurrentCongress(createMockContext())
          .catch((e: unknown) => e)) as McpError;
        expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(error.data?.reason).toBe('rate_limited');
        expect(error.data?.upstreamCode).toBeUndefined();
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it('renders the operator hint on both tool surfaces without echoing the configured key', async () => {
        const sentinel = 'sentinel-key-7Qx9-must-not-echo';
        vi.mocked(getServerConfig).mockReturnValue({
          apiKey: sentinel,
          baseUrl: 'https://api.congress.gov/v3',
        } as ReturnType<typeof getServerConfig>);
        initCongressApi();
        mockFetch.mockResolvedValue(
          errorResponse(
            403,
            gatewayBody(
              'API_KEY_INVALID',
              'An invalid api_key was supplied. Get one at https://api.congress.gov:443',
            ),
            'Forbidden',
          ),
        );
        const result = await runToolContract(billLookupTool, {
          operation: 'get',
          congress: 118,
          billType: 's',
          billNumber: 3764,
        });
        const init = mockFetch.mock.calls[0]![1] as RequestInit;
        expect((init.headers as Record<string, string>)['X-Api-Key']).toBe(sentinel);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ConfigurationError,
            message: expect.stringContaining('API_KEY_INVALID'),
            data: {
              reason: 'api_key_rejected',
              upstreamCode: 'API_KEY_INVALID',
              retryable: false,
              recovery: { hint: expect.stringContaining('CONGRESS_API_KEY') },
            },
          },
        });
        const rendered = contentText(result);
        expect(rendered).toContain('API_KEY_INVALID');
        expect(rendered).toContain('Recovery:');
        expect(rendered).toContain('CONGRESS_API_KEY');
        expect(rendered).toContain('reason api_key_rejected');
        expect(rendered).toContain('not retryable');
        expect(JSON.stringify(result)).not.toContain(sentinel);
      });
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
        code: JsonRpcErrorCode.ServiceUnavailable,
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
    it('honors the demo hourly fallback at the actual fetch boundary (#71)', async () => {
      vi.mocked(getServerConfig).mockReturnValue({
        apiKey: 'DEMO_KEY',
        baseUrl: 'https://api.congress.gov/v3',
      } as ReturnType<typeof getServerConfig>);
      const demo = new CongressApiService();
      for (let i = 0; i < 30; i++) await demo.getCurrentCongress();
      await expect(demo.getCurrentCongress()).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
      });
      expect(mockFetch).toHaveBeenCalledTimes(30);
      vi.mocked(getServerConfig).mockReturnValue({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.congress.gov/v3',
      } as ReturnType<typeof getServerConfig>);
    });

    it('classifies HTTP timeout responses separately (#78)', async () => {
      vi.useFakeTimers();
      mockFetch.mockResolvedValue(errorResponse(504, 'Gateway Timeout'));
      const pending = service.getCurrentCongress().catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'upstream_timeout', status: 504 },
      });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
    it('rejects when the registered fallback reaches 5000 attempts', async () => {
      for (let i = 0; i < 5000; i++) await service.getCurrentCongress();
      await expect(service.getCurrentCongress()).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
      });
      expect(mockFetch).toHaveBeenCalledTimes(5000);
    });

    it('expires hourly attempts at the rolling boundary and keeps demo daily attempts', async () => {
      let now = 100000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      vi.mocked(getServerConfig).mockReturnValue({
        apiKey: 'DEMO_KEY',
        baseUrl: 'https://api.congress.gov/v3',
      } as ReturnType<typeof getServerConfig>);
      const demo = new CongressApiService();
      for (let i = 0; i < 30; i++) await demo.getCurrentCongress();
      now += 3600000;
      for (let i = 0; i < 20; i++) await demo.getCurrentCongress();
      await expect(demo.getCurrentCongress()).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { dailyLimit: 50 },
      });
      now += 23 * 3600000;
      await demo.getCurrentCongress();
      expect(mockFetch).toHaveBeenCalledTimes(51);
    });

    it.each(['bad', '-1', '0', 'Infinity', '9007199254740992'])(
      'ignores invalid hourly limit %s',
      async (limit) => {
        mockFetch.mockResolvedValue({
          ...okJson({ congress: {} }),
          headers: new Headers({ 'x-ratelimit-limit': limit, 'x-ratelimit-remaining': '0' }),
        });
        await service.getCurrentCongress();
        await service.getCurrentCongress();
        expect(mockFetch).toHaveBeenCalledTimes(2);
      },
    );

    it('uses upstream bounds and never replenishes from a late concurrent response', async () => {
      let resolveFirst!: (value: ReturnType<typeof okJson>) => void;
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      );
      mockFetch.mockResolvedValueOnce({
        ...okJson({ congress: {} }),
        headers: new Headers({ 'x-ratelimit-limit': '20000', 'x-ratelimit-remaining': '0' }),
      });
      const first = service.getCurrentCongress();
      await service.getCurrentCongress();
      resolveFirst({
        ...okJson({ congress: {} }),
        headers: new Headers({ 'x-ratelimit-limit': '20000', 'x-ratelimit-remaining': '19999' }),
      });
      await first;
      await expect(service.getCurrentCongress()).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { hourlyLimit: 20000 },
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('reserves concurrent requests before either finishes', async () => {
      mockFetch.mockResolvedValueOnce({
        ...okJson({}),
        headers: new Headers({ 'x-ratelimit-limit': '2', 'x-ratelimit-remaining': '1' }),
      });
      await service.getCurrentCongress();
      const next = service.getCurrentCongress();
      await expect(service.getCurrentCongress()).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
      });
      await next;
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('counts retry and failed attempts before dispatch', async () => {
      vi.useFakeTimers();
      mockFetch.mockResolvedValueOnce({
        ...okJson({}),
        headers: new Headers({ 'x-ratelimit-limit': '3', 'x-ratelimit-remaining': '2' }),
      });
      await service.getCurrentCongress();
      mockFetch.mockResolvedValue(errorResponse(503, 'Unavailable'));
      const result = service.getCurrentCongress().catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await result).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('retains Retry-After and quota headers on a non-retried 429', async () => {
      let now = 100000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      mockFetch.mockResolvedValue({
        ...errorResponse(429, 'Too Many Requests'),
        headers: new Headers({
          'retry-after': '42',
          'x-ratelimit-limit': '10',
          'x-ratelimit-remaining': '0',
        }),
      });
      await expect(service.getCurrentCongress()).rejects.toMatchObject({
        data: { reason: 'rate_limited', retryAfter: '42' },
      });
      await expect(service.getCurrentCongress()).rejects.toMatchObject({
        data: { hourlyLimit: 10 },
      });
      expect(mockFetch).toHaveBeenCalledOnce();
      mockFetch.mockResolvedValue(okJson({ congress: {} }));
      now += 3_600_000 - 1;
      await expect(service.getCurrentCongress()).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
      });
      now++;
      await service.getCurrentCongress();
      expect(mockFetch).toHaveBeenCalledTimes(2);
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

  /**
   * Every request a call makes spends one budget counted from the call's start.
   * The mechanism is tabled in tests/services/call-budget.test.ts; these cases
   * prove this service's wiring and the paths where no budget applies.
   */
  describe('call budget', () => {
    /** The service's hint for every transient upstream failure. */
    const CONGRESS_RETRY_HINT =
      'Retry after a short delay; the Congress.gov service may be temporarily degraded.';

    beforeEach(() => useFakeClock());

    it('gives an attempt its full 10 s and retries into a success while the budget has room', async () => {
      mockFetch
        .mockImplementationOnce(stalledHeadersFetch)
        .mockResolvedValueOnce(jsonResponse({ congress: { number: 119 } }));
      const start = Date.now();
      const call = track(service.getCurrentCongress(createMockContext()));
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);

      expect(call.state.error).toBeUndefined();
      expect(call.state.value).toEqual({ number: 119 });
      /** The first attempt ran its own 10 s timeout, then one backoff preceded the success. */
      expect((call.state.settledAt as number) - start).toBeGreaterThanOrEqual(10_000);
      expect((call.state.settledAt as number) - start).toBeLessThan(12_000);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('clamps the attempt to what the call has left and settles at the budget', async () => {
      mockFetch.mockImplementation(stalledHeadersFetch);
      const ctx = createMockContext();
      const start = Date.now();
      /** Earlier requests in the same call spent 45 s. */
      await vi.advanceTimersByTimeAsync(45_000);
      const call = track(service.getCurrentCongress(ctx));
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);

      expect(call.state.settledAt).toBe(start + CALL_BUDGET_MS);
      expect(call.state.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: {
          reason: 'upstream_timeout',
          budgetMs: CALL_BUDGET_MS,
          retryAttempts: 1,
          recovery: { hint: CONGRESS_RETRY_HINT },
        },
      });
      expect((call.state.error as McpError).message).toBe(
        "Congress.gov did not deliver the API response within this call's 50-second budget for upstream requests (1 attempt).",
      );
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('settles a one-request tool call inside the budget when Retry-After and stalls would carry it past', async () => {
      initCongressApi();
      mockFetch
        .mockResolvedValueOnce(retryAfterResponse(503, 30))
        .mockImplementation(stalledHeadersFetch);
      const start = Date.now();
      const call = track(
        runToolContract(billLookupTool, {
          operation: 'get',
          congress: 118,
          billType: 'hr',
          billNumber: 1,
        }),
      );
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);

      expectBudgetTimeout(call, start, { hint: CONGRESS_RETRY_HINT });
      const text = contentText(call.state.value as { content: unknown[] });
      expect(text).toContain("this call's 50-second budget for upstream requests (3 attempts)");
      expect(text).toContain(CONGRESS_RETRY_HINT);
      /** The honored 30 s wait, a full 10 s attempt, a backoff, then a clamped third attempt. */
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('runs the mirror ingester unbudgeted, past the 50 s a call would get', async () => {
      let summaryAttempts = 0;
      mockFetch.mockImplementation((url: string | URL) => {
        const { pathname } = new URL(String(url));
        if (pathname === '/v3/summaries/119') {
          summaryAttempts++;
          return Promise.resolve(
            summaryAttempts < 3 ? retryAfterResponse(503, 30) : jsonResponse({ summaries: [] }),
          );
        }
        return Promise.resolve(jsonResponse({ bills: [] }));
      });
      const sync = createCongressBillIngester(() => service, [119]);
      const start = Date.now();
      const run = track(
        (async () => {
          const pages = [];
          for await (const page of sync({ mode: 'init', signal: new AbortController().signal })) {
            pages.push(page);
          }
          return pages;
        })(),
      );
      await vi.advanceTimersByTimeAsync(2 * CLIENT_TIMEOUT_MS);

      expect(run.state.error).toBeUndefined();
      expect(run.state.value).toEqual([]);
      /** Two honored 30 s waits: a tool call's budget would have ended this at 50 s. */
      expect((run.state.settledAt as number) - start).toBeGreaterThanOrEqual(60_000);
      expect(summaryAttempts).toBe(3);
    });
  });
});

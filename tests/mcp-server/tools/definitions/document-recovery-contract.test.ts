/**
 * @fileoverview Declared document recovery hints through the framework contract runner.
 * @module tests/mcp-server/tools/definitions/document-recovery-contract
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
}));

import { billLookupTool } from '@/mcp-server/tools/definitions/bill-lookup.tool.js';
import { committeeReportsTool } from '@/mcp-server/tools/definitions/committee-reports.tool.js';
import { dailyRecordTool } from '@/mcp-server/tools/definitions/daily-record.tool.js';
import { documentErrorContracts } from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import {
  initCongressDocuments,
  MAX_DOCUMENT_BYTES,
} from '@/services/congress-documents/congress-documents-service.js';

const URL = 'https://www.congress.gov/118/crpt/hrpt1/generated/CRPT-118hrpt1.htm';
const input = { operation: 'content', congress: 118, reportType: 'hrpt', reportNumber: 1 } as const;
const api = {
  getCommitteeReportText: vi.fn(),
  getDailyArticles: vi.fn(),
  getBillSubResource: vi.fn(),
};
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCongressApi).mockReturnValue(api as never);
  api.getCommitteeReportText.mockResolvedValue({
    text: [{ formats: [{ type: 'Formatted Text', url: URL }] }],
  });
  initCongressDocuments();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('document recovery contract', () => {
  it('keeps malformed window input at protocol InvalidParams', async () => {
    const result = await runToolContract(committeeReportsTool, { ...input, characterOffset: -1 });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('migrates exhausted summary text through both surfaces', async () => {
    api.getBillSubResource.mockResolvedValue({
      data: [{ text: 'abc', versionCode: '49' }],
      pagination: { count: 1, nextOffset: null },
    });
    const result = await runToolContract(billLookupTool, {
      operation: 'summaries',
      congress: 118,
      billType: 'hr',
      billNumber: 1,
      characterOffset: 3,
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'offset_past_end', retryable: false },
      },
    });
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: 'text', text: expect.stringContaining('textNextOffset') }),
    );
  });
  it.each([
    {
      reason: 'document_unavailable',
      code: JsonRpcErrorCode.NotFound,
      response: () => new Response('', { status: 404 }),
    },
    {
      reason: 'document_fetch_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      response: () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }),
    },
    {
      reason: 'document_too_large',
      code: JsonRpcErrorCode.ValidationError,
      response: () =>
        new Response('body', {
          headers: {
            'content-type': 'text/plain',
            'content-length': String(MAX_DOCUMENT_BYTES + 1),
          },
        }),
    },
    {
      reason: 'offset_past_end',
      code: JsonRpcErrorCode.ValidationError,
      response: () => new Response('body', { headers: { 'content-type': 'text/plain' } }),
    },
  ])(
    'fills the service $reason hint on both client surfaces',
    async ({ reason, code, response }) => {
      fetchMock.mockImplementation(async () => response());
      const result = await runToolContract(committeeReportsTool, {
        ...input,
        ...(reason === 'offset_past_end' ? { characterOffset: 4 } : {}),
      });
      const declared = committeeReportsTool.errors?.find((entry) => entry.reason === reason);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code,
          data: { reason, retryable: false, recovery: { hint: declared?.recovery } },
        },
      });
      expect(result.content).toContainEqual(
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining(`Recovery: ${declared?.recovery}`),
        }),
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('fills a handler hint when the report has no document', async () => {
    api.getCommitteeReportText.mockResolvedValue({ text: [] });
    const result = await runToolContract(committeeReportsTool, input);
    const hint = documentErrorContracts.find(
      (entry) => entry.reason === 'document_unavailable',
    )?.recovery;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'document_unavailable', retryable: false, recovery: { hint } },
      },
    });
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: 'text', text: expect.stringContaining(`Recovery: ${hint}`) }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fills the daily record format hint when no XML is published', async () => {
    api.getDailyArticles.mockResolvedValue({
      data: [{ text: [{ type: 'Formatted Text', url: URL }] }],
      pagination: { count: 1, nextOffset: null },
    });
    const result = await runToolContract(dailyRecordTool, {
      operation: 'content',
      volumeNumber: 169,
      issueNumber: 109,
      format: 'xml',
    });
    const hint = documentErrorContracts.find(
      (entry) => entry.reason === 'format_unavailable',
    )?.recovery;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'format_unavailable', retryable: false, recovery: { hint } },
      },
    });
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: 'text', text: expect.stringContaining(`Recovery: ${hint}`) }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

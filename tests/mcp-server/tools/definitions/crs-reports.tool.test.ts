/**
 * @fileoverview Tests for congressgov_crs_reports tool.
 * @module tests/mcp-server/tools/definitions/crs-reports.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { crsReportsTool } from '@/mcp-server/tools/definitions/crs-reports.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

describe('crsReportsTool', () => {
  const mockApi = {
    listCrsReports: vi.fn(),
    getCrsReport: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('lists CRS reports', async () => {
    const ctx = createMockContext();
    mockApi.listCrsReports.mockResolvedValue({
      data: [{ reportNumber: 'R40097' }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = crsReportsTool.input.parse({ operation: 'list' });
    const result = await crsReportsTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
  });

  it('gets a specific CRS report', async () => {
    const ctx = createMockContext();
    mockApi.getCrsReport.mockResolvedValue({ report: { title: 'Climate Policy' } });
    const input = crsReportsTool.input.parse({
      operation: 'get',
      reportNumber: 'R40097',
    });
    const result = await crsReportsTool.handler(input, ctx);
    expect(result.report).toEqual({ title: 'Climate Policy' });
  });

  it('throws when get is missing reportNumber', async () => {
    const ctx = createMockContext();
    const input = crsReportsTool.input.parse({ operation: 'get' });
    await expect(crsReportsTool.handler(input, ctx)).rejects.toThrow(/reportNumber/);
  });
});

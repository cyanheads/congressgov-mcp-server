/**
 * @fileoverview Tests for congressgov_committee_reports tool.
 * @module tests/mcp-server/tools/definitions/committee-reports.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { committeeReportsTool } from '@/mcp-server/tools/definitions/committee-reports.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

describe('committeeReportsTool', () => {
  const mockApi = {
    listCommitteeReports: vi.fn(),
    getCommitteeReport: vi.fn(),
    getCommitteeReportText: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('lists committee reports by congress', async () => {
    const ctx = createMockContext();
    mockApi.listCommitteeReports.mockResolvedValue({
      data: [{ reportNumber: 1 }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = committeeReportsTool.input.parse({ operation: 'list', congress: 118 });
    const result = await committeeReportsTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
  });

  it('lists reports filtered by type', async () => {
    const ctx = createMockContext();
    mockApi.listCommitteeReports.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = committeeReportsTool.input.parse({
      operation: 'list',
      congress: 118,
      reportType: 'hrpt',
    });
    await committeeReportsTool.handler(input, ctx);
    expect(mockApi.listCommitteeReports).toHaveBeenCalledWith(
      expect.objectContaining({ reportType: 'hrpt' }),
      ctx,
    );
  });

  it('gets a specific committee report', async () => {
    const ctx = createMockContext();
    mockApi.getCommitteeReport.mockResolvedValue({ report: { title: 'Report' } });
    const input = committeeReportsTool.input.parse({
      operation: 'get',
      congress: 118,
      reportType: 'hrpt',
      reportNumber: 100,
    });
    const result = await committeeReportsTool.handler(input, ctx);
    expect(result.report).toEqual({ title: 'Report' });
    expect(mockApi.getCommitteeReport).toHaveBeenCalledWith(
      expect.objectContaining({ congress: 118, reportType: 'hrpt', reportNumber: 100 }),
      ctx,
    );
  });

  it('gets committee report text', async () => {
    const ctx = createMockContext();
    mockApi.getCommitteeReportText.mockResolvedValue({ text: 'Full text...' });
    const input = committeeReportsTool.input.parse({
      operation: 'text',
      congress: 118,
      reportType: 'srpt',
      reportNumber: 50,
    });
    const result = await committeeReportsTool.handler(input, ctx);
    expect(result.text).toBe('Full text...');
    expect(mockApi.getCommitteeReportText).toHaveBeenCalledWith(
      expect.objectContaining({ congress: 118, reportType: 'srpt', reportNumber: 50 }),
      ctx,
    );
  });

  it('throws when get/text is missing reportType or reportNumber', async () => {
    const ctx = createMockContext();
    const input = committeeReportsTool.input.parse({ operation: 'get', congress: 118 });
    await expect(committeeReportsTool.handler(input, ctx)).rejects.toThrow(/requires/);
  });
});

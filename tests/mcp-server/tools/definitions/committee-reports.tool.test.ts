/**
 * @fileoverview Tests for congressgov_committee_reports tool.
 * @module tests/mcp-server/tools/definitions/committee-reports.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { committeeReportsTool } from '@/mcp-server/tools/definitions/committee-reports.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

/** Join a result's text blocks into the single string a content-only client sees. */
function contentText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => block.text ?? '').join('\n');
}

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
    const ctx = createMockContext({ errors: committeeReportsTool.errors });
    mockApi.listCommitteeReports.mockResolvedValue({
      data: [{ reportNumber: 1 }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = committeeReportsTool.input.parse({ operation: 'list', congress: 118 });
    const result = await committeeReportsTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
  });

  it('lists reports filtered by type', async () => {
    const ctx = createMockContext({ errors: committeeReportsTool.errors });
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
    const ctx = createMockContext({ errors: committeeReportsTool.errors });
    mockApi.getCommitteeReport.mockResolvedValue({ reports: [{ title: 'Report' }] });
    const input = committeeReportsTool.input.parse({
      operation: 'get',
      congress: 118,
      reportType: 'hrpt',
      reportNumber: 100,
    });
    const result = await committeeReportsTool.handler(input, ctx);
    expect(result).toEqual({ report: { title: 'Report' } });
    expect(mockApi.getCommitteeReport).toHaveBeenCalledWith(
      expect.objectContaining({ congress: 118, reportType: 'hrpt', reportNumber: 100 }),
      ctx,
    );
  });

  it('gets committee report text', async () => {
    const ctx = createMockContext({ errors: committeeReportsTool.errors });
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
    const ctx = createMockContext({ errors: committeeReportsTool.errors });
    const input = committeeReportsTool.input.parse({ operation: 'get', congress: 118 });
    await expect(committeeReportsTool.handler(input, ctx)).rejects.toThrow(/requires/);
  });

  // ── #94: the get and text echoes' ordinal ──

  it.each([
    ['get', 101, 'HRPT 7 (101st Congress)'],
    ['get', 112, 'HRPT 7 (112th Congress)'],
    ['text', 102, 'text formats for HRPT 7 (102nd Congress)'],
    ['text', 123, 'text formats for HRPT 7 (123rd Congress)'],
  ])("echoes '%s' for congress %i as %j", async (operation, congress, echo) => {
    mockApi.getCommitteeReport.mockResolvedValue({ reports: [{ title: 'Report' }] });
    mockApi.getCommitteeReportText.mockResolvedValue({ text: [] });
    const ctx = createMockContext({ errors: committeeReportsTool.errors });
    await committeeReportsTool.handler(
      committeeReportsTool.input.parse({
        operation,
        congress,
        reportType: 'hrpt',
        reportNumber: 7,
      }),
      ctx,
    );
    expect(getEnrichment(ctx).effectiveQuery).toBe(echo);
  });

  // ── #103: the update-date and conference filters ──

  describe('update-date and conference filters', () => {
    const FROM = '2025-06-01T00:00:00Z';
    const TO = '2026-12-31T23:59:59Z';
    const page = {
      data: [{ citation: 'H. Rept. 118-301', updateDate: '2025-06-03T10:00:00Z' }],
      pagination: { count: 10, nextOffset: 1 },
    };

    it('sends both bounds and the conference flag on list and echoes them on both surfaces', async () => {
      mockApi.listCommitteeReports.mockResolvedValue(structuredClone(page));
      const result = await runToolContract(committeeReportsTool, {
        operation: 'list',
        congress: 118,
        reportType: 'hrpt',
        fromDateTime: FROM,
        toDateTime: TO,
        conference: true,
        limit: 1,
      });
      expect(result.isError).not.toBe(true);
      expect(mockApi.listCommitteeReports).toHaveBeenCalledWith(
        {
          congress: 118,
          reportType: 'hrpt',
          fromDateTime: FROM,
          toDateTime: TO,
          conference: true,
          limit: 1,
          offset: 0,
        },
        expect.anything(),
      );
      const echo = `committee reports (congress=118, reportType=hrpt, fromDateTime=${FROM}, toDateTime=${TO}, conference=true)`;
      expect(result.structuredContent).toMatchObject({
        ...page,
        effectiveQuery: echo,
        totalCount: 10,
      });
      expect(contentText(result)).toContain(echo);
      expect(contentText(result)).toContain('H. Rept. 118-301');
    });

    it('sends conference false as false and echoes it', async () => {
      mockApi.listCommitteeReports.mockResolvedValue(structuredClone(page));
      const ctx = createMockContext({ errors: committeeReportsTool.errors });
      await committeeReportsTool.handler(
        committeeReportsTool.input.parse({ operation: 'list', congress: 118, conference: false }),
        ctx,
      );
      expect(mockApi.listCommitteeReports).toHaveBeenCalledWith(
        expect.objectContaining({ conference: false }),
        ctx,
      );
      expect(getEnrichment(ctx).effectiveQuery).toBe(
        'committee reports (congress=118, conference=false)',
      );
    });

    it('sends no new filter when none is supplied', async () => {
      mockApi.listCommitteeReports.mockResolvedValue(structuredClone(page));
      const ctx = createMockContext({ errors: committeeReportsTool.errors });
      await committeeReportsTool.handler(
        committeeReportsTool.input.parse({ operation: 'list', congress: 118 }),
        ctx,
      );
      const params = mockApi.listCommitteeReports.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(params.fromDateTime).toBeUndefined();
      expect(params.toDateTime).toBeUndefined();
      expect(params.conference).toBeUndefined();
      expect(getEnrichment(ctx).effectiveQuery).toBe('committee reports (congress=118)');
    });

    it('rejects a non-boolean conference at the schema', () => {
      expect(
        committeeReportsTool.input.safeParse({
          operation: 'list',
          congress: 118,
          conference: 'yes',
        }).success,
      ).toBe(false);
    });

    it.each(['list', 'get', 'text', 'content'])(
      "refuses a malformed or reversed window on '%s' before any request",
      async (operation) => {
        for (const window of [
          { fromDateTime: '2025-06-31T00:00:00Z' },
          { toDateTime: 'June 2025' },
          { fromDateTime: TO, toDateTime: FROM },
        ]) {
          const ctx = createMockContext({ errors: committeeReportsTool.errors });
          const input = committeeReportsTool.input.parse({
            operation,
            congress: 118,
            reportType: operation === 'list' ? undefined : 'hrpt',
            reportNumber: operation === 'list' ? undefined : 301,
            ...window,
          });
          await expect(committeeReportsTool.handler(input, ctx)).rejects.toMatchObject({
            code: JsonRpcErrorCode.ValidationError,
          });
        }
        expect(mockApi.listCommitteeReports).not.toHaveBeenCalled();
        expect(mockApi.getCommitteeReport).not.toHaveBeenCalled();
        expect(mockApi.getCommitteeReportText).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['get', { conference: false }, "'get' does not use conference, so it was ignored."],
      [
        'text',
        { fromDateTime: FROM, conference: true },
        "'text' does not use fromDateTime or conference, so they were ignored.",
      ],
    ] as const)(
      "serves '%s' with list-only filters and names them on both surfaces",
      async (operation, filters, notice) => {
        mockApi.getCommitteeReport.mockResolvedValue({
          reports: [{ title: 'Conference report' }],
        });
        mockApi.getCommitteeReportText.mockResolvedValue({
          text: [{ formats: [{ type: 'Formatted Text', url: 'https://www.congress.gov/x.htm' }] }],
        });
        const result = await runToolContract(committeeReportsTool, {
          operation,
          congress: 118,
          reportType: 'hrpt',
          reportNumber: 301,
          ...filters,
        });
        expect(result.isError).not.toBe(true);
        const call = { congress: 118, reportType: 'hrpt', reportNumber: 301 };
        if (operation === 'get') {
          expect(mockApi.getCommitteeReport).toHaveBeenCalledWith(call, expect.anything());
        } else {
          expect(mockApi.getCommitteeReportText).toHaveBeenCalledWith(call, expect.anything());
        }
        expect(result.structuredContent).toMatchObject({ notice });
        expect(contentText(result)).toContain(notice);
      },
    );

    it('says a filtered list that matched nothing may be narrowed by any filter', async () => {
      mockApi.listCommitteeReports.mockResolvedValue({
        data: [],
        pagination: { count: 0, nextOffset: null },
      });
      const ctx = createMockContext({ errors: committeeReportsTool.errors });
      await committeeReportsTool.handler(
        committeeReportsTool.input.parse({ operation: 'list', congress: 117, conference: true }),
        ctx,
      );
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('No committee reports found');
      expect(notice).toContain('conference');
      expect(notice).toContain('fromDateTime');
    });
  });
});

/**
 * @fileoverview Input normalization and explicit-operation contracts across Congress.gov tools.
 * @module tests/mcp-server/tools/definitions/operation-input.contract
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract as runTypedToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({ getCongressApi: vi.fn() }));
vi.mock('@/services/senate-lis/senate-vote-service.js', () => ({ getSenateVoteService: vi.fn() }));

import { billLookupTool } from '@/mcp-server/tools/definitions/bill-lookup.tool.js';
import { committeeReportsTool } from '@/mcp-server/tools/definitions/committee-reports.tool.js';
import { crsReportsTool } from '@/mcp-server/tools/definitions/crs-reports.tool.js';
import { dailyRecordTool } from '@/mcp-server/tools/definitions/daily-record.tool.js';
import { rollVotesTool } from '@/mcp-server/tools/definitions/roll-votes.tool.js';
import { senateNominationsTool } from '@/mcp-server/tools/definitions/senate-nominations.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import { getSenateVoteService } from '@/services/senate-lis/senate-vote-service.js';

const emptyPage = { data: [], pagination: { count: 0, nextOffset: null } };
const api = {
  listBills: vi.fn(),
  getBill: vi.fn(),
  getBillSubResource: vi.fn(),
  listVotes: vi.fn(),
  getVote: vi.fn(),
  listNominations: vi.fn(),
  getNomination: vi.fn(),
  listCrsReports: vi.fn(),
  getCrsReport: vi.fn(),
  listCommitteeReports: vi.fn(),
  getCommitteeReport: vi.fn(),
  listDailyRecord: vi.fn(),
  getDailyIssues: vi.fn(),
};

beforeEach(() => {
  vi.resetAllMocks();
  for (const mock of Object.values(api)) mock.mockResolvedValue(emptyPage);
  api.getBill.mockResolvedValue({ bill: { title: 'Test bill', number: '27', type: 'HR' } });
  api.getCrsReport.mockResolvedValue({ report: { id: 'IF13328', title: 'Test CRS report' } });
  api.getCommitteeReport.mockResolvedValue({ report: { title: 'Test committee report' } });
  api.getNomination.mockResolvedValue({ nomination: { number: '1000' } });
  api.getVote.mockResolvedValue({ vote: { rollCallNumber: 1 } });
  vi.mocked(getCongressApi).mockReturnValue(api as never);
  vi.mocked(getSenateVoteService).mockReturnValue(api as never);
});

/** Raw caller arguments deliberately include undeclared alias and invalid keys. */
function runToolContract(
  definition: Parameters<typeof runTypedToolContract>[0],
  input: Record<string, unknown>,
) {
  return runTypedToolContract(definition, input);
}

function rendered(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

describe('existing operation behavior', () => {
  it('retains bill detail with pagination and content defaults', async () => {
    const result = await runToolContract(billLookupTool, {
      operation: 'get',
      congress: 119,
      billType: 'hr',
      billNumber: '27',
      limit: 2,
      offset: 9,
    });
    expect(result.isError).not.toBe(true);
    expect(api.getBill).toHaveBeenCalledWith(
      { congress: 119, billType: 'hr', billNumber: 27 },
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({ bill: { title: 'Test bill' } });
    expect(rendered(result)).toContain('Test bill');
  });

  it('keeps canonical CRS case folding and numeric-to-string repair', async () => {
    const result = await runToolContract(crsReportsTool, {
      operation: 'get',
      report_number: 40097,
    });
    expect(result.isError).not.toBe(true);
    expect(api.getCrsReport).toHaveBeenCalledWith({ reportNumber: '40097' }, expect.anything());
    expect(rendered(result)).toContain('Test CRS report');
  });

  it('keeps blank optional string identities unset on list', async () => {
    const page = {
      data: [{ title: 'Browse row' }],
      pagination: { count: 3, nextOffset: 1 },
    };
    api.listCrsReports.mockResolvedValue(page);
    api.listNominations.mockResolvedValue(page);
    for (const reportNumber of ['', '   ']) {
      const result = await runToolContract(crsReportsTool, { operation: 'list', reportNumber });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject(page);
      expect(rendered(result)).toContain('Browse row');
    }
    for (const nominationNumber of ['', '   ']) {
      const result = await runToolContract(senateNominationsTool, {
        operation: 'list',
        congress: 119,
        nominationNumber,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject(page);
      expect(rendered(result)).toContain('Browse row');
    }
  });

  it('keeps declared bill schema enum, optionality, bounds, and defaults', () => {
    const schema = z.toJSONSchema(billLookupTool.input, { io: 'input' });
    expect(schema.properties?.operation).toMatchObject({
      enum: [
        'list',
        'get',
        'actions',
        'amendments',
        'cosponsors',
        'committees',
        'subjects',
        'summaries',
        'text',
        'titles',
        'related',
        'content',
      ],
      description: 'Which data to retrieve.',
    });
    expect(schema.properties?.billType).toMatchObject({
      enum: ['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres', 'hres', 'sres'],
      description: 'Bill type code. Required for get and sub-resource operations.',
    });
    expect(schema.required).toEqual(['operation', 'congress']);
    expect(schema.properties?.limit).toMatchObject({ default: 20, minimum: 1, maximum: 250 });
    expect(schema.properties).not.toHaveProperty('type');
    expect(schema.properties).not.toHaveProperty('number');
  });
});

describe('explicit list operations', () => {
  const cases = [
    [
      billLookupTool,
      { operation: 'list', congress: 119, billNumber: '999999' },
      'billNumber',
      'get',
    ],
    [
      rollVotesTool,
      { operation: 'list', congress: 119, session: 1, voteNumber: 9999 },
      'voteNumber',
      'get',
    ],
    [
      rollVotesTool,
      { operation: 'list', chamber: 'senate', congress: 119, session: 1, voteNumber: 9999 },
      'voteNumber',
      'get',
    ],
    [
      senateNominationsTool,
      { operation: 'list', congress: 119, nominationNumber: '9999' },
      'nominationNumber',
      'get',
    ],
    [crsReportsTool, { operation: 'list', reportNumber: 'R40097' }, 'reportNumber', 'get'],
    [
      committeeReportsTool,
      { operation: 'list', congress: 119, reportType: 'hrpt', reportNumber: 106 },
      'reportNumber',
      'get',
    ],
    [dailyRecordTool, { operation: 'list', volumeNumber: '172' }, 'volumeNumber', 'issues'],
  ] as const;

  for (const [definition, input, field, compatibleOperation] of cases) {
    it(`${definition.name} rejects ${field} on list (${JSON.stringify(input)})`, async () => {
      const result = await runToolContract(definition, input);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'incompatible_identity',
            field,
            operation: 'list',
            retryable: false,
            recovery: { hint: expect.stringContaining('Remove') },
          },
        },
      });
      expect(rendered(result)).toContain(field);
      expect(rendered(result)).toContain(compatibleOperation);
      expect(Object.values(api).every((mock) => mock.mock.calls.length === 0)).toBe(true);
    });
  }
});

describe('Congress.gov identifier aliases', () => {
  it.each(['relatedbills', 'RELATEDBILLS', 'RelatedBills'])(
    'normalizes bill keys and %s without changing the explicit operation',
    async (operation) => {
      const result = await runToolContract(billLookupTool, {
        operation,
        congress: 119,
        type: 'HR',
        number: '27',
      });
      expect(result.isError).not.toBe(true);
      expect(api.getBillSubResource).toHaveBeenCalledWith(
        expect.objectContaining({ billType: 'hr', billNumber: 27, subResource: 'relatedbills' }),
        expect.anything(),
      );
      expect(result.structuredContent).toMatchObject(emptyPage);
      expect(rendered(result)).toContain('No matching results');
    },
  );

  it.each(['id', 'reportId', 'report_id'])('normalizes CRS %s', async (alias) => {
    const result = await runToolContract(crsReportsTool, { operation: 'get', [alias]: 'IF13328' });
    expect(result.isError).not.toBe(true);
    expect(api.getCrsReport).toHaveBeenCalledWith({ reportNumber: 'IF13328' }, expect.anything());
    expect(result.structuredContent).toMatchObject({ report: { id: 'IF13328' } });
    expect(rendered(result)).toContain('IF13328');
  });

  it.each(['HR', 'hr', 'Hr', 'hR', 'SRES', 'sReS'])('accepts bill type %s', async (billType) => {
    const result = await runToolContract(billLookupTool, {
      operation: 'get',
      congress: 119,
      billType,
      billNumber: 27,
    });
    expect(result.isError).not.toBe(true);
    expect(api.getBill).toHaveBeenCalledWith(
      { congress: 119, billType: billType.toLowerCase(), billNumber: 27 },
      expect.anything(),
    );
    expect(rendered(result)).toContain('Test bill');
  });

  it('keeps bill_type and bill_number aliases', async () => {
    const result = await runToolContract(billLookupTool, {
      operation: 'get',
      congress: 119,
      bill_type: 'HR',
      bill_number: '27',
    });
    expect(result.isError).not.toBe(true);
    expect(api.getBill).toHaveBeenCalledWith(
      { congress: 119, billType: 'hr', billNumber: 27 },
      expect.anything(),
    );
  });

  it.each([
    { operation: 'get', congress: 119, billType: 'hr', type: 's', billNumber: 27 },
    { operation: 'get', congress: 119, billType: 'hr', billNumber: 27, number: 28 },
    { operation: 'relatedbills', congress: 119, type: 'not-a-type', number: 27 },
    { operation: 'not-an-operation', congress: 119, type: 'hr', number: 27 },
    { congress: 119, type: 'hr', number: 27 },
  ])('rejects invalid or colliding bill inputs %j', async (input) => {
    const result = await runToolContract(billLookupTool, input);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(api.getBill).not.toHaveBeenCalled();
    expect(api.getBillSubResource).not.toHaveBeenCalled();
  });

  it.each([
    { operation: 'get', reportNumber: 'IF13328', id: 'R40097' },
    { operation: 'get', id: 'IF13328', reportId: 'R40097' },
    { operation: 'get', reportId: 'IF13328', report_id: 'R40097' },
    { operation: 'get', reportNumber: 'IF13328', unexpected: 'R40097' },
  ])('rejects colliding or unknown CRS keys %j', async (input) => {
    const result = await runToolContract(crsReportsTool, input);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(api.getCrsReport).not.toHaveBeenCalled();
  });

  it.each(['id', 'reportId', 'report_id'])('repairs numeric CRS %s', async (alias) => {
    const result = await runToolContract(crsReportsTool, { operation: 'get', [alias]: 40097 });
    expect(result.isError).not.toBe(true);
    expect(api.getCrsReport).toHaveBeenCalledWith({ reportNumber: '40097' }, expect.anything());
  });

  it('checks bill alias identity against the explicit list operation', async () => {
    const result = await runToolContract(billLookupTool, {
      operation: 'list',
      congress: 119,
      type: 'HR',
      number: '27',
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'incompatible_identity', field: 'billNumber' },
      },
    });
    expect(api.listBills).not.toHaveBeenCalled();
    expect(api.getBill).not.toHaveBeenCalled();
  });

  it.each(['id', 'reportId', 'report_id'])(
    'checks CRS %s against the explicit list operation',
    async (alias) => {
      const result = await runToolContract(crsReportsTool, {
        operation: 'list',
        [alias]: 'IF13328',
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'incompatible_identity', field: 'reportNumber' },
        },
      });
      expect(api.listCrsReports).not.toHaveBeenCalled();
      expect(api.getCrsReport).not.toHaveBeenCalled();
    },
  );
});

describe('allowed browse and detail inputs', () => {
  it('preserves bill and committee report browse filters', async () => {
    expect(
      (
        await runToolContract(billLookupTool, {
          operation: 'list',
          congress: 119,
          type: 'HR',
          limit: 250,
          offset: 250,
        })
      ).isError,
    ).not.toBe(true);
    expect(api.listBills).toHaveBeenCalledWith(
      expect.objectContaining({ billType: 'hr', limit: 250, offset: 250 }),
      expect.anything(),
    );
    expect(
      (
        await runToolContract(committeeReportsTool, {
          operation: 'list',
          congress: 119,
          reportType: 'hrpt',
        })
      ).isError,
    ).not.toBe(true);
    expect(api.listCommitteeReports).toHaveBeenCalledWith(
      expect.objectContaining({ reportType: 'hrpt' }),
      expect.anything(),
    );
  });

  it('keeps detail operations with harmless pagination and selectors', async () => {
    const calls = [
      [
        rollVotesTool,
        { operation: 'get', congress: 119, session: 1, voteNumber: 1, limit: 2, offset: 9 },
        { vote: { rollCallNumber: 1 } },
      ],
      [
        senateNominationsTool,
        { operation: 'get', congress: 119, nominationNumber: '1000', limit: 2, offset: 9 },
        { nomination: { number: '1000' } },
      ],
      [
        crsReportsTool,
        { operation: 'get', reportNumber: 'IF13328', limit: 2, offset: 9 },
        { report: { id: 'IF13328', title: 'Test CRS report' } },
      ],
      [
        committeeReportsTool,
        {
          operation: 'get',
          congress: 119,
          reportType: 'hrpt',
          reportNumber: 1,
          limit: 2,
          offset: 9,
        },
        { report: { title: 'Test committee report' } },
      ],
      [
        dailyRecordTool,
        { operation: 'issues', volumeNumber: '172', limit: 2, offset: 9 },
        emptyPage,
      ],
    ] as const;
    for (const [definition, input, expected] of calls) {
      const result = await runToolContract(definition, input);
      expect(result.isError, definition.name).not.toBe(true);
      expect(result.structuredContent, definition.name).toMatchObject(expected);
    }
    expect(api.getDailyIssues).toHaveBeenCalledWith(
      { volumeNumber: 172, limit: 2, offset: 9 },
      expect.anything(),
    );
  });
});
